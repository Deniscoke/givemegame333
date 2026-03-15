-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Reward Validation System
-- Migration 012
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add started_at to sessions (set when /start transitions to 'active')
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- 2. Add reward_validation audit trail
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS reward_validation JSONB;

-- 3. Index for host cooldown: "completed sessions in last hour by host"
CREATE INDEX IF NOT EXISTS idx_sessions_host_completed
  ON public.sessions (host_id, completed_at)
  WHERE status = 'completed';

-- 4. Add 'completing' to session status CHECK constraint (atomic lock for /complete race prevention)
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('waiting', 'active', 'reflection', 'completing', 'completed'));

-- 5. Index for solo cooldown: "solo completions in last 24h by user"
CREATE INDEX IF NOT EXISTS idx_coin_tx_solo_cooldown
  ON public.coin_transactions (user_id, created_at)
  WHERE action = 'solo_complete';
