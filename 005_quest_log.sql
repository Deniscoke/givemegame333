-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Quest Log (história vygenerovaných hier per používateľ)
-- Nikdy sa nemazá pri odhlásení — každý má svoj vlastný log
-- Spustite v Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.quest_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quest_log_user ON public.quest_log(user_id);
CREATE INDEX IF NOT EXISTS idx_quest_log_created ON public.quest_log(user_id, created_at DESC);

ALTER TABLE public.quest_log ENABLE ROW LEVEL SECURITY;

-- Používateľ vidí len svoj quest log
CREATE POLICY "Users can view own quest log"
  ON public.quest_log FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own quest log"
  ON public.quest_log FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Žiadne DELETE policy — log sa nemazá (ani pri odhlásení)
GRANT SELECT, INSERT ON public.quest_log TO authenticated;
