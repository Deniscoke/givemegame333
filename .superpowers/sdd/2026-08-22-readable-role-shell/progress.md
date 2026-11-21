# SDD ledger — plan: docs/superpowers/plans/2026-08-22-readable-role-shell.md

## Pre-flight consistency scan

| Tasks | Shared file/interface | Finding |
|---|---|---|
| 1 ↔ 3 | `tokens.css`, `shell.css`, `shell.js` | Compatible: Task 1 defines primitives and helpers; Task 3 consumes them without redefining the shell. |
| 1 ↔ 4 | shared tokens and generator shell | Compatible: generator overrides remain scoped under `body.generator-shell`. |
| 1 ↔ 5 | shared shell and EDU navigation | Compatible: EDU keeps page-specific data styles while consuming the common type/focus/layout contract. |
| 1 ↔ 7 | shared tokens across public/auth pages | Compatible: Task 7 adopts Task 1 assets and preserves page behavior. |
| 2 ↔ 3 | `/student/` route and role destination | Compatible: Task 2 creates canonical routes before Task 3 supplies their page. |
| 2 ↔ 6 | pending-lobby destination | Compatible: Task 2 preserves `/index.html?lobby=CODE`; Task 6 focuses that existing session flow. |
| 2 ↔ 7 | `public/login.html` | Compatible: Task 2 owns routing behavior; Task 7 changes presentation only. |
| 3 ↔ 6 | student Join destination and Session restore | Compatible: student home delegates to the existing canonical lobby query rather than duplicating join authorization. |
| 4 ↔ 6 | `public/index.html` and session presentation | Compatible: Task 4 owns creation hierarchy; Task 6 owns lobby/play state and scoped hiding. |
| 4 ↔ 7 | typography roles | Compatible: Task 4 handles generator-specific presentation; Task 7 excludes generator internals. |
| 5 ↔ 8 | EDU/assessment/INVOK pages and QA | Compatible: Task 8 validates the unified routes without changing their navigation contract. |
| 1–7 ↔ 8 | tests, docs and deploy | Compatible: Task 8 consumes all task outputs and performs whole-branch verification only. |
| 1 | Own tests vs interfaces | Consistent: UMD export supports Node tests and browser pages; touch/focus requirements match the spec. |
| 2 | Own tests vs interfaces | Consistent: role routing is navigation only and does not replace server/RLS authorization. |
| 3 | Own tests vs implementation | Consistent: one accessible input may render visually as six cells while preserving keyboard/paste usability. |
| 4 | Own tests vs behavior | Consistent: existing IDs and App/Session functions remain stable while markup is reorganized. |
| 5 | Own role lists vs spec | Consistent: educator shell role lists do not replace the separate student-home navigation defined in Task 3. |
| 6 | Own state vs session lifecycle | Consistent: focused mode is presentation state and existing polling/restoration remains authoritative. |
| 7 | Own typography checks vs design | Consistent: pixel exceptions remain limited to brand/badges; public task controls use readable text. |
| 8 | Own deploy scope vs authorization | Consistent: Preview push is authorized; production promotion remains excluded. |

Task 0 Ruling: fix cross-platform migration checksum normalization before UI work — a fresh Windows worktree converts immutable SQL to CRLF and the clean baseline fails even though the Git blob matches the published LF checksum; normalize CRLF to LF only for SHA-256 calculation and add a regression test — if wrong, a database tracker created by a legacy Windows-only raw-byte checksum may need controlled DBA reconciliation.

## Task progress

- [x] Task 0 — cross-platform migration checksum normalization. Commit `aa12c377`; independent review APPROVED; focused tests 32/32 and full suite 544/544.
- [x] Task 1 — shared readable product shell. Commit `930322c9`; independent review APPROVED; focused tests 2/2 and full suite 546/546.
- [x] Task 2 — post-login role routing. Commits `234efff`, `cb44b14`; initial P1 fixed; independent re-review APPROVED; focused EDU tests 125/125.
- [x] Task 3 — student home and join flow. Commits `9ac94a6`, `5d7bceb`; API-shape and submitted-only progress fixes applied; independent re-review APPROVED; relevant tests 96/96.
- [x] Task 4 — generator hierarchy. Commits `319d8dd`, `8498912`; three DOM/CSS P1 regressions fixed; independent re-review APPROVED; full suite 556/556. Desktop + 375 px browser re-smoke deferred explicitly to Task 8 because the browser detached.
- [x] Task 5 — educator navigation. Commits `fbb8647`, `239f40b`, `f3a8ae0`; accessibility/typography/active-route blockers fixed; final independent re-review APPROVED; focused tests 46/46 (full suite 564/564 before isolated final CSS/markup fix).
- [x] Task 6 — focused session/play shell. Commits `4673bd2`, `416a46d`; waiting recovery, mobile cascade, and timer typography fixed; independent re-review APPROVED; full suite 570/570.
- [x] Task 7 — typography cleanup across remaining pages. Commits `a7057e2`, `5e0bd4d`; mobile flow, Slovak copy, 44px links, and keyboard disclosures fixed; independent re-review APPROVED; focused tests 66/66.
- [x] Task 8 — whole-product QA, documentation, push, and Vercel Preview. Commits `eef78f4`, `ad8811b`; independent re-review APPROVED; full suite 583/583; 21-cell responsive matrix complete; `origin/codex/readable-student-shell` pushed; Git-integrated Preview Ready and required routes verified; production alias unchanged.
  - [x] Steps 1, 2 and 4: local automated verification, 21-cell responsive browser matrix, reduced-motion/deep-link checks and state/plan evidence.
  - [x] QA fixes: restored one primary heading on login/generator, removed the embedded gIVEME Supabase global collision and aligned the billing XSS regression with approved Slovak copy.
  - [x] Initial Step 3 review completed: `CHANGES_REQUIRED`, four Important findings and no Critical findings.
  - [x] Review remediation: pending-lobby retention/single-flight login, distinct existing library state, complete session-modal focus lifecycle and 44 × 44 px educator small buttons; focused product-shell suite 38/38.
  - [x] Local verification after remediation: 583/583 tests, modified-script syntax checks and `git diff --check`.
  - [ ] Independent re-review approval plus Steps 5 and 6: GitHub push, Vercel Preview `Ready` smoke and final handoff.
