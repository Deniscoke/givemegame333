-- gIVEMEGAME.IO — História in-app coinov (gIVEMECOIN)
-- Scenár C Hybrid: príprava na coin menu + budúci blockchain claim
-- Spustite v Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS public.coin_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user ON public.coin_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_transactions_created ON public.coin_transactions(created_at DESC);

-- RLS
ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions"
  ON public.coin_transactions FOR SELECT USING (auth.uid() = user_id);

-- Len backend/service môže insertovať (cez service role)
-- Pre frontend: použite Edge Function alebo API endpoint
GRANT SELECT ON public.coin_transactions TO authenticated;

COMMENT ON TABLE public.coin_transactions IS 'História transakcií gIVEMECOIN — robot_challenge, tamagochi_coin, giveme_donation_*, claim_token, bonus';
