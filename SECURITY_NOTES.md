# gIVEMEEDU — Security Notes (Sprint 1.5)

## Tenancy Model

**How it works:**
All EDU API requests authenticate via Supabase JWT. The backend resolves the caller's school and role from `edu_school_memberships` on every request — the client never supplies `school_id`. All database queries include a `WHERE school_id = $N` constraint derived from the server-side session, not from request parameters.

**Why the backend, not RLS:**
The pg Pool connects with the Supabase service role key, which bypasses Row Level Security. RLS policies are defined in `018_edu_core.sql` as defense-in-depth only — they protect against direct database access or Supabase client-side queries, but the primary tenancy enforcement is in `lib/edu-routes.js` via SQL WHERE clauses.

**Cross-school isolation guarantees (Sprint 1.5):**
- `class_id`, `subject_id`, `grade_item_id` supplied by clients are all JOIN-verified against the authenticated user's `school_id` before any data is returned or written.
- A user in School A cannot read or write data belonging to School B, even if they guess the UUIDs.

---

## Role Model (Sprint 1)

Active roles: `admin`, `teacher`, `student`

| Role    | Can do |
|---------|--------|
| admin   | Full school management: classes, members, subjects, grades, attendance |
| teacher | View and record grades/attendance for assigned classes only |
| student | Read-only: own grades, own attendance, enrolled classes only |

**Parent role: DEFERRED to Sprint 2.**
Reason: a parent role without an explicit `edu_parent_student_links` table creates no enforceable scope. There is no safe way to determine which student records a parent is authorized to see without that relationship table. The database CHECK constraint in migration 018 allows only `admin`, `teacher`, `student`. Migration 019 is fully commented out.

---

## Rate Limiting

In-memory sliding window rate limiting is applied to all sensitive write endpoints:

| Endpoint | Limit |
|---|---|
| `GET /users/by-email` | 30 lookups / 10 min per user |
| `POST /members` | 20 requests / 15 min per user |
| `PATCH /members/:id` | 30 requests / 15 min per user |
| `DELETE /members/:id` | 20 requests / 15 min per user |
| `POST /gradebook/items` | 60 requests / 10 min per user |
| `POST /gradebook/entries` | 200 entries / 5 min per user |
| `POST /attendance` | 100 records / 10 min per user |

**Important limitation:** Rate limiting is per-instance. On Vercel Fluid Compute, each cold start creates a new counter. This provides burst protection within a session but does not guarantee global rate enforcement across concurrent instances. For production at scale, a Redis-backed rate limiter would be required.

---

## Audit Log

All write operations on educational records are logged to `edu_audit_log` with:
- `user_id` — who performed the action
- `school_id` — which school the data belongs to
- `action` — action type (e.g. `grade_entry_update`, `member_role_change`)
- `entity` — table name
- `entity_id` — UUID of the affected row
- `old_data` — JSONB snapshot of the row before change (for updates)
- `new_data` — JSONB snapshot after change
- `ip_address` — caller IP
- `created_at` — timestamp

Audit log failures are non-fatal: they log to console but do not block the write operation. This is intentional to prevent audit log downtime from disrupting classroom use. In production, audit failures should trigger an alert.

Migration `021_audit_append_only.sql` adds a `BEFORE UPDATE OR DELETE` trigger
that raises an exception for every caller, including the service role. This is
the existing append-only control for stored audit rows; release verification
must confirm migration `021` and trigger `edu_audit_log_immutable` are present
in each external Supabase environment. A database owner can still deliberately
drop or disable the trigger, so database-owner access remains privileged.

