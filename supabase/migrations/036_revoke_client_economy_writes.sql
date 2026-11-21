-- ═══════════════════════════════════════════════════════════════════
-- 036 — Server-authoritative economy (Phase 0, bugs C2 and M6)
--
-- 1. C2: 030 granted column INSERT/UPDATE on profiles.coins and
--    profiles.rpg_avatar_id to authenticated, and 033 kept that on purpose
--    because public/js/coins.js save() upserted { coins } from the browser.
--    coins.js kept whichever balance was higher (localStorage or server) and
--    wrote it back, so any browser could mint coins, buy XP potions and skip
--    the 5000-coin avatar charge. coins.js no longer writes profiles at all;
--    every credit and debit now happens in server.js through the privileged
--    pg pool (which bypasses these grants and RLS).
--
--    A column-level REVOKE does not remove a table-level grant, so the
--    table-level INSERT/UPDATE privilege is revoked first (that also drops
--    every column-level INSERT/UPDATE grant), then the columns the browser
--    still legitimately writes are granted again. Checked against every
--    supabase-js profiles write in public/**:
--      * login.html / public/login.html / script.js / gIVEME/script.js
--        upsert { id, display_name, avatar_url, updated_at } (onConflict id,
--        which needs UPDATE (id) as explained in 033)
--      * script.js stats sync updates { games_generated, games_exported,
--        updated_at }
--      * bio and the narrator / SMARTA preference columns stay writable as
--        before.
--    SELECT grants are unchanged (033), so coins.js can still read coins.
--
-- 2. M6: POST /api/rpg/perks/:key/use checks for a pending claim and then
--    inserts, so two parallel requests could both insert. A partial unique
--    index makes the second insert fail (server.js maps 23505 to 409).
--    Older duplicate pending rows (the race already happened) are resolved
--    first, keeping the newest pending claim, so the index can be built.
--
-- Idempotent: REVOKE/GRANT are repeatable, the index uses IF NOT EXISTS
-- and every perk statement is guarded by a to_regclass check.
-- ═══════════════════════════════════════════════════════════════════

-- 1. profiles: no client writes to coins or rpg_avatar_id --------------
REVOKE INSERT, UPDATE ON public.profiles FROM PUBLIC;
REVOKE INSERT, UPDATE ON public.profiles FROM anon;
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;

GRANT INSERT (
  id, display_name, avatar_url, bio, updated_at,
  games_generated, games_exported,
  narrator_lang, narrator_styles, smarta_styles
) ON public.profiles TO authenticated;

GRANT UPDATE (
  id, display_name, avatar_url, bio, updated_at,
  games_generated, games_exported,
  narrator_lang, narrator_styles, smarta_styles
) ON public.profiles TO authenticated;

-- 2. rpg_perk_uses: at most one pending claim per user and perk --------
DO $$
BEGIN
  IF to_regclass('public.rpg_perk_uses') IS NULL THEN
    RAISE NOTICE '036: public.rpg_perk_uses does not exist, skipping perk index';
    RETURN;
  END IF;

  UPDATE public.rpg_perk_uses pu
     SET status = 'rejected',
         decided_at = now(),
         teacher_note = COALESCE(pu.teacher_note, 'duplicate pending claim closed by migration 036')
   WHERE pu.status = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.rpg_perk_uses newer
        WHERE newer.user_id = pu.user_id
          AND newer.perk_key = pu.perk_key
          AND newer.status = 'pending'
          AND (newer.claimed_at, newer.id) > (pu.claimed_at, pu.id)
     );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_rpg_perk_uses_one_pending
    ON public.rpg_perk_uses (user_id, perk_key)
    WHERE status = 'pending';
END
$$;
