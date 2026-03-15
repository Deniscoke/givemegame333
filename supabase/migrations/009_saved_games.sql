-- gIVEMEGAME.IO — Knižnica uložených hier (Teacher Game Library)
-- Spustite v Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS public.saved_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'party',
  game_json JSONB NOT NULL,
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_games_user ON public.saved_games(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_games_created ON public.saved_games(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_games_favorite ON public.saved_games(user_id, is_favorite) WHERE is_favorite = true;

-- RLS
ALTER TABLE public.saved_games ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own saved games"
  ON public.saved_games FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own saved games"
  ON public.saved_games FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own saved games"
  ON public.saved_games FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own saved games"
  ON public.saved_games FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_games TO authenticated;

COMMENT ON TABLE public.saved_games IS 'Knižnica uložených hier — každý prihlásený používateľ má vlastnú kolekciu';
