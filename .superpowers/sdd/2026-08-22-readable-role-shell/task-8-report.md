# Task 8 report — Whole-product local QA and release evidence

Status: **NEEDS REVIEW** — Steps 1, 2 and 4 are complete. Independent review, GitHub push, Vercel Preview verification and final handoff (Steps 3, 5 and 6) remain intentionally open.

## Automated verification

- Initial `npm test`: 575/576 passed. The sole failure was a stale Czech assertion in the billing XSS regression after Task 7 approved Slovak copy. The production behavior still rendered the hostile string through `textContent`.
- RED/GREEN: `node --test test/integration/billing.test.js` passed 20/20 after aligning only that assertion with the shipped Slovak copy.
- RED/GREEN: the new primary-heading and Supabase-global regressions failed 0/2 before their fixes and passed 2/2 afterward.
- Final `npm test`: **578/578 passed**, 92 suites, zero failed/cancelled/skipped/todo, natural exit in 9.27 s.
- `node --check`: **29/29** required files passed (`server.js`, every `lib/*.js`, `public/ui/*.js`, `public/student/*.js`, `public/edu/js/*.js`, and every JavaScript file modified from `d05dab8`).
- `git diff --check d05dab8..HEAD`: passed after removing pre-existing Markdown trailing whitespace in the changed plan/spec files.
- Expected non-failing output: Node prints its existing `punycode` deprecation warning; local EDU, assessment and institution APIs report disabled when `SUPABASE_DB_URL` is absent.

## QA fixes

1. `public/login.html` and `public/index.html` now expose exactly one semantic primary heading while retaining the same classes, content and visual styling.
2. `public/gIVEME/script.js` uses the private identifier `socialSupabase` instead of a top-level `let supabase`, which conflicted with the Supabase UMD browser global and prevented the embedded social surface from initializing. Mechanical verification found 46 `socialSupabase` references; the only remaining `supabase` tokens are the project URL and the two intentional `window.supabase` reads. The API calls and response handling are unchanged.
3. The billing XSS test now expects the approved Slovak load-error prefix while continuing to prove that hostile HTML is assigned as text.

## Responsive browser matrix

The in-app browser completed all 21 requested cells before its viewport override later became stuck at 1280 px. Each cell recorded the requested/final route, document overflow, visible primary heading, visible navigation landmark/action count, keyboard focus and console errors. The heading/global-collision fixes do not alter layout; a targeted post-fix reload confirmed one `h1` on login/generator and removed the original Supabase syntax error. One bounded viewport reset did not restore exact resizing, so no repeated recovery attempts were made.

Legend: navigation is `visible landmarks / visible link-or-button actions`; focus is the observed outline after keyboard focus.

