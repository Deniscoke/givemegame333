-- gIVEMEGAME.IO — Pridanie coinov do profilov
-- Spustite v Supabase Dashboard → SQL Editor

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0;

-- Aktualizuj existujúce profily
UPDATE public.profiles SET coins = COALESCE(coins, 0) WHERE coins IS NULL;
