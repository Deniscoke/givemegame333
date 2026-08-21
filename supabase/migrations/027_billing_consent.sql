-- ═══════════════════════════════════════════════════════════════════
-- gIVEMEGAME.IO — Billing: consent & version tracking
-- Migration 027
--
-- Účel:
--  Evidovať výslovný súhlas používateľa s okamžitým plnením digitálnej
--  služby podľa § 1837 písm. l) českého občanského zákoníku — teda že
--  sa vzdáva práva na odstúpenie v 14-dennej lehote.
--
--  Zároveň verzujeme ToS / Privacy Policy v momente platby, aby sme pri
--  budúcej zmene mohli preukázať, s akým znením súhlasil.
-- ═══════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'withdrawal_consent_at'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN withdrawal_consent_at    TIMESTAMPTZ,
      ADD COLUMN withdrawal_consent_ip    INET,
      ADD COLUMN withdrawal_consent_text  TEXT,
      ADD COLUMN tos_version              TEXT,
      ADD COLUMN privacy_version          TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.withdrawal_consent_at IS
  'Timestamp kedy používateľ výslovne súhlasil s okamžitým plnením pred koncom 14-dennej lehoty (§ 1837 OZ).';
COMMENT ON COLUMN public.profiles.tos_version IS
  'Verzia Obchodních podmínek (dátum vydania) s ktorou používateľ súhlasil pri poslednom checkoute.';
COMMENT ON COLUMN public.profiles.privacy_version IS
  'Verzia Zásad ochrany osobních údajů platná v momente poslednej platby.';

-- Audit view — pre neskoršie compliance kontroly
CREATE OR REPLACE VIEW public.v_billing_consent_audit AS
SELECT
  id                     AS user_id,
  email,
  withdrawal_consent_at,
  withdrawal_consent_ip,
  tos_version,
  privacy_version
FROM public.profiles
WHERE withdrawal_consent_at IS NOT NULL;

REVOKE ALL ON public.v_billing_consent_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_billing_consent_audit TO service_role;
