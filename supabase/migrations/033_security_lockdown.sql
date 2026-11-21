-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Migration 033: Security lockdown (RLS + grants)
--
-- WHY: An audit of migrations 001-032 found several client-facing holes:
--   * anon could read every profile (children's names/photos) because
--     001 created a SELECT USING (true) policy and 030 granted SELECT to anon;
--   * browsers could INSERT/UPDATE sessions and session_participants
--     directly although the server performs every write;
--   * plan_usage_daily (018) never enabled RLS, so the Supabase default
--     table privileges left it readable/writable through PostgREST;
--   * gIVEME image_data accepted arbitrary text;
--   * edu_schools had INSERT WITH CHECK (true) and edu_school_memberships
--     had a self-referencing admin policy (recursion / wrong scoping);
--   * rpg_perk_uses allowed direct client INSERT/UPDATE (server-only flow).
--
-- The Express server talks to Postgres through a privileged pg pool
-- (postgres/service_role), which bypasses RLS; nothing here changes the
-- server's access. Every statement was checked against direct supabase-js
-- usage in public/**/*.js and public/**/*.html before being tightened.
--
-- DELIBERATELY NOT CHANGED:
--   * profiles.coins remains client-updatable (column INSERT/UPDATE grants
--     from 030). public/js/coins.js save() upserts { coins } directly from
--     the browser; revoking it would break coin persistence. Moving coin
--     writes server-side must happen in application code first.
--   * gIVEME posts/likes/comments/donations stay publicly readable (the
--     feed renders for logged-out visitors).
--
-- IDEMPOTENT: DROP POLICY IF EXISTS + CREATE POLICY, REVOKE/GRANT, and
-- constraints guarded by pg_constraint lookups, added NOT VALID so legacy
-- rows never block the migration.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. profiles: no anonymous access, minimal authenticated projection ───
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_authenticated" ON public.profiles;
CREATE POLICY "profiles_select_authenticated" ON public.profiles
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.profiles FROM PUBLIC;
REVOKE ALL ON public.profiles FROM anon;

-- Revoking table-level SELECT also removes every column-level SELECT grant,
-- so the projection below is the complete readable set for authenticated.
-- Columns: what the browser reads (gIVEME feed/profile/search, coins.js,
-- script.js stats) plus the columns PostgREST upserts reference through
-- ON CONFLICT ... EXCLUDED (display_name, avatar_url, updated_at, coins).
-- Never email, tier, billing, consent or generation-counter columns.
REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (
  id, display_name, avatar_url, bio, updated_at,
  coins, games_generated, games_exported
) ON public.profiles TO authenticated;

-- ─── 2. follows: social graph only for signed-in users ───
DROP POLICY IF EXISTS "Users can view all follows" ON public.follows;
DROP POLICY IF EXISTS "follows_select_authenticated" ON public.follows;
CREATE POLICY "follows_select_authenticated" ON public.follows
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.follows FROM PUBLIC;
REVOKE ALL ON public.follows FROM anon;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.follows FROM authenticated;

-- ─── 3. sessions / session_participants: server-only writes ───
-- Browsers only subscribe to realtime changes (SELECT); all inserts and
-- updates go through server.js with the privileged pool.
DROP POLICY IF EXISTS "Host can insert session" ON public.sessions;
DROP POLICY IF EXISTS "Host can update session" ON public.sessions;
DROP POLICY IF EXISTS "Participants insert own row" ON public.session_participants;
DROP POLICY IF EXISTS "Participants update own row" ON public.session_participants;

REVOKE ALL ON public.sessions FROM PUBLIC;
REVOKE ALL ON public.sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.sessions FROM authenticated;
GRANT SELECT ON public.sessions TO authenticated;

REVOKE ALL ON public.session_participants FROM PUBLIC;
REVOKE ALL ON public.session_participants FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.session_participants FROM authenticated;
GRANT SELECT ON public.session_participants TO authenticated;

-- ─── 4. plan_usage_daily: server-only counter table ───
ALTER TABLE public.plan_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_usage_daily FROM PUBLIC;
REVOKE ALL ON public.plan_usage_daily FROM anon, authenticated;
GRANT ALL ON public.plan_usage_daily TO service_role;

-- ─── 5. gIVEME content constraints (NOT VALID: new writes only) ───
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'giveme_posts_image_data_format'
      AND conrelid = 'public.giveme_posts'::regclass
  ) THEN
    ALTER TABLE public.giveme_posts
      ADD CONSTRAINT giveme_posts_image_data_format CHECK (
        image_data IS NULL
        OR (
          char_length(image_data) <= 2000000
          AND image_data ~ '^data:image/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'giveme_posts_caption_length'
      AND conrelid = 'public.giveme_posts'::regclass
  ) THEN
    ALTER TABLE public.giveme_posts
      ADD CONSTRAINT giveme_posts_caption_length
      CHECK (caption IS NULL OR char_length(caption) <= 2000) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'giveme_comments_content_length'
      AND conrelid = 'public.giveme_comments'::regclass
  ) THEN
    ALTER TABLE public.giveme_comments
      ADD CONSTRAINT giveme_comments_content_length
      CHECK (char_length(content) BETWEEN 1 AND 2000) NOT VALID;
  END IF;

  -- The donation trigger credits the recipient without debiting the donor,
  -- so self-donations and huge amounts would mint coins. The UI only
  -- offers 1/5/10 coins on other users' posts.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'giveme_coin_donations_sane'
      AND conrelid = 'public.giveme_coin_donations'::regclass
  ) THEN
    ALTER TABLE public.giveme_coin_donations
      ADD CONSTRAINT giveme_coin_donations_sane
      CHECK (donor_id <> recipient_id AND amount BETWEEN 1 AND 100) NOT VALID;
  END IF;
