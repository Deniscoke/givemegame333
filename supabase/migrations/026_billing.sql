-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Billing / Subscription tiers (Stripe)
-- Migration 026
--
-- Tiers:
--  free      — default. Solo hráč alebo žiak bez platiaceho učiteľa.
--  teacher   — platený self-service tier pre individuálneho učiteľa.
--  school    — contact-led tier provisionovaný mimo self-service Checkoutu.
--  admin    — interný (my). Bypassuje všetky gates.
--
-- Efektívny tier sa počíta v runtime:
--   effective_tier(user) = MAX(profile.tier, inherited_tier_from_teacher)
-- Žiak v triede platiaceho učiteľa dostáva teacher-level výhody
-- (level cap zrušený, perky 6+), ale NEMÔŽE sám vytvárať triedy.
-- ═══════════════════════════════════════════════════════════════════

-- 1. profiles.tier column (non-destructive add)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'tier'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'
        CHECK (tier IN ('free','teacher','school','admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_tier ON public.profiles(tier) WHERE tier <> 'free';

-- 2. billing_subscriptions — jedna aktívna per user (source of truth o Stripe stave)
CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  school_id              UUID REFERENCES public.edu_schools(id) ON DELETE SET NULL,
  tier                   TEXT NOT NULL CHECK (tier IN ('teacher','school')),

  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,

  status                 TEXT NOT NULL
    CHECK (status IN ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),

  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN DEFAULT FALSE,
  trial_end              TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_subs_user     ON public.billing_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_subs_school   ON public.billing_subscriptions(school_id) WHERE school_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_subs_customer ON public.billing_subscriptions(stripe_customer_id);

-- 3. billing_events — audit log všetkých webhookov (idempotency + debug)
CREATE TABLE IF NOT EXISTS public.billing_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id    TEXT UNIQUE NOT NULL,
  type               TEXT NOT NULL,
  user_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subscription_id    UUID REFERENCES public.billing_subscriptions(id) ON DELETE SET NULL,
  payload            JSONB NOT NULL,
  processed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration 016 shipped a smaller billing_events table with event_type but
-- without type/user_id/subscription_id/payload. CREATE TABLE IF NOT EXISTS does
-- not reconcile columns on an existing table, so add nullable columns first,
-- preserve and backfill legacy rows, then tighten constraints. This block is
-- intentionally before idx_billing_events_type.
ALTER TABLE public.billing_events
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS subscription_id UUID,
  ADD COLUMN IF NOT EXISTS payload JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'billing_events'
      AND column_name = 'event_type'
  ) THEN
    UPDATE public.billing_events
    SET type = event_type
    WHERE type IS NULL;

    -- New webhook writes use type. Keep the legacy column/data, but do not
    -- require new rows to also populate event_type.
    ALTER TABLE public.billing_events
      ALTER COLUMN event_type DROP NOT NULL;
  END IF;
END $$;

UPDATE public.billing_events
SET payload = '{}'::jsonb
WHERE payload IS NULL;

ALTER TABLE public.billing_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
ALTER TABLE public.billing_events
  ALTER COLUMN type SET NOT NULL;
ALTER TABLE public.billing_events
  ALTER COLUMN payload SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.billing_events'::regclass
      AND conname = 'billing_events_user_id_fkey'
  ) THEN
    ALTER TABLE public.billing_events
      ADD CONSTRAINT billing_events_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.billing_events'::regclass
      AND conname = 'billing_events_subscription_id_fkey'
  ) THEN
    ALTER TABLE public.billing_events
      ADD CONSTRAINT billing_events_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES public.billing_subscriptions(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.billing_events
  VALIDATE CONSTRAINT billing_events_user_id_fkey;
ALTER TABLE public.billing_events
  VALIDATE CONSTRAINT billing_events_subscription_id_fkey;

CREATE INDEX IF NOT EXISTS idx_billing_events_type ON public.billing_events(type, processed_at DESC);

-- 4. profiles.daily_games_generated — counter pre FREE tier limit
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'daily_games_count'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN daily_games_count INT NOT NULL DEFAULT 0,
      ADD COLUMN daily_games_day   DATE;
  END IF;
END $$;

-- 5. RLS
ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events        ENABLE ROW LEVEL SECURITY;

-- Sub: user vidí len svoje
DROP POLICY IF EXISTS "billing subs own read" ON public.billing_subscriptions;
CREATE POLICY "billing subs own read" ON public.billing_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Events: nikto priamo cez RLS (iba service_role cez webhook)
DROP POLICY IF EXISTS "billing events service" ON public.billing_events;
CREATE POLICY "billing events service" ON public.billing_events
  FOR ALL USING (false) WITH CHECK (false);

GRANT SELECT ON public.billing_subscriptions TO authenticated;

-- 6. Helper: efektívny tier (bere ohľad na triedu s platiacim učiteľom)
CREATE OR REPLACE FUNCTION public.effective_tier(p_user UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  own_tier TEXT;
  inherited TEXT;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'effective_tier may only be queried for the authenticated user'
      USING ERRCODE = '42501';
  END IF;

  SELECT tier INTO own_tier FROM public.profiles WHERE id = p_user;
  IF own_tier IS NULL THEN own_tier := 'free'; END IF;
  IF own_tier IN ('admin','school','teacher') THEN
    RETURN own_tier;
  END IF;

  -- žiak v triede platiaceho učiteľa?  (inherit teacher-level unlock)
  SELECT 'teacher' INTO inherited
  FROM public.edu_class_enrollments ce
  JOIN public.edu_teaching_assignments ta ON ta.class_id = ce.class_id
  JOIN public.profiles pt ON pt.id = ta.teacher_id
  WHERE ce.student_id = p_user
    AND pt.tier IN ('teacher','school','admin')
  LIMIT 1;

  RETURN COALESCE(inherited, own_tier);
END $$;

REVOKE ALL ON FUNCTION public.effective_tier(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.effective_tier(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.effective_tier(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.effective_tier IS
  'Vracia efektívny tier user-a: vlastný alebo zdedený z triedy platiaceho učiteľa.';
