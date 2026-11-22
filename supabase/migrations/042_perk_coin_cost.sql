-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — level perks cost coins
-- Migration 042
--
-- Real-world perks were free after the level unlock, which made them too
-- easy. Each perk now has a coin price. Outside EDU the price is debited
-- when the perk is used; in an EDU school it is debited when the teacher
-- approves the request (a rejected request costs nothing).
-- rpg_perk_uses.coins_charged records what was actually debited.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.rpg_level_perks
  ADD COLUMN IF NOT EXISTS coin_cost INT NOT NULL DEFAULT 0 CHECK (coin_cost >= 0);

ALTER TABLE public.rpg_perk_uses
  ADD COLUMN IF NOT EXISTS coins_charged INT NOT NULL DEFAULT 0 CHECK (coins_charged >= 0);

UPDATE public.rpg_level_perks AS p
   SET coin_cost = v.cost
  FROM (VALUES
    ('phone_break',     300),
    ('micro_pause',     500),
    ('own_soundtrack',  800),
    ('free_seat',      1200),
    ('skip_task',      1500),
    ('topic_choice',   2000),
    ('second_try',     2500),
    ('late_start',     3000),
    ('mentor_day',     5000)
  ) AS v(perk_key, cost)
 WHERE p.perk_key = v.perk_key
   AND p.coin_cost = 0;  -- re-running keeps prices an admin has changed

COMMENT ON COLUMN public.rpg_level_perks.coin_cost IS
  'Coins debited per use (outside EDU on use, in EDU on teacher approval).';
COMMENT ON COLUMN public.rpg_perk_uses.coins_charged IS
  'Coins actually debited for this claim (0 while pending or when rejected).';
