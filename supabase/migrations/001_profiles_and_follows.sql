-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Profily a sociálna sieť (gIVEME)
-- Spustite v Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- 1. Tabuľka profilov (rozšírenie auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Tabuľka sledovaní (followers/following)
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id != following_id)
);

-- 3. Indexy
CREATE INDEX IF NOT EXISTS idx_follows_follower ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON public.follows(following_id);

-- 4. Trigger: automaticky vytvor profil pri novom používateľovi
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. RLS (Row Level Security)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- Profily: čítanie verejné, úprava len vlastný
CREATE POLICY "Profiles are viewable by everyone"
  ON public.profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Sledovanie: vlastník môže pridávať/mazať svoje follow
CREATE POLICY "Users can view all follows"
  ON public.follows FOR SELECT USING (true);

CREATE POLICY "Users can add own follow"
  ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);

CREATE POLICY "Users can remove own follow"
  ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- 6. Grant pre anon/authenticated
GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.follows TO authenticated;

-- 7. Backfill: existujúci používatelia bez profilu (spustite raz)
INSERT INTO public.profiles (id, display_name, avatar_url)
SELECT id, COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1)), raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (id) DO NOTHING;
