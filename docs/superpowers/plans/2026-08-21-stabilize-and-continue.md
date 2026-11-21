# gIVEMEGAME Stabilization and Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current Claude-authored billing work into a secure, testable baseline and deliver the INVOK institution dashboard UI.

**Architecture:** Preserve the vanilla HTML/CSS/JS + Express + raw PostgreSQL architecture. Harden subscription state at the database and webhook boundaries, keep billing disabled until explicit legal/runtime configuration is present, restore a clean Node test lifecycle, and build the dashboard as a thin client over the existing institution API.

**Tech Stack:** Node.js 24, Express 4, Node test runner, PostgreSQL/Supabase RLS, Stripe Node SDK, vanilla HTML/CSS/JS, Vercel.

**Spec:** `PROJECT_STATE.md` and the existing uncommitted billing implementation in `lib/billing.js`, `server.js`, `public/pricing.html`, `public/account.html`, and migrations `026`/`027`.

## Global Constraints

- Preserve all pre-existing user/Claude changes and avoid a rewrite.
- Backend remains CommonJS; frontend remains vanilla JS without a build step.
- Every SQL query uses parameters; billing and entitlement state is server-authoritative.
- Stripe signatures must be verified from the raw request body before JSON parsing.
- Webhook handling must be idempotent, reconcile a canonical Stripe subscription, and serialize mutation per subscription before local state changes.
- User-facing billing must fail closed until legal versions, URLs, both required Teacher prices, webhook secret, and an explicit enable flag are configured. School price mapping is optional and contact-led; no School self-service Checkout is offered.
- Supabase clients must not be able to assign their own tier or overwrite billing-consent evidence.
- No secrets may be printed, copied into public files, or added to new documentation.
- Existing public API response shapes remain backward compatible unless a documented security failure requires a change.
- Tests and syntax checks must pass before completion claims.

---

### Task 1: Secure and stabilize subscription billing

**Status: complete.**

**Files:**
- Modify: `lib/billing.js`
- Modify: `server.js`
- Modify: `public/pricing.html`
- Modify: `public/account.html`
- Modify: `supabase/migrations/026_billing.sql`
- Modify: `supabase/migrations/027_billing_consent.sql`
- Create: `supabase/migrations/030_billing_security.sql`
- Modify/Create tests under `test/`

**Interfaces:**
- Consumes: Stripe Checkout metadata, subscription events, `effective_tier(uuid)`, Supabase JWT-authenticated profile writes.
- Produces: fail-closed `billingConfiguration()`, transactional/idempotent webhook processing, canonical Stripe reconciliation with per-subscription serialization, protected profile billing fields.

- [x] Add failing tests for tier recognition, unknown Stripe price rejection, two-price readiness, canonical subscription retrieval/serialization, and preservation of the Free limit of 3 generations/day.
- [x] Remove the stale hard-coded Stripe API override and let the installed SDK use its compatible default API version.
- [x] Require `BILLING_SUBSCRIPTIONS_ENABLED=true`, two distinct Teacher price IDs, `STRIPE_WEBHOOK_SECRET`, `APP_ORIGIN`, legal versions, legal URLs, and withdrawal text before Checkout is available; keep School price mapping optional for contact-led provisioning and exclude School from self-service Checkout.
- [x] Return generic client errors while retaining actionable server logs; never return raw Stripe/database errors to clients.
- [x] Make `priceToTier()` return no tier for unknown prices and make subscription upserts reject unknown prices rather than defaulting to `teacher`.
- [x] Retrieve canonical Stripe subscription state and serialize mutation with a per-subscription PostgreSQL advisory lock; retain event time as an additional monotonic/audit defense rather than the sole authority.
- [x] Process the event reservation, subscription mutation, profile mutation, and audit record in one database transaction.
- [x] Add migration `030_billing_security.sql` with an empty `search_path` security-definer function, protected INSERT/UPDATE behavior for tier/consent fields, safe column grants preventing public reads of email, consent IP/text and billing metadata, and the event-ordering column/index required by the webhook.
- [x] Change `effective_tier()` to use fully qualified objects with `SET search_path = ''` and restrict function execution to the roles that need it.
- [x] Ensure pricing/account UI displays disabled billing with useful configuration/legal links instead of relying on nonexistent `/legal/*` pages.
- [x] Run focused billing and migration static tests.

### Task 2: Restore a reliable test and process lifecycle

**Status: complete.**

**Files:**
- Modify: `package.json`
- Modify: `test/plan-entitlements.test.js`
- Modify: `test/integration/billing.test.js`
- Modify: `test/integration/rate-limit.test.js`
- Modify: `server.js`
- Modify: `lib/edu-routes.js`
- Modify: `lib/assessment-routes.js`

