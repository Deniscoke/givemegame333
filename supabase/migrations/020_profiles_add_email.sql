-- ═══════════════════════════════════════════════════════════════════
-- Migration 020 — Add email column to public.profiles
--
-- WHY: /api/edu/users/by-email queries public.profiles WHERE email = $1.
-- The profiles table was created in 001 without an email column because
-- Supabase stores email in auth.users only. This migration adds the column,
-- back-fills it from auth.users, and updates the handle_new_user trigger
-- to keep it in sync on every new registration.
--
-- ROLLBACK: ALTER TABLE public.profiles DROP COLUMN IF EXISTS email;
--           (re-run 001's trigger version to restore old behaviour)
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add column (idempotent — IF NOT EXISTS)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;

-- 2. Back-fill from auth.users for all existing rows
UPDATE public.profiles p
SET    email = u.email
FROM   auth.users u
WHERE  p.id = u.id
  AND  p.email IS NULL;

-- 3. Optional index — speeds up /users/by-email lookups (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_profiles_email_lower
  ON public.profiles (LOWER(email));

-- 4. Replace handle_new_user trigger function to also populate email.
--    Uses SECURITY DEFINER so the function runs with the owner's rights
--    and can read auth.users regardless of the calling role.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
    avatar_url   = COALESCE(EXCLUDED.avatar_url,   profiles.avatar_url),
    email        = COALESCE(EXCLUDED.email,         profiles.email),
    updated_at   = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger is already attached from migration 001 — no need to recreate.
-- If for any reason it was dropped, recreate it:
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- CREATE TRIGGER on_auth_user_created
--   AFTER INSERT ON auth.users
--   FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
