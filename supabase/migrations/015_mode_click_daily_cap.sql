-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Mode-click daily cap index
-- Migration 015
-- ═══════════════════════════════════════════════════════════════════

-- Index for fast daily mode_click total query in /api/coins/award-mode-click.
-- The partial index filters on action='mode_click' so only relevant rows are indexed.
-- CURRENT_DATE comparison uses created_at, matching the endpoint query exactly.
CREATE INDEX IF NOT EXISTS idx_coin_tx_mode_click_daily
  ON public.coin_transactions (user_id, created_at)
  WHERE action = 'mode_click';