END $$;

-- Anonymous visitors may read the public feed but never write to it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.giveme_posts, public.giveme_likes,
     public.giveme_comments, public.giveme_coin_donations
  FROM PUBLIC, anon;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON public.giveme_posts, public.giveme_likes,
     public.giveme_comments, public.giveme_coin_donations
  FROM authenticated;

-- ─── 6. edu_*: server-only writes, fix broken policies ───
-- Schools are created by the server; WITH CHECK (true) let any client
-- (including anon via default Supabase privileges) insert a school.
DROP POLICY IF EXISTS "edu_schools_insert" ON public.edu_schools;

-- The 018 admin branch referenced edu_school_memberships from its own
-- policy (infinite recursion) and its unqualified school_id compared the
-- inner row with itself. Members now read only their own memberships;
-- school-wide rosters are served by the API.
DROP POLICY IF EXISTS "edu_sm_select" ON public.edu_school_memberships;
CREATE POLICY "edu_sm_select" ON public.edu_school_memberships
  FOR SELECT TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON
  public.edu_schools, public.edu_school_memberships, public.edu_classes,
  public.edu_class_enrollments, public.edu_subjects,
  public.edu_teaching_assignments, public.edu_grade_items,
  public.edu_grade_entries, public.edu_attendance, public.edu_audit_log
  FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.edu_schools, public.edu_school_memberships, public.edu_classes,
  public.edu_class_enrollments, public.edu_subjects,
  public.edu_teaching_assignments, public.edu_grade_items,
  public.edu_grade_entries, public.edu_attendance, public.edu_audit_log
  FROM authenticated;

-- ─── 7. rpg perks: server validates level and teacher decisions ───
DROP POLICY IF EXISTS "perk uses own insert" ON public.rpg_perk_uses;
DROP POLICY IF EXISTS "perk uses teacher decide" ON public.rpg_perk_uses;
REVOKE ALL ON public.rpg_perk_uses FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.rpg_perk_uses FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.rpg_level_perks FROM PUBLIC, anon, authenticated;

-- ─── 8. Other server-written tables: no client writes ───
REVOKE ALL ON public.coin_transactions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.coin_transactions FROM authenticated;

REVOKE ALL ON public.user_billing FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.user_billing FROM authenticated;

-- quest_log: browser reads and inserts its own rows (script.js); no
-- updates or deletes are ever needed.
REVOKE ALL ON public.quest_log FROM PUBLIC, anon;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.quest_log FROM authenticated;
