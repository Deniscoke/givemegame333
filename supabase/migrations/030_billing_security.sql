-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Billing security, event ordering, least privilege
-- Migration 030
-- ═══════════════════════════════════════════════════════════════════

-- Stripe does not guarantee webhook delivery order. Keep the timestamp from
-- event.created on both the current state and the audit record.
ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_event_created_at TIMESTAMPTZ;

ALTER TABLE public.billing_events
  ADD COLUMN IF NOT EXISTS stripe_event_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_event_order
  ON public.billing_subscriptions (stripe_subscription_id, stripe_event_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_events_created
  ON public.billing_events (stripe_event_created_at DESC);

-- Repair profiles that may already have been overwritten by an event from one
-- of several subscriptions. Users with subscription history are derived from
-- the highest tier that is currently active/trialing; admin remains immutable.
UPDATE public.profiles AS p
SET tier = resolved.tier,
    updated_at = now()
FROM (
  SELECT
    bs.user_id,
    CASE
      WHEN bool_or(bs.status IN ('active', 'trialing') AND bs.tier = 'school') THEN 'school'
      WHEN bool_or(bs.status IN ('active', 'trialing') AND bs.tier = 'teacher') THEN 'teacher'
      ELSE 'free'
    END AS tier
  FROM public.billing_subscriptions AS bs
  GROUP BY bs.user_id
) AS resolved
WHERE p.id = resolved.user_id
  AND p.tier <> 'admin';

-- Defence in depth: authenticated clients must never assign their own tier or
-- billing/legal-consent state, even if a broad table grant is added later.
CREATE OR REPLACE FUNCTION public.protect_profile_billing_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_role TEXT := COALESCE(auth.role(), '');
BEGIN
  -- Service requests, direct database administration and the auth.users ->
  -- profiles trigger may write protected fields.
  IF request_role = 'service_role'
     OR session_user IN ('postgres', 'supabase_admin')
     OR pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.email IS NOT NULL
       OR NEW.tier IS DISTINCT FROM 'free'
       OR NEW.daily_games_count IS DISTINCT FROM 0
       OR NEW.daily_games_day IS NOT NULL
       OR NEW.withdrawal_consent_at IS NOT NULL
       OR NEW.withdrawal_consent_ip IS NOT NULL
       OR NEW.withdrawal_consent_text IS NOT NULL
       OR NEW.tos_version IS NOT NULL
       OR NEW.privacy_version IS NOT NULL THEN
      RAISE EXCEPTION 'profile billing fields are server-managed'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.email IS DISTINCT FROM OLD.email
       OR NEW.tier IS DISTINCT FROM OLD.tier
       OR NEW.daily_games_count IS DISTINCT FROM OLD.daily_games_count
       OR NEW.daily_games_day IS DISTINCT FROM OLD.daily_games_day
       OR NEW.withdrawal_consent_at IS DISTINCT FROM OLD.withdrawal_consent_at
       OR NEW.withdrawal_consent_ip IS DISTINCT FROM OLD.withdrawal_consent_ip
       OR NEW.withdrawal_consent_text IS DISTINCT FROM OLD.withdrawal_consent_text
       OR NEW.tos_version IS DISTINCT FROM OLD.tos_version
       OR NEW.privacy_version IS DISTINCT FROM OLD.privacy_version THEN
      RAISE EXCEPTION 'profile billing fields are server-managed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_profile_billing_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_profile_billing_fields() TO service_role;

DROP TRIGGER IF EXISTS protect_profile_billing_fields ON public.profiles;
CREATE TRIGGER protect_profile_billing_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_fields();

-- Replace earlier table-wide grants with an explicit public projection. Email,
-- tier, generation counters and every consent field are intentionally absent.
REVOKE ALL ON public.profiles FROM PUBLIC;
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT SELECT (
  id, display_name, avatar_url, bio, created_at, updated_at,
  coins, games_generated, games_exported, smarta_styles,
  narrator_styles, narrator_lang, competency_points, rpg_avatar_id, rpg_xp
) ON public.profiles TO anon, authenticated;

GRANT INSERT (
  id, display_name, avatar_url, bio, created_at, updated_at,
  coins, games_generated, games_exported, smarta_styles,
  narrator_styles, narrator_lang, rpg_avatar_id
) ON public.profiles TO authenticated;

GRANT UPDATE (
  display_name, avatar_url, bio, updated_at, coins,
  games_generated, games_exported, smarta_styles,
  narrator_styles, narrator_lang, rpg_avatar_id
) ON public.profiles TO authenticated;

-- Subscription identifiers, price IDs, consent details and webhook payloads
-- are exposed only through the server's authenticated, shaped responses.
REVOKE ALL ON public.billing_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.billing_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_billing_consent_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.billing_subscriptions TO service_role;
GRANT ALL ON public.billing_events TO service_role;
GRANT SELECT ON public.v_billing_consent_audit TO service_role;
