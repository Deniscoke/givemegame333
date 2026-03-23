-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Stripe Billing MVP
-- Migration 016
-- Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- 1. User billing state (one row per user, source of truth from webhooks)
CREATE TABLE IF NOT EXISTS public.user_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'none',
  current_period_end TIMESTAMPTZ,
  plan_code TEXT NOT NULL DEFAULT 'free',
  billing_state_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_billing_user ON public.user_billing(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_billing_stripe_customer
  ON public.user_billing(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- 2. Webhook event idempotency (prevents double-processing)
CREATE TABLE IF NOT EXISTS public.billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_stripe_id ON public.billing_events(stripe_event_id);

-- 3. RLS
ALTER TABLE public.user_billing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own billing"
  ON public.user_billing FOR SELECT USING (auth.uid() = user_id);

-- Service/backend only can insert/update (via service role or backend API)
-- Frontend reads only
GRANT SELECT ON public.user_billing TO authenticated;
GRANT SELECT ON public.billing_events TO authenticated;

-- Backend uses service role or direct pool for writes
COMMENT ON TABLE public.user_billing IS 'Billing state per user — updated only from Stripe webhooks';
COMMENT ON TABLE public.billing_events IS 'Stripe webhook event ids for idempotency';
