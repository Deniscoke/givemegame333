# Readable role-based product shell

**Date:** 2026-08-22  
**Status:** Approved direction; implementation pending  
**Product:** gIVEMEGAME.IO / gIVEMEEDU / INVOK

## Objective

Replace the current collection of visually and structurally inconsistent screens with one readable, role-aware product experience. A student must be able to sign in and join a live game without entering the educator generator. A teacher or administrator must be able to create activities and reach school tools through a stable navigation model.

The design preserves the existing Express, vanilla HTML/CSS/JavaScript, Supabase and Stripe architecture. It reorganizes existing capabilities and creates a small shared presentation layer; it does not introduce a SPA framework or replace backend APIs.

## Evidence from the current product

- `public/style.css` is 5,099 lines and applies Press Start 2P or VT323 throughout the generator, including small controls and status text.
- `public/index.html` exposes modes, all filters, EDU filters, generation actions, session actions, SMARTA, gIVEMEGOCHI, quest log, scoreboard, language controls and roughly ten header actions at the same time.
- After OAuth, `public/login.html` always sends the user to `/choose.html`. The chooser presents product areas rather than the next task and does not use the user's school role.
- The normal student join action is a key-only button below the complete generator form. Deep-linked `?lobby=` entry works, but manual entry is difficult to discover.
- EDU navigation is copied into six HTML files. Assessments and INVOK use separate navigation structures, which causes missing links and drift.
- Landing, generator, login, EDU and INVOK use different font, spacing, color and navigation rules. INVOK is currently the clearest reference because it reserves its display font for short headings and uses readable body/data faces.
- The generator header horizontally overflows on smaller screens and relies on icons or tooltips for important destinations.

## Considered approaches

### 1. Typography-only patch

Replace body fonts and increase sizes without changing navigation or task hierarchy.

This is low risk but insufficient. It improves legibility while leaving students inside the educator generator and retaining competing actions on every screen.

### 2. Role- and task-based shell — selected

Introduce a shared visual system and route users to a home screen organized around their role. Students receive a join-first home. Teachers and administrators receive a create/manage home. Existing capabilities remain available but are progressively disclosed.

This fixes the mental model and readability while reusing the existing backend and page architecture.

### 3. Full SPA rewrite

Replace the multi-page application with a component framework and client router.

This could improve long-term component reuse but creates unnecessary authentication, routing, deployment and regression risk before the information architecture has been validated with users.

## Design direction: pixel brand, readable product

Pixel art remains the visual identity, not the reading font.

### Typography

- **Body and controls:** Atkinson Hyperlegible, with `system-ui` fallback. Base size 16px; long-form text line-height 1.55.
- **Interface emphasis:** Atkinson Hyperlegible 700. Headings use normal sentence casing and a restrained scale.
- **Codes, timers and data:** IBM Plex Mono.
- **Pixel display:** Press Start 2P only for the logo, short product badges and selected celebratory game moments. It is never used for paragraphs, form labels, table cells or text below 10px.

### Color tokens

- `--shell-bg: #0b1020` — deep blue-black canvas.
- `--shell-surface: #121a2f` — navigation and panels.
- `--shell-raised: #18233f` — interactive cards.
- `--shell-text: #f4f7ff` — primary readable text.
- `--shell-muted: #a9b4cc` — secondary text with accessible contrast.
- `--shell-violet: #8b5cf6` — product/teacher accent.
- `--shell-cyan: #22d3ee` — live and join actions.
- `--shell-yellow: #facc15` — progress/reward accent.
- `--shell-danger: #fb7185` and `--shell-success: #4ade80` — state colors.

### Layout and signature

The interface uses calm, rectangular work surfaces with generous spacing. Pixel identity appears through crisp stepped corner accents, small status lights and pixel artwork. The single signature element is the **join portal**: a prominent six-cell code input that visually activates as the student enters a lobby code. Everything around it stays quiet.

## Information architecture

### Public journey

1. `/` remains the marketing page but adopts readable typography and clearer calls to action.
2. `/login.html` remains the authentication page and uses the shared visual system.
3. Successful authentication loads the user's EDU profile when available.
4. Routing decision:
   - active lobby intent always wins and resumes the `?lobby=` flow;
   - school role `student` routes to `/student/`;
   - school role `teacher` or `admin` routes to `/edu/`;
   - users without a school role route to `/app/` or the existing generator with a lightweight purpose choice;
   - if role discovery fails, show an explicit recoverable choice rather than silently redirecting.

Guest access to the existing generator remains possible. Existing URLs keep working through aliases or redirects.

### Student navigation

Desktop destinations:

1. Domov
2. Moje aktivity
3. Pokrok
4. Avatar a odmeny
5. Účet

Mobile exposes Domov, Aktivity, Pokrok and Účet directly. Secondary destinations live under “Viac”. Every destination is labeled; navigation never depends on an unexplained icon.

### Educator navigation

1. Prehľad
2. Vytvoriť aktivitu
3. Knižnica a živé hry
4. Triedy
5. Assessmenty
6. Výsledky INVOK
7. Účet

Attendance, gradebook, members and reward approvals remain available as contextual school-management destinations, grouped under Classes/School rather than competing as unrelated top-level products.

## Student home

The first viewport answers one question: “How do I start?”