| Viewport | Requested → final route | Title / visible primary heading | Overflow | Nav | Focus | Console |
|---|---|---|---:|---:|---|---|
| 1440×900 | `/` → `/` | `gIVEMEGAME.IO — AI generátor hier…` / `Vygeneruj hru za 60 sekúnd. Vstúp do hry. Vstúp do levelu.` | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 1440×900 | `/login.html` | `gIVEMEGAME.IO — Prihlásenie` / `Generátor vzdelávacích hier` | 0 px | 0 / 0 | visible, 3 px yellow | 0 |
| 1440×900 | `/student/` | `gIVEME — Domov žiaka` / `Pripoj sa do hry` | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 1440×900 | `/index.html` | `gIVEMEGAME.IO — Generátor vzdělávacích her` / generator welcome heading (observed post-fix as `Yo, ready to play? 🎮` under saved language) | 0 px | 0 / 0 | visible, native 1 px | 0 after fix |
| 1440×900 | `/edu/` → `/` (no auth) | landing title / landing primary heading | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 1440×900 | `/edu/assessments.html` | `INVOK Assessments — gIVEMEGAME.IO` / `INVOK Assessmenty` | 0 px | 2 / 6 | visible, 3 px yellow | 0 |
| 1440×900 | `/institution/` | `INVOK — dopad vzdelávania` / `Čo sa po workshope zmenilo?` | 0 px | 1 / 2 | visible, 3 px cyan | 0 |
| 768×1024 | `/` → `/` | landing title / landing primary heading | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 768×1024 | `/login.html` | login title / `Generátor vzdelávacích hier` | 0 px | 0 / 0 | visible, 3 px yellow | 0 |
| 768×1024 | `/student/` | student title / `Pripoj sa do hry` | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 768×1024 | `/index.html` | generator title / generator welcome heading | 0 px | 0 / 0 | visible, native 1 px | 0 after fix |
| 768×1024 | `/edu/` → `/` (no auth) | landing title / landing primary heading | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 768×1024 | `/edu/assessments.html` | assessment title / `INVOK Assessmenty` | 0 px | 2 / 6 | visible, 3 px yellow | 0 |
| 768×1024 | `/institution/` | institution title / `Čo sa po workshope zmenilo?` | 0 px | 1 / 2 | visible, 3 px cyan | 0 |
| 375×812 | `/` → `/` | landing title / landing primary heading | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 375×812 | `/login.html` | login title / `Generátor vzdelávacích hier` | 0 px | 0 / 0 | visible, 3 px yellow | 0 |
| 375×812 | `/student/` | student title / `Pripoj sa do hry` | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 375×812 | `/index.html` | generator title / generator welcome heading | 0 px | 0 / 0 | visible, native 1 px | 0 after fix |
| 375×812 | `/edu/` → `/` (no auth) | landing title / landing primary heading | 0 px | 1 / 6 | visible, 3 px yellow | 0 |
| 375×812 | `/edu/assessments.html` | assessment title / `INVOK Assessmenty` | 0 px | 2 / 6 | visible, 3 px yellow | 0 |
| 375×812 | `/institution/` | institution title / `Čo sa po workshope zmenilo?` | 0 px | 1 / 2 | visible, 3 px cyan | 0 |

The original matrix consistently reported `SyntaxError: Identifier 'supabase' has already been declared` only from `http://localhost:4173/gIVEME/script.js`; the regression and targeted post-fix browser reload confirmed its removal. A `MutationObserver` target error appeared once during the later broken viewport-override session and did not recur on the bounded retry; it is recorded as a non-reproducible residual observation for independent review.

## Reduced motion and pending lobby

- Local Chromium launched with forced reduced motion reported `matchMedia('(prefers-reduced-motion: reduce)').matches === true`. On the student primary button, computed animation duration was `1e-05s`, iteration count `1`, and transition duration `1e-05s`, confirming the shared motion override. The complete suite also covers the JavaScript guard and confirms the reduced-motion path does not create canvas particles.
- Direct unauthenticated navigation to `/index.html?lobby=ABC123` consumed and removed the query, did not open a join dialog, did not activate `session-focused`, and did not submit a live join. In source, this path stores the valid lobby intent and requires an access token before `_restoreOrJoin`; the pure router regression confirms a pending lobby takes precedence after login. Authenticated restoration was not exercised because no staging credentials were supplied.

## Known external dependencies and release state

- Local QA ran without `SUPABASE_DB_URL`, OpenAI credentials, authenticated school roles, seeded assessment data or a live Stripe checkout. Safe no-auth/failure behavior was exercised; no claim is made about live student/teacher data or payment completion.
- Branch: `codex/readable-student-shell-impl`.
- Release status: **local Preview candidate only**. Nothing was pushed, no Vercel deployment was started, and no production alias was changed. The independent reviewer must approve before Steps 5–6.
- A temporary reduced-motion Chrome profile was created under the operating-system temp directory. Chrome was closed cleanly; automatic deletion was denied by the execution policy, so the directory `C:\Users\Admin\AppData\Local\Temp\codex-givemegame-motion-9237` may remain and is safe to remove manually.

## Scope safeguards

- `AI_CONTEXT_PROMPT.md` and `Avatars/` were not read or modified.
- No push, Vercel deploy, production promotion, email or other external write occurred.
