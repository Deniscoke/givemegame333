-- gIVEMEGAME.IO — Pridanie promptu/zadania do postov (čo mám namaľovať)
-- Spustite v Supabase Dashboard → SQL Editor

ALTER TABLE public.giveme_posts
ADD COLUMN IF NOT EXISTS prompt TEXT;

COMMENT ON COLUMN public.giveme_posts.prompt IS 'Zadanie / výzva — čo má používateľ namaľovať (napr. "Namaľuj draka")';
