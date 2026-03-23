-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — VŠETKY MIGRÁCIE V JEDNOM SÚBORE
-- ═══════════════════════════════════════════════════════════════════
--
-- INSTRUKCIE:
-- 1. Otvor Supabase Dashboard → SQL Editor
-- 2. Vytvor New query
-- 3. Skopíruj celý tento súbor a vlož do editora
-- 4. Klikni Run
--
-- Ak dostaneš chybu typu "already exists" — tá migrácia už beží.
-- Môžeš tú časť preskočiť (zmazat ju zo skriptu) alebo nechať behať ďalej.
-- Väčšina príkazov používa IF NOT EXISTS, takže by mali prejsť.
--
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 001 - profiles_and_follows
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.follows (
  follower_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id != following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON public.follows(following_id);

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

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can view all follows" ON public.follows;
CREATE POLICY "Users can view all follows" ON public.follows FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can add own follow" ON public.follows;
CREATE POLICY "Users can add own follow" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);
DROP POLICY IF EXISTS "Users can remove own follow" ON public.follows;
CREATE POLICY "Users can remove own follow" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.follows TO authenticated;

INSERT INTO public.profiles (id, display_name, avatar_url)
SELECT id, COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1)), raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- 002 - add_coins_to_profiles
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0;
UPDATE public.profiles SET coins = COALESCE(coins, 0) WHERE coins IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 003 - giveme_social
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.giveme_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.giveme_likes (
  post_id UUID REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.giveme_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.giveme_coin_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.giveme_posts(id) ON DELETE CASCADE,
  donor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_giveme_posts_author ON public.giveme_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_giveme_posts_created ON public.giveme_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_giveme_likes_post ON public.giveme_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_comments_post ON public.giveme_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_donations_post ON public.giveme_coin_donations(post_id);
CREATE INDEX IF NOT EXISTS idx_giveme_donations_recipient ON public.giveme_coin_donations(recipient_id);

ALTER TABLE public.giveme_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.giveme_coin_donations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Posts are viewable by everyone" ON public.giveme_posts;
CREATE POLICY "Posts are viewable by everyone" ON public.giveme_posts FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated users can insert posts" ON public.giveme_posts;
CREATE POLICY "Authenticated users can insert posts" ON public.giveme_posts FOR INSERT WITH CHECK (auth.uid() = author_id);
DROP POLICY IF EXISTS "Users can delete own posts" ON public.giveme_posts;
CREATE POLICY "Users can delete own posts" ON public.giveme_posts FOR DELETE USING (auth.uid() = author_id);

DROP POLICY IF EXISTS "Likes are viewable by everyone" ON public.giveme_likes;
CREATE POLICY "Likes are viewable by everyone" ON public.giveme_likes FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can add own like" ON public.giveme_likes;
CREATE POLICY "Users can add own like" ON public.giveme_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can remove own like" ON public.giveme_likes;
CREATE POLICY "Users can remove own like" ON public.giveme_likes FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Comments are viewable by everyone" ON public.giveme_comments;
CREATE POLICY "Comments are viewable by everyone" ON public.giveme_comments FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated users can insert comments" ON public.giveme_comments;
CREATE POLICY "Authenticated users can insert comments" ON public.giveme_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own comments" ON public.giveme_comments;
CREATE POLICY "Users can delete own comments" ON public.giveme_comments FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Donations are viewable by everyone" ON public.giveme_coin_donations;
CREATE POLICY "Donations are viewable by everyone" ON public.giveme_coin_donations FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert own donation" ON public.giveme_coin_donations;
CREATE POLICY "Users can insert own donation" ON public.giveme_coin_donations FOR INSERT WITH CHECK (auth.uid() = donor_id);

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

GRANT SELECT, INSERT, DELETE ON public.giveme_posts TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.giveme_likes TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.giveme_comments TO anon, authenticated;
GRANT SELECT, INSERT ON public.giveme_coin_donations TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 004 - add_prompt_to_posts
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.giveme_posts ADD COLUMN IF NOT EXISTS prompt TEXT;

-- ─────────────────────────────────────────────────────────────────
-- 005 - quest_log
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quest_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quest_log_user ON public.quest_log(user_id);
CREATE INDEX IF NOT EXISTS idx_quest_log_created ON public.quest_log(user_id, created_at DESC);

ALTER TABLE public.quest_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own quest log" ON public.quest_log;
CREATE POLICY "Users can view own quest log" ON public.quest_log FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own quest log" ON public.quest_log;
CREATE POLICY "Users can insert own quest log" ON public.quest_log FOR INSERT WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT ON public.quest_log TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 006 - coin_transactions
-- ─────────────────────────────────────────────────────────────────

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

ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own transactions" ON public.coin_transactions;
CREATE POLICY "Users can view own transactions" ON public.coin_transactions FOR SELECT USING (auth.uid() = user_id);

GRANT SELECT ON public.coin_transactions TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 007 - add_scoreboard_to_profiles
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS games_generated INTEGER DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS games_exported INTEGER DEFAULT 0;
UPDATE public.profiles SET games_generated = COALESCE(games_generated, 0) WHERE games_generated IS NULL;
UPDATE public.profiles SET games_exported = COALESCE(games_exported, 0) WHERE games_exported IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 008 - smarta_styles
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS smarta_styles JSONB DEFAULT '[]'::jsonb;

-- ─────────────────────────────────────────────────────────────────
-- 009 - saved_games
-- ─────────────────────────────────────────────────────────────────

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

ALTER TABLE public.saved_games ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own saved games" ON public.saved_games;
CREATE POLICY "Users can view own saved games" ON public.saved_games FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own saved games" ON public.saved_games;
CREATE POLICY "Users can insert own saved games" ON public.saved_games FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own saved games" ON public.saved_games;
CREATE POLICY "Users can update own saved games" ON public.saved_games FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own saved games" ON public.saved_games;
CREATE POLICY "Users can delete own saved games" ON public.saved_games FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_games TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 010 - narrator_preferences
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS narrator_styles TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS narrator_lang   TEXT     DEFAULT 'sk';

-- ─────────────────────────────────────────────────────────────────
-- 011 - sessions_and_progression
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS competency_points JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_json     JSONB NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','active','reflection','completed')),
  timer_ends_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_host   ON public.sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON public.sessions(status);

CREATE TABLE IF NOT EXISTS public.session_participants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  coins_paid           INTEGER NOT NULL DEFAULT 0 CHECK (coins_paid >= 0),
  reflection_data      JSONB,
  reflection_done      BOOLEAN NOT NULL DEFAULT false,
  awarded_competencies JSONB,
  joined_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sp_session ON public.session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_sp_user    ON public.session_participants(user_id);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sessions readable by host or participant" ON public.sessions;
CREATE POLICY "Sessions readable by host or participant" ON public.sessions FOR SELECT USING (
  auth.uid() = host_id OR EXISTS (SELECT 1 FROM public.session_participants WHERE session_id = id AND user_id = auth.uid())
);
DROP POLICY IF EXISTS "Host can insert session" ON public.sessions;
CREATE POLICY "Host can insert session" ON public.sessions FOR INSERT WITH CHECK (auth.uid() = host_id);
DROP POLICY IF EXISTS "Host can update session" ON public.sessions;
CREATE POLICY "Host can update session" ON public.sessions FOR UPDATE USING (auth.uid() = host_id);

DROP POLICY IF EXISTS "Participants view own rows" ON public.session_participants;
CREATE POLICY "Participants view own rows" ON public.session_participants FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Participants insert own row" ON public.session_participants;
CREATE POLICY "Participants insert own row" ON public.session_participants FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Participants update own row" ON public.session_participants;
CREATE POLICY "Participants update own row" ON public.session_participants FOR UPDATE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.session_participants TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 012 - reward_validation
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS reward_validation JSONB;

CREATE INDEX IF NOT EXISTS idx_sessions_host_completed
  ON public.sessions (host_id, completed_at) WHERE status = 'completed';

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('waiting', 'active', 'reflection', 'completing', 'completed'));

