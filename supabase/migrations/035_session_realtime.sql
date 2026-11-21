-- ═══════════════════════════════════════════════════════════════════
-- 035 — Multiplayer session visibility + realtime
--
-- 1. 011 wrote the participant branch of the sessions SELECT policy as
--      EXISTS (SELECT 1 FROM session_participants
--              WHERE session_id = id AND user_id = auth.uid())
--    Inside that subquery the bare `id` resolves to session_participants.id,
--    so it compared a participant row with itself and was never true. Only
--    the host could read a session; joined players got no realtime updates
--    for it. The rewrite names sessions.id explicitly.
--    (session_participants' own policy does not read sessions, so this does
--    not create RLS recursion.)
--
-- 2. public/js/session.js subscribes to postgres_changes on sessions and
--    session_participants, but no migration ever added them to the
--    supabase_realtime publication; on a fresh database (local Docker, a
--    restored backup) realtime never fired and the lobby fell back to
--    polling. Tables are added only if the publication exists and they are
--    not yet members. Realtime respects RLS: players now get session status
--    changes live, while session_participants events still reach only the
--    row's own user, so the host's player list keeps using the 4 s poll.
--    UPDATE payloads may omit the unchanged game_json (TOAST); session.js
--    then fetches the full session from /api/sessions/:code.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Correct participant visibility ---------------------------------
DROP POLICY IF EXISTS "Sessions readable by host or participant" ON public.sessions;
CREATE POLICY "Sessions readable by host or participant"
  ON public.sessions FOR SELECT TO authenticated USING (
    auth.uid() = host_id
    OR EXISTS (
      SELECT 1 FROM public.session_participants sp
      WHERE sp.session_id = sessions.id
        AND sp.user_id = auth.uid()
    )
  );

-- 2. Realtime publication --------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not found; skipping realtime setup';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['sessions', 'session_participants'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
