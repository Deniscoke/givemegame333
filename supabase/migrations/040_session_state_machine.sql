-- ═══════════════════════════════════════════════════════════════════
-- 040 — Session state machine, presence, guests, expiry (Phase 6)
--
-- 1. sessions
--      status adds 'expired' (waiting → active → reflection → completing →
--      completed, or → expired from waiting/active/reflection). Every
--      transition is a compare-and-swap in lib/routes/sessions.js.
--      New columns: last_host_seen_at (host heartbeat, host absence →
--      expiry), expires_at (hard TTL), play_style ('room' | 'online' |
--      'async'), reflection_ends_at (server-set reflection), max_players
--      (host-selectable lobby cap), allow_guests, host_xp_awarded (host
--      reward audit + daily cap), expired_at / expire_reason.
-- 2. session_participants
--      Presence (last_seen_at), leave before start (left_at, never
--      charged at /start), refunds on expiry (refunded_at), and guests:
--      is_guest + nickname + guest_token_hash (sha256 of a random token
--      the server hands out once). Guests have no auth.users row, so
--      user_id becomes nullable; a CHECK keeps every row either a real
--      user or a guest, and guests can never pay (and so never earn).
-- 3. session_events — server-only audit trail of every transition.
--
-- Writes stay server-only (033). Browsers keep SELECT through RLS; a guest
-- row has user_id NULL, so no browser can read a guest's token hash.
-- Expiry + refund runs in the server (interval sweep plus a lazy check on
-- every session request) so it also works on serverless hosts without
-- pg_cron.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- 1. sessions -----------------------------------------------------------
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS last_host_seen_at  TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS play_style         TEXT NOT NULL DEFAULT 'room',
  ADD COLUMN IF NOT EXISTS reflection_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_players        INTEGER,
  ADD COLUMN IF NOT EXISTS allow_guests       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS host_xp_awarded    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expired_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expire_reason      TEXT;

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('waiting', 'active', 'reflection', 'completing', 'completed', 'expired'));

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_play_style_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_play_style_check
  CHECK (play_style IN ('room', 'online', 'async'));

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_max_players_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_max_players_check
  CHECK (max_players IS NULL OR max_players BETWEEN 2 AND 40);

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_host_xp_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_host_xp_check
  CHECK (host_xp_awarded >= 0);

-- Sessions created before 040 get a TTL so the sweep can close (and refund)
-- the ones a host abandoned.
UPDATE public.sessions
   SET expires_at = COALESCE(timer_ends_at, created_at, now()) + INTERVAL '2 hours'
 WHERE expires_at IS NULL
   AND status IN ('waiting', 'active', 'reflection');

CREATE INDEX IF NOT EXISTS idx_sessions_open_expiry
  ON public.sessions (expires_at)
  WHERE status IN ('waiting', 'active', 'reflection');

CREATE INDEX IF NOT EXISTS idx_sessions_host_rewarded
  ON public.sessions (host_id, completed_at)
  WHERE host_xp_awarded > 0;

-- 2. session_participants -----------------------------------------------
ALTER TABLE public.session_participants
  ADD COLUMN IF NOT EXISTS is_guest         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nickname         TEXT,
  ADD COLUMN IF NOT EXISTS guest_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS left_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at     TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ;

ALTER TABLE public.session_participants ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_identity_check;
ALTER TABLE public.session_participants ADD CONSTRAINT session_participants_identity_check
  CHECK (
    (is_guest AND user_id IS NULL AND guest_token_hash IS NOT NULL AND nickname IS NOT NULL)
    OR (NOT is_guest AND user_id IS NOT NULL AND guest_token_hash IS NULL)
  );

-- Guests never pay, so the reward loop (coins_paid > 0) never pays them.
ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_guest_unpaid_check;
ALTER TABLE public.session_participants ADD CONSTRAINT session_participants_guest_unpaid_check
  CHECK (NOT is_guest OR coins_paid = 0);

ALTER TABLE public.session_participants DROP CONSTRAINT IF EXISTS session_participants_nickname_check;
ALTER TABLE public.session_participants ADD CONSTRAINT session_participants_nickname_check
  CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 2 AND 24);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_guest_token
  ON public.session_participants (guest_token_hash)
  WHERE guest_token_hash IS NOT NULL;

-- 3. session_events (server-only audit) ---------------------------------
CREATE TABLE IF NOT EXISTS public.session_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  actor_id    UUID,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('host', 'player', 'guest', 'system')),
  event       TEXT NOT NULL CHECK (char_length(event) BETWEEN 1 AND 40),
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON public.session_events (session_id, created_at);

ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_events FROM PUBLIC;
REVOKE ALL ON public.session_events FROM anon;
REVOKE ALL ON public.session_events FROM authenticated;