**Interfaces:**
- Consumes: Node's built-in automatic test discovery.
- Produces: `npm test` exits naturally with an accurate pass/fail result and no force-exit masking.

- [x] Update the Free entitlement assertion from 2 to the decided limit of 3.
- [x] Change the test script to supported automatic discovery (`node --test`) with no directory argument.
- [x] Keep timer handles from holding the process open by retaining cleanup timer handles and calling `unref()`.
- [x] Await HTTP server closure in integration hooks.
- [x] Run `npm test` without `--test-force-exit`; it must terminate naturally with zero failures.
- [x] Run `node --check` on `server.js` and every `lib/*.js` file.

### Task 3: Operational and security handoff

**Status: complete.**

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `SECURITY_NOTES.md`
- Modify: `docs/ENV_SETUP.md`
- Modify: `docs/BILLING_MVP.md` or replace its obsolete billing section with a pointer to the current flow.
- Modify: `PROJECT_STATE.md`

**Interfaces:**
- Consumes: the hardened runtime configuration from Task 1.
- Produces: a secret-free deployment checklist and an accurate project state.

- [x] Document every billing environment variable using placeholders only, with two required Teacher self-service prices and an optional contact-led School mapping consistently reflected in ENV guidance and the deployment checklist.
- [x] Retain and commit the already-installed `stripe` runtime dependency required by Task 1, verifying `npm ls stripe` succeeds.
- [x] Add `VERCEL_KEYS.md` and equivalent local key dumps to `.gitignore`; do not delete history or rotate keys automatically.
- [x] Document that already committed credentials must be rotated and removed from Git history by the repository owner.
- [x] Record migration execution order `026`, `027`, `028`, immutable published `029`, `030`, additive `031`, and immutable assessment scope evidence `032`, plus the duplicate-018/missing-023 caveat without renaming shipped migrations; keep the verified legacy-016 bootstrap and require an owner/DBA-controlled baseline outside the runner for any other existing schema with an empty tracker.
- [x] Update the active-work, risks, and decision-log sections in `PROJECT_STATE.md`.
- [x] Run a repository secret-marker check that reports file names/marker types only, never secret values.

### Task 4: Build the INVOK institution dashboard UI

**Status: complete.**

**Files:**
- Create: `docs/superpowers/specs/2026-08-21-institution-dashboard-design.md`
- Create: `public/institution/index.html`
- Create: `public/institution/institution.css`
- Create: `public/institution/institution.js`
- Modify: `server.js`
- Modify: EDU navigation files as needed
- Create: focused frontend/static route tests under `test/institution-dashboard.test.js`

**Interfaces:**
- Consumes: existing `/api/institution/*` endpoints from `lib/institution-routes.js` and Supabase access tokens.
- Produces: `/institution/` dashboard for authorized teachers/admins with school/class filters, summary cards, pre/post delta views, and CSV export.

**Design direction:** Follow `docs/superpowers/specs/2026-08-21-institution-dashboard-design.md` exactly: a calm impact field notebook, restrained pixel identity, Atkinson Hyperlegible body text, IBM Plex Mono data text, and the pre-to-post Impact Trail as the single signature element.

- [x] Inventory the exact seven reporting endpoints and response schemas; encode them in focused client helpers without duplicating server business rules.
- [x] Create an authenticated, mobile-first dashboard shell consistent with `public/edu/` and with keyboard-visible focus, semantic headings, labels, status regions, and touch targets of at least 40px.
- [x] Add school and class filters, loading/empty/error states, summary cards, module-level pre/post improvement table, and CSV export.
- [x] Escape all user-controlled display content or build it with DOM text nodes.
- [x] Add a static route and an EDU navigation entry without breaking existing routes.
- [x] Add tests for route availability, required landmarks, script loading, and endpoint helper behavior.
- [x] Run focused tests and then the complete `npm test` suite.

### Task 5: Final QA and release readiness review

**Status: complete — final review approved and fresh root verification passed.**

**Files:**
- Review all changes from Tasks 1-4.

**Interfaces:**
- Consumes: completed implementation and test evidence.
- Produces: a verified handoff separating local completion from external actions requiring the owner.

- [x] Review security, tenant isolation, Stripe raw-body handling, canonical subscription serialization, XSS, accessibility basics, and documentation accuracy.
- [x] Run the complete test suite, syntax checks, `git diff --check`, and a clean startup/status smoke test without production secrets.
- [x] Record external blockers: secret rotation/history rewrite, Supabase migrations and any controlled DBA baseline/manual reconciliation, Stripe products/prices/webhook/portal/tax configuration, legal text approval, Vercel environment variables, and deployment smoke tests.
