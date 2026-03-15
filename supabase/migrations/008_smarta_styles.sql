-- gIVEMEGAME.IO — Preferencie Smartu (štýly osobnosti) per používateľ
-- Spustite v Supabase Dashboard → SQL Editor

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS smarta_styles JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.profiles.smarta_styles IS 'Pole štýlov Smartu: genz, sangvinik, flegmatik, cholerik, melancholik';
