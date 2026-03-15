-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — gIVEME sociálna sieť (posty, lajky, komentáre, dary)
-- Spustite v Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- 1. Posty (pixel art od používateľov)
CREATE TABLE IF NOT EXISTS public.giveme_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Lajky
CREATE TABLE IF NOT EXISTS public.giveme_likes (
  post_id UUID REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- 3. Komentáre
CREATE TABLE IF NOT EXISTS public.giveme_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Darovanie coinov (donor → recipient cez post)
CREATE TABLE IF NOT EXISTS public.giveme_coin_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  donor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexy
CREATE INDEX IF NOT EXISTS idx_giveme_posts_author ON public.giveme_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_giveme_posts_created ON public.giveme_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_giveme_likes_post ON public.giveme_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_comments_post ON public.giveme_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_donations_post ON public.giveme_coin_donations(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_donations_recipient ON public.giveme_coin_donations(recipient_id);

-- RLS
ALTER TABLE public.giveme_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_coin_donations ENABLE ROW LEVEL SECURITY;

-- Posty: čítanie verejné, vkladanie len prihlásení
CREATE POLICY "Posts are viewable by everyone"
  ON public.giveme_posts FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert posts"
  ON public.giveme_posts FOR INSERT WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Users can delete own posts"
  ON public.giveme_posts FOR DELETE USING (auth.uid() = author_id);

-- Lajky
CREATE POLICY "Likes are viewable by everyone"
  ON public.giveme_likes FOR SELECT USING (true);

CREATE POLICY "Users can add own like"
  ON public.giveme_likes FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove own like"
  ON public.giveme_likes FOR DELETE USING (auth.uid() = user_id);

-- Komentáre
CREATE POLICY "Comments are viewable by everyone"
  ON public.giveme_comments FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert comments"
  ON public.giveme_comments FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own comments"
  ON public.giveme_comments FOR DELETE USING (auth.uid() = user_id);

-- Darovanie coinov
CREATE POLICY "Donations are viewable by everyone"
  ON public.giveme_coin_donations FOR SELECT USING (true);

CREATE POLICY "Users can insert own donation"
  ON public.giveme_coin_donations FOR INSERT WITH CHECK (auth.uid() = donor_id);

-- Trigger: pri darovaní coinov pridaj recipientovi do profiles.coins
CREATE OR REPLACE FUNCTION public.giveme_add_coins_to_recipient()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles SET coins = COALESCE(coins, 0) + NEW.amount, updated_at = now()
  WHERE id = NEW.recipient_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_giveme_donation ON public.giveme_coin_donations;
CREATE TRIGGER on_giveme_donation
  AFTER INSERT ON public.giveme_coin_donations
  FOR EACH ROW EXECUTE FUNCTION public.giveme_add_coins_to_recipient();

-- Grant
GRANT SELECT, INSERT, DELETE ON public.giveme_posts TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.giveme_likes TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.giveme_comments TO anon, authenticated;
GRANT SELECT, INSERT ON public.giveme_coin_donations TO anon, authenticated;
