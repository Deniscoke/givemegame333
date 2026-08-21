# gIVEMEGAME.IO — Stripe Billing Operations Handoff

The active billing flow is **Stripe Checkout plus a signed Stripe webhook**. The
legacy Payment Link/manual-provisioning endpoint is retired; do not configure or
restore `STRIPE_PAYMENT_LINK_PRO_MONTHLY`.

Checkout creates a subscription only for an authenticated user, records legal
consent before creating the Checkout Session, and uses a client idempotency key.
The webhook endpoint is `POST /api/billing/stripe-webhook`; its raw request body
is verified with Stripe's signing secret before billing state is processed. A
success-page redirect never grants paid access.

## Billing environment variables

Use the placeholder-only template in [`.env.example`](../.env.example). Set real
values only in the local environment file or the deployment provider's encrypted
environment-variable store.

| Variable | Required for | Notes |
|---|---|---|
| `BILLING_SUBSCRIPTIONS_ENABLED` | Checkout and portal | Must be exactly `true` to enable Checkout. |
| `STRIPE_SECRET_KEY` | Checkout, portal, webhook | Server-only Stripe API credential. |
| `STRIPE_WEBHOOK_SECRET` | Webhook | Signing secret for `/api/billing/stripe-webhook`; never send it to a client. |
| `STRIPE_PRICE_TEACHER_MONTHLY` | Checkout and webhook | Distinct recurring Price ID for `teacher_monthly`. |
| `STRIPE_PRICE_TEACHER_YEARLY` | Checkout and webhook | Distinct recurring Price ID for `teacher_yearly`. |
| `STRIPE_PRICE_SCHOOL_YEARLY` | Optional webhook mapping | Optional distinct Price ID for externally provisioned/contact-led School subscriptions; never exposed as self-service Checkout. |
| `APP_ORIGIN` | Checkout and portal | Absolute production origin used for return URLs. |
| `BILLING_TOS_VERSION` | Checkout | Version recorded with consent. |
| `BILLING_PRIVACY_VERSION` | Checkout | Version recorded with consent. |
| `BILLING_TERMS_URL` | Checkout/public config | Absolute URL to the current terms. |
| `BILLING_PRIVACY_URL` | Checkout/public config | Absolute URL to the current privacy policy. |
| `BILLING_CONTACT_URL` | Checkout/public config | Absolute consumer-contact URL. |
| `BILLING_WITHDRAWAL_CONSENT_TEXT` | Checkout | Approved text shown before the purchase is started. |
| `BILLING_SUPPORT_EMAIL` | Public billing config | Optional public support address; not a credential. |

The webhook can remain available with its Stripe key, signing secret, and the
two Teacher price IDs even if Checkout is deliberately disabled. Checkout and
the Customer Portal require the complete required configuration above. The two
Teacher Price IDs must be non-empty and different. If the optional School
mapping is configured, it must be valid and distinct from both Teacher prices.
School sales remain contact-led and are provisioned outside self-service
Checkout.

For subscription mutation events, the runtime retrieves the canonical Stripe
subscription and serializes reconciliation per subscription with a PostgreSQL
advisory lock before mutating local state. This complements idempotent event
reservation and checksum-tracked database migrations.

## Database migration order

For the current billing and assessment release, apply migrations in this exact
order: `026_billing.sql`, `027_billing_consent.sql`, `028_assessments.sql`,
`029_assessment_security.sql`, `030_billing_security.sql`,
`031_assessment_scope_security.sql`, `032_assessment_scope_evidence.sql`.

Migration `029_assessment_security.sql` is the immutable published assessment
RLS/security migration. Its additive scope hardening lives in `031`; do not edit
the published `029` because existing databases may track its checksum.
Migration `032` then records immutable, database-stamped assessment-attempt
scope evidence, hardens inserts/updates, and makes reporting rely on that
evidence rather than mutable current membership.
There is no `029_institutions.sql`; the institution dashboard uses the existing
EDU and assessment schema and does not introduce an institutions migration.

The migration directory has historical numbering anomalies: two files begin with
`018`, the unsafe parent-role file `019_edu_add_parent_role.sql.DISABLED` is not
active, and no file begins with `023`. Do **not** rename already shipped
migrations. The supported runner records a successfully committed migration by
full filename and SHA-256 checksum in `public.givemegame_schema_migrations`.
Checksum mismatches and partial failures stop the run without being marked.

List and preview the release without opening a database connection:

```powershell
npm run db:migrate:list
npm run db:migrate:release:dry-run
```

Then point `SUPABASE_DB_URL` at staging. A fresh empty database may run
`npm run db:migrate`; a tracked database may run
`npm run db:migrate -- --from 026`. An existing non-empty schema with an empty
tracker is refused. A non-legacy environment requires a controlled DBA baseline
or manual reconciliation outside this runner; the runner never records a
checksum for a pre-existing migration it did not execute. The only automated
exception is the explicitly verified legacy-016 upgrade documented in
[ENV_SETUP.md](./ENV_SETUP.md). Complete the staging smoke test before using the
same selection in production.

## Deployment checklist

- [ ] Copy `.env.example` to a local secret file and replace placeholders outside Git.
- [ ] In the deployment provider, set every required variable from the table for the intended environment; set `BILLING_SUBSCRIPTIONS_ENABLED=true` only after validation.
- [ ] Create two distinct recurring Teacher prices in Stripe and map them to monthly/yearly Teacher variables. Configure the optional School mapping only for a contact-led provisioned product; do not offer School self-service Checkout.
- [ ] Run the migration list and dry-run, apply `026` through `032` to staging with the correct fresh/tracked/verified-legacy flow, and confirm full filenames/checksums in the tracking table. Escalate an empty tracker over a non-legacy existing schema to the repository owner and DBA for a controlled baseline outside the runner.
- [ ] Complete the staging smoke test before applying the identical selection to production.
- [ ] Configure Stripe to deliver events to `https://<production-domain>/api/billing/stripe-webhook` and store the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
- [ ] Keep the raw-body middleware before JSON parsing for the webhook route.
- [ ] Validate a Checkout flow in Stripe test mode: authenticated checkout, consent, success/cancel URLs, subscription state, portal, and a signed webhook retry.
- [ ] Check that an invalid webhook signature returns HTTP 400 and does not change billing state.
- [ ] Deploy, then verify the public billing config contains no secrets and the legacy upgrade URL remains retired.
- [ ] Run `npm ls stripe` and the billing tests before release.

## Operational limits and ownership

- Stripe Dashboard configuration, deployment environment variables, database
  migrations, and credential rotation are owner-operated external actions. This
  repository change does not perform any of them.
- A controlled baseline or manual reconciliation for an existing non-legacy
  schema with an empty migration tracker is also owner/DBA-operated. There is no
  automated checksum-adoption command in the migration runner.
- Existing committed credential material must be rotated by the repository owner
  and removed from Git history using the owner's approved incident process.
  Adding ignore rules only prevents future accidental additions; it does not
  remove tracked files or history.
- Treat webhook payloads, Stripe customer/subscription IDs, and exported key
  files as sensitive operational data. Do not paste them into issues, commits,
  or logs.