```text
┌─────────────────────────────────────────────────────────────┐
│ gIVEMEGAME     Domov  Aktivity  Pokrok        Avatar  Účet │
├─────────────────────────────────────────────────────────────┤
│ Ahoj, Nina.                                              LV │
│                                                             │
│  PRIPOJ SA DO HRY                                           │
│  ┌──┬──┬──┬──┬──┬──┐     [ Pripojiť sa ]                  │
│  │  │  │  │  │  │  │                                      │
│  └──┴──┴──┴──┴──┴──┘     Kód dostaneš od učiteľa.         │
│                                                             │
│  Pokračovať                 Moje aktivity                    │
│  Aktívna lobby / hra        Najbližšie zadania a assessment │
│                                                             │
│  Pokrok tento týždeň        Chcem hrať sám                   │
│  XP, kompetencie, odmeny    Sekundárny vstup do sólo hry    │
└─────────────────────────────────────────────────────────────┘
```

- The code input accepts paste and keyboard entry, automatically uppercases characters and submits only a valid six-character code.
- Existing session errors are translated into clear next actions: invalid code, login required, lobby closed or already started.
- Active session state takes precedence over all other cards.
- Assignment/activity cards use existing data where available. Missing data produces a useful empty state, not fabricated content.
- Solo generation remains visible but visually secondary.

## Educator home and generator

The teacher lands on a short operational overview: recent classes/sessions, next assessment tasks and clear actions to create or manage.

The generator becomes “Vytvoriť aktivitu” and is reorganized into a linear flow:

1. Choose an activity type.
2. Enter audience, duration and short goal.
3. Generate.
4. Review, edit, save or start a live session.

Curriculum area, competency, energy, location and advanced variations move into a collapsed “Pokročilé možnosti” section. SMARTA appears only where contextual suggestions are useful. History and library become destinations instead of permanent sidebars. gIVEMEGOCHI, quests, coins and avatar progress move to the profile/rewards area.

## Focused live-game experience

When a user enters a lobby or a game starts, the product switches to a focused play shell:

- game/session title;
- lobby code and participant state;
- current activity content;
- timer when used;
- one contextual action area;
- reflection at completion.

Generator filters, school administration, SMARTA, tamagochi and unrelated counters are absent during play. The user can safely leave or return to the lobby through labeled controls.

## Shared presentation layer

Implementation introduces:

- `public/ui/tokens.css` for typography, colors, spacing, focus and motion tokens;
- `public/ui/shell.css` for shared navigation, page frames, cards, forms, states and responsive behavior;
- `public/ui/shell.js` for small shared shell behavior such as menus, active destinations and account controls;
- a dedicated student page under `public/student/`;
- reusable navigation generation for EDU/Assessment/INVOK pages to remove copied markup gradually.

Existing page-specific CSS remains temporarily for complex game rendering. New shared styles load after legacy styles and use narrowly scoped shell classes. No global `!important` blanket is allowed.

## Accessibility and responsive rules

- Body text is at least 16px and controls have at least 44px touch targets.
- Visible `:focus-visible` styling is shared across all product surfaces.
- Every page has a skip link, one primary heading and semantic navigation landmarks.
- Color never carries state alone.
- Animation respects `prefers-reduced-motion`.
- Desktop target: 1280–1440px.
- Tablet checks: 768px.
- Mobile checks: 375px and 390px without horizontal page scrolling.
- Mobile navigation contains at most five visible actions.
- Tables become scrollable regions or task-specific cards; text does not shrink to fit.

## Data flow and failure behavior

- Supabase remains the source of authentication and school role data.
- Existing session APIs remain authoritative for join, lobby and game state.
- The shared post-login router never grants access; it only selects a destination. Server authorization and RLS remain unchanged.
- Role/API failure shows a retry action and a safe generic destination.
- Direct lobby links retain the pending-lobby mechanism through authentication.
- Student pages do not expose teacher-only actions, but hiding controls is not treated as authorization.

## Compatibility and rollout

The work ships on a feature branch and Vercel Preview before production. Existing public URLs and backend payloads remain compatible. Implementation proceeds in cohesive slices:

1. Shared readable tokens and shell.
2. Join-first student home and role-aware login destination.
3. Generator hierarchy and labeled navigation cleanup.
4. Unified EDU/Assessment/INVOK navigation.
5. Focused live-game surface and remaining typography cleanup.

Each slice must leave the application runnable. The branch is pushed only after tests pass; Vercel Preview is then smoke-tested before handoff.

## Verification

- Static tests for required landmarks, labeled navigation and font-role constraints.
- Unit tests for post-login destination selection and lobby-intent precedence.
- Existing complete `npm test` suite.
- JavaScript syntax checks and `git diff --check`.
- Browser smoke tests for public, login, student home, generator, EDU and INVOK routes.
- Desktop, tablet and mobile screenshots.
- Keyboard traversal, focus visibility, reduced-motion and horizontal-overflow checks.
- Preview checks against the actual Vercel deployment URL.

## Acceptance criteria

1. A signed-in student can reach a six-character join field immediately without passing through the generator.
2. A teacher/admin reaches educator tasks without choosing between ambiguous product names.
3. Press Start 2P is absent from paragraphs, form controls, tables and navigation labels.
4. Core pages use one shared type/color/spacing system and labeled navigation.
5. The generator's initial view shows the essential creation flow; advanced fields are collapsed.
6. Live play does not display unrelated creation or administration widgets.
7. The app has no horizontal page scroll at 375px, 768px or desktop widths.
8. Existing lobby deep links, auth, generator, EDU, assessment, INVOK and billing behavior remain functional.
9. The complete automated suite passes and the Vercel Preview is `Ready` and smoke-tested.