CREATE INDEX IF NOT EXISTS idx_coin_tx_solo_cooldown
  ON public.coin_transactions (user_id, created_at) WHERE action = 'solo_complete';

-- ─────────────────────────────────────────────────────────────────
-- 013 - game_feedback
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.saved_games
  ADD COLUMN IF NOT EXISTS rating   SMALLINT CHECK (rating >= 1 AND rating <= 5),
  ADD COLUMN IF NOT EXISTS feedback TEXT     CHECK (char_length(feedback) <= 500);

-- ─────────────────────────────────────────────────────────────────
-- 014 - public_token
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.saved_games ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_games_public_token
  ON public.saved_games(public_token) WHERE public_token IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 015 - mode_click_daily_cap
-- ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_coin_tx_mode_click_daily
  ON public.coin_transactions (user_id, created_at) WHERE action = 'mode_click';

-- ─────────────────────────────────────────────────────────────────
-- 016 - billing (Stripe MVP)
-- ─────────────────────────────────────────────────────────────────

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

CREATE TABLE IF NOT EXISTS public.billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_stripe_id ON public.billing_events(stripe_event_id);

ALTER TABLE public.user_billing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own billing" ON public.user_billing;
CREATE POLICY "Users can view own billing"
  ON public.user_billing FOR SELECT USING (auth.uid() = user_id);

GRANT SELECT ON public.user_billing TO authenticated;
GRANT SELECT ON public.billing_events TO authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- HOTOVO. Ak všetko prebehlo bez chyby, databáza je pripravená.
-- ═══════════════════════════════════════════════════════════════════
