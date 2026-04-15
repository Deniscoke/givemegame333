-- gIVEMEGAME.IO — Daily AI generation counters (UTC date) for Free vs Pro enforcement
-- Run in Supabase Dashboard → SQL Editor (or via migration runner)

CREATE TABLE IF NOT EXISTS public.plan_usage_daily (
	user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	usage_date DATE NOT NULL,
	ai_generations INT NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_plan_usage_daily_date ON public.plan_usage_daily(usage_date);

COMMENT ON TABLE public.plan_usage_daily IS 'Per-user UTC-day counter for AI game generations (Free plan cap).';