Assessment RLS was published in immutable migration
`029_assessment_security.sql`. The class/school scope helper and replacement
attempt policies are an additive follow-up in
`031_assessment_scope_security.sql`; deployed `029` files must not be edited
because environments may already track their SHA-256 checksum. The `031`
helper is `SECURITY DEFINER` with an empty `search_path`, reads `auth.uid()`
internally, and qualifies referenced public objects. Migration
`032_assessment_scope_evidence.sql` adds immutable, database-stamped membership
and enrollment scope evidence to assessment attempts, hardens its insert/update
path, and supports reporting from that historical evidence instead of mutable
current membership.

Email lookups via `GET /users/by-email` are also audit-logged (searched email + found/not-found result).

---

## User Enumeration

`GET /users/by-email` is restricted to admin role and rate limited.
The response on success returns only `{ id, display_name }` — the caller's email input is not echoed back, and `avatar_url` is not included.
The 404 response on not-found is structurally identical to the success path in timing terms (no early-return short-circuit before the DB query).

---

## Compliance Items (External — Not Solved by Code)

The following are organizational/legal requirements that code alone cannot satisfy:

1. **Data Processing Agreement (DPA):** The school (data controller) must sign a DPA with the platform operator (data processor) before going live. This is a legal document, not a code artifact.

2. **Data Retention Policy:** The platform uses soft-delete (`archived_at`) for grades and attendance. Actual data purging after the retention period must be triggered by the school's admin (GDPR Art. 17 right to erasure). An automated purge job is a Sprint 2+ item.

3. **Incident Notification:** GDPR Art. 33 requires notification to supervisory authority within 72 hours of a data breach. This requires a documented incident response procedure — not handled in code.

4. **Data Minimization Review:** Before production, review what fields are stored in `profiles` and `edu_grade_entries.note`. Notes on student records are personal data and require a lawful basis.

5. **Cookie/Consent Banner:** The frontend uses Supabase session tokens stored in localStorage. If the platform is deployed in the EU, a consent mechanism may be required under ePrivacy Directive, depending on whether these are classified as strictly necessary.

---

## Known Remaining Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Rate limiter is per-instance (not global) | Medium | Acceptable for current scale; upgrade to Redis in Sprint 2 |
| Append-only audit protection depends on migration `021` being applied and its trigger remaining enabled | Medium | Verify `edu_audit_log_immutable` after migration/deploy; restrict database-owner access and alert on trigger changes |
| No CSRF protection on API routes | Low | All routes require `Authorization: Bearer` header; CSRF does not apply to token-auth APIs |
| `profiles.email` column assumed — may not exist | Low | Verify column exists in your Supabase instance before using `/users/by-email` |
| No per-field encryption on grade data | Low | Grades are stored as plain text; field-level encryption is out of scope for Sprint 1 |
| Long-lived Supabase sessions | Low | Session expiry is controlled by Supabase auth settings, not the EDU backend |

---

## Deployment credentials and billing handoff

Stripe Checkout uses server-only credentials and a signed webhook at
`POST /api/billing/stripe-webhook`. The deployment must provide the complete
configuration documented in [`docs/BILLING_MVP.md`](docs/BILLING_MVP.md); the
Stripe secret key and webhook signing secret must never reach browser code,
commits, tickets, or logs.

Only the monthly and yearly Teacher prices are required for self-service
Checkout. `STRIPE_PRICE_SCHOOL_YEARLY` is an optional mapping for a
contact-led, externally provisioned School subscription; there is no
self-service School checkout. Subscription mutation events are reconciled from
the canonical Stripe subscription while holding a per-subscription PostgreSQL
advisory lock before the local transaction mutates billing state.

`VERCEL_KEYS.md` and common local key-dump names are ignored to prevent future
accidental additions. Ignore rules do not affect files already tracked or values
already present in Git history. The repository owner must rotate any committed
credentials and remove them from history through an approved incident-response
process. This documentation change performs neither action and does not contact
external systems.

Before release, run a secret-marker check that reports only the filename and
marker type (for example, a provider-key prefix or a connection-string marker),
never matched values. Treat any positive result outside documented placeholders
or test fixtures as an incident requiring owner action.
