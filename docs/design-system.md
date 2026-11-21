# gIVEMEGAME.IO pixel design system

Phases 2 and 3 of `docs/redesign/PLAN.md`. Everything new is scoped under
`body.px-v2`. Remove that class to fall back to the old look while the
migration is still running.

## Files and load order

`public/index.html` loads these after the legacy `style.css`, `ui/tokens.css`,
`ui/generator-shell.css` and `ui/session-shell.css`, in this order:

| File | What it holds |
|------|---------------|
| `ui/px-tokens.css` | Fonts, the type scale, colours per mode and theme, spacing, hit sizes, plus the bridge to the legacy variables |
| `ui/px-components.css` | Reusable classes: `.px-icon`, `.px-btn`, `.px-iconbtn`, `.px-pill`, `.px-panel`, `.px-card`, `.px-tabs`, `.px-badge`, `.px-modal`, `.px-toast`, `.px-state` |
| `ui/px-motion.css` | The few animations that are allowed, and the global `prefers-reduced-motion` guard |
| `ui/px-type-floor.css` | **Generated.** Raises small legacy text to the minimum sizes |
| `ui/px-apply.css` | Applies the system to the existing screens: header, panels, "Rozšírené možnosti", tool shell, modals and the RPG overlay |
| `ui/px-mode-decor.css` | Decoration that changes with the mode |

Scripts: `js/px-modal.js` (focus trap), `js/mode-decor.js` (decoration
container) and `js/rpg-net.js` (RPG request states).

## Tokens

- **One corner radius:** `--px-radius: 0px`. **One shadow:** `--px-shadow: 4px 4px 0 #000`, a hard offset with no blur.
- **Fonts:** `--font-display` is Press Start 2P, used only for headings and labels, never below 12px. `--font-body` is Atkinson Hyperlegible, never below 14px. `--font-mono` is IBM Plex Mono.
- **Mode colours:** each `body.mode-*` sets `--mode-accent`, `--mode-accent-strong`, `--surface`, `--surface-raised`, `--surface-sunken`, `--on-surface`, `--on-surface-muted` and `--page-bg`. The light theme overrides them under `body.px-v2.light-mode`.
- **Bridge:** `:root body.px-v2` maps the old variables (`--panel`, `--text`, `--shell-*`) onto these tokens, so legacy rules pick up the new colours.
- **Contrast:** `node scripts/check-contrast.js` checks 120 text and background pairs (6 modes × 2 themes) against WCAG AA. It runs in the test suite.

## Icons

`public/ui/icons/px-icons.svg` is a sprite of 16×16 icons with
`shape-rendering="crispEdges"`. The icons are our own drawings, defined as
ASCII grids in `scripts/build-px-sprites.js`; no third-party icon set is
used. Use them like this:

```html
<svg class="px-icon" aria-hidden="true" focusable="false"><use href="/ui/icons/px-icons.svg#i-help"></use></svg>
```

To add an icon:

1. Add a grid to `ICONS` in `scripts/build-px-sprites.js`.
2. Run `node scripts/build-px-sprites.js`.
3. Run the tests. They fail if the generated files are stale (the same check as `--check`).

Bootstrap Icons is still loaded for the parts that have not been migrated yet
(the game card, the generate and surprise buttons, and parts of the left
panel). Remove it once nothing uses `class="bi "`.

## Buttons and hit sizes

- `.px-iconbtn` is a 40×40px square, or 44×44px on touch screens (`pointer: coarse`). Always give it an `aria-label`.
- `.px-btn` is the text button; `--primary` and `--block` are its variants.
- Every `px-*` control gets a 3px `--px-focus` outline on `:focus-visible`.
- Scripts: `npm run check:contrast`, `npm run build:sprites`, `npm run build:type-floor`.

## Type scale

`scripts/build-px-type-floor.js` reads `style.css` and writes
`ui/px-type-floor.css`. Any rule with a smaller font size gets 12px if it uses
the pixel font, or 14px otherwise. `px-apply.css` then switches the most-read
places (mode names, filters, badges, footer, profile tabs, toasts) to the
body font.

Regenerate the file after editing `style.css`. Delete the generator once the
legacy rules are gone.

## Motion (low CPU)

- Nothing loops on its own except the status dot (`steps(2)`) and the mode decoration.
- The coin spin and the generate-button glow run only on hover or focus.
- `cursor-effect.js` is an IIFE that allows at most 40 particles. It does nothing when the tab is hidden or reduced motion is on.
- `prefers-reduced-motion: reduce` stops every animation and transition, and hides the cursor canvas.

## Mode decoration

`mode-decor.js` adds one `aria-hidden` container with three sprite elements
as the first child of `#game-viewport`. It does not use canvas,
`requestAnimationFrame` or timers.

`body[data-mode]` picks the sprites in CSS. `setMode()` in `script.js` sets
`data-mode` and calls `ModeDecor.set(mode)`.

Each sprite is a two-frame SVG strip in `public/ui/decor/`, animated with
`steps(2)` at 2, 1.3 and 1 fps. That is at most 4 fps; the test suite checks
it. The animation pauses in hidden tabs, stops under reduced motion, is
smaller on small screens, and is hidden in the focused session view and in
print.

## Modals: PxModal

`PxModal.open(elOrId, { initialFocus, onClose, closeOnBackdrop, display, returnFocus })`
and `PxModal.close(elOrId)` provide:

- a Tab and Shift+Tab focus trap
- Escape to close
- closing on a backdrop click (optional)
- `role="dialog"`, `aria-modal` and `aria-labelledby`
- focus returned to the opener

`GameUI.openModal` and `GameUI.closeModal` delegate to it, and the RPG screen
uses it too. This fixes M19.

## Theme

`GameUI.toggleTheme()` saves the choice in `localStorage` under
`givemegame_theme`, sets `html[data-theme]` and swaps the sun and moon icons.
`GameUI.restoreTheme()` runs in `init()`.

## RPG profile states

`js/rpg-net.js` turns network outcomes into states the UI can show honestly:

| Outcome | State | Text |
|---------|-------|------|
| 2xx | data | the profile |
| 401, or no session | login | "Prihlás sa" |
| 5xx, timeout, no network, or a broken body | offline | "Server nedostupný" with a "Skúsiť znova" button |
| other 4xx | offline-style error | with a retry button |

"Nie si členom školy" appears only when the server sends
`is_school_member: false`. Both `GET /api/rpg/avatar` and
`GET /api/rpg/talents` send `is_school_member` and
`membership { role, school_name }` through `lib/rpg-membership.js`.
Unlocking talents still requires membership (the POST route returns 403).

## Rules for new UI

- Use tokens. Do not add raw hex colours or new radii.
- Use sprite icons instead of emoji for controls.
- Put every user-facing string behind an i18n key in all six `public/data/i18n/*.json` files.
- Keep text at least 12px (display font) or 14px (body font).
- No new canvas or rAF loops. Decoration must use CSS `steps()` at 4 fps or less.
