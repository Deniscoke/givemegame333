## Accessibility, i18n and onboarding audit (public/)

All paths are relative to `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening\public\`.

### 1. i18n system

**Where the strings live**
- Translations are in `data/i18n/{sk,cs,de,en,es,tr}.json`. Key counts: cs 377, en 376, sk 366, de 325, es 325, tr 322. DE, ES and TR are each missing about 50 keys.
- The engine is in `script.js:1126-1231`:
  - `resolveInitialLang` (1129-1138) picks the language in this order: saved `localStorage.givemegame_preferred_lang` (1141), then `navigator.languages` if supported, then `'sk'`.
  - `loadTranslations` fetches `data/i18n/${lang}.json` (1153-1166).
  - `applyTranslations` (1168-1199) handles only `[data-i18n]` (textContent, or innerHTML for keys in `HTML_KEYS` at 1151) and `[data-i18n-title]`.
  - `t(key, fallback)` is at 1202-1205 and is exported as `window.givemegame_t` (1206).
  - `setLang` (1208-1224) saves to localStorage, sets `<html lang>`, re-applies translations and always shows a toast (1223).
- `login.html:339-372` has its own copy of `resolveInitialLang` and uses `data-login-i18n` with `givemegame_loginT`.
- `student/` has no i18n at all. Every string is hardcoded Slovak (`student/index.html:14-67`).
- The UI language codes are `sk cs en de es tr` (`script.js:1130`). The button shows "CZ" but sends `cs` (`index.html:68`).

**Why the SK UI shows Czech (concrete causes)**
1. **The HTML default text is Czech, and the SK translation is applied late and depends on the database.**
   - `index.html` ships Czech text in every `data-i18n` element, for example: 99-119 mode names, 129 "Věk", 154 "Počet hráčů", 306 "GENEROVAT HRU", 310 "Překvap mě!", 336-339, 673 "PŘIPRAVEN".
   - The first `setLang(currentLang)` call only happens at `script.js:335-337`. Before it, init awaits `syncAuthFromSupabase` (171), `GameData.load`/`Coins.load` (189-190), `loadStats` (319), `loadQuestLog` (323, 8 s timeout at 1107) and `UserPreferences.load` (332, 8 s `getSession` timeout at 84).
   - With Supabase paused, the page stays Czech for several seconds or longer. If anything earlier in `init` throws, it stays Czech for good.
   - This is a real code bug that the DB outage makes much worse. Fix: call `setLang` or `applyTranslations` at the very start of `init`.
2. **`data-i18n-placeholder` is never handled.** `index.html:300` uses `data-i18n-placeholder="description_placeholder"`, but `applyTranslations` ignores it, so the placeholder always stays "Krátký popis nebo zadání hry...".
3. **Czech strings with no i18n hook in `index.html`:**
   - 7 `<title>` "Generátor vzdělávacích her"
   - Help modal mode names in `<strong>`: 825 "Párty", 826 "Třída", 827 "Reflexe", 828 "Cirkus", 829 "Vaření", 830 "Meditace"
   - Help `help-key` labels: 834 "Levý panel", 835 "Filtry", 836 "Tlačítko", 837 "Karta"
   - 513 title "Tisk / Print"
   - 47 title/aria-label "Filtry"
4. **Hardcoded Czech in JS:**
   - `js/game-ui.js:22` settingLabels "Uvnitř/Venku/Kdekoli"
   - `js/game-ui.js:33` "hráčů", `:35` "Věk", `:43-46` meta labels "Hráči/Délka/Prostředí/Věk", `:292` history meta "hráčů"
   - `script.js:583-665`: all text and markdown export labels ("Hráči", "Věk", "Prostředí", "POMŮCKY", "VZDĚLÁVACÍ CÍLE", "BEZPEČNOSTNÍ POZNÁMKY", "TIPY NA ÚPRAVY", "Očekávané výstupy")
5. **Keys that exist only in cs.json:** `for_players, for_facilitator, lesson_flow, adaptations, risk_notes, player_goal, player_rules, player_roles, player_win, teacher_actions, student_actions`. No JS references them today, so they are dormant, but they would fall back as soon as they are used.
6. **Values identical in SK and CS (sanity check):** they are English slang or shared words, for example `players_small`, `welcome_title`, `key_*`. None of them are actual Czech text in sk.json.
7. **Other strings outside i18n:**
   - Hardcoded Slovak that never translates to other languages: `index.html:51, 63-65, 74-76, 88, 191, 487, 502-505, 532, 540-565, 715-744, 791-807`; `js/coins.js:203-519` (shop and history); `js/rpg-talents.js:196`.
   - Typo with Cyrillic letters: `index.html:791` "Talenты".
   - Many `t()` keys are missing from every JSON and use Slovak fallbacks: `js/game-ui.js:79,85,569-649`, `js/session.js:541-718`, `js/timer.js:85,244,253`, `js/reflection.js:89-174`, `js/narrator.js:382,436`. They are fine in SK but show Slovak in DE/EN/ES/TR.
   - `js/narrator.js:221` has a hardcoded "Načítavam...".

### 2. Accessibility audit

**Keyboard (real code bugs)**
- **Global Space/Enter hijack.** `script.js:686-704` ignores only SELECT, INPUT and TEXTAREA. Pressing Enter or Space on any focused button, link or summary calls `preventDefault()` and `generate()`, so keyboard users cannot activate Help, mode buttons, language buttons and so on.
- Single-key shortcuts S, T and M have no modifier (`script.js:693-698`), which fails WCAG 2.1.4.
- Clickable non-buttons with no tabindex, role or key handler:
  - `index.html:27` `div.coin-display`
  - `index.html:404, 437, 447, 457, 467` `h3.section-title.clickable`
  - `js/game-ui.js:286-295` `div.history-item`
  - `js/library.js:341,367` library item `div`
  - `js/rpg-talents.js:174,204-205` `div.rpg-talent-node`
- Modals:
  - `js/game-ui.js:335-340` `openModal`/`closeModal` only toggle `display`. They do not move focus, trap focus, close on Escape or restore focus.
  - `#help-modal` (815), `#profile-modal` (686), `#export-modal` (855) and `#game-edit-modal` (995) have no `role="dialog"`, `aria-modal` or label. `bindModalClicks` (`script.js:708-714`) only closes on a click on the overlay.
  - Escape works only in library (`js/library.js:197`), RPG screen (`js/rpg-screen.js:459`), session (`js/session.js:72`) and mobile SMARTA (`js/game-ui.js:405`).

**Missing labels and ARIA**
- Icon-only buttons with only a `title`: `index.html:53` (Help "?"), 56 (Library), 59 (Fullscreen), 46 (EDU link, emoji only).
- Close buttons showing only "✕" or an icon, with no aria-label: `index.html:690, 944, 999`. Library action buttons rely on `title` only: `js/library.js:356-362`.
- `<label class="filter-label">` elements have no `for=` attribute, so selects have no accessible name: `index.html:129/131/141, 154/155, 165/166, 175, 196/197, 207, 219, 229, 241, 256, 265, 279, 299/300`. The panel labels at 95 and 126 are not form labels either.
- The toast `#toast` (`index.html:904`, `js/game-ui.js:441-446`) and `#status-text` (673) have no `aria-live` or `role="status"`.
- There is no skip link on index.html. `.product-skip-link` exists only in `ui/shell.css:33-48`, which index.html does not load.
- Already good: the tools tablist with arrow keys (`index.html:528-535`, `js/game-ui.js:410-414`), `rpg-screen` with role="dialog" (764), `reflection-modal` (1033) and the student portal (`student/index.html:14-67`).

**Focus visibility**
- Focus outlines removed:
  - `style.css:616` `.narrator-area-select:focus{outline:none}`
  - `style.css:1082` `.input-api-key`
  - `style.css:2950` `.gedit-input/.gedit-textarea`
  - `style.css:3344` `.rating-text`
  - `style.css:3369, 3383` `.lib-search` and `.lib-filter-select`: outline removed, only a border-color change remains
- A global `:focus-visible` rule exists only in `ui/shell.css:17` (not loaded by index.html). `ui/generator-shell.css:211-217` covers only tools tab, close button, profile button and `.btn-game-tools`. Mode, language, generate and header buttons have no custom focus ring and rely on the browser default against busy pixel borders.

**Tiny pixel fonts**
- `style.css` has 56 declarations at 5-8px, most of them Press Start 2P.
  - 5px: 1424, 1472
  - 6px: 1512, 1670, 1746 `.mode-name`, 1839 `.btn-lang`, 1854, 1875 `.brand-title`, 3493, 3949 `.rpg-talent-name`
  - 7px: 331, 1057, 1236, 1503, 1628
  - 8px: 260, 394 `.profile-tab`, 481, 502, 519, 622, 693, 730, 811, 930, 985, 1278
  - 9px: 734, 803, 836, 938, 1021, 1378, 1568, 1870 `.coin-display` (mobile)
- `ui/generator-shell.css:1-24` already moves body, labels, selects and mode buttons to `var(--font-body)` (Atkinson Hyperlegible, `ui/tokens.css:1,4`). The px sizes from style.css still apply to them.
- `--font-display` is undefined; it is used at `ui/generator-shell.css:167`.

**Contrast**
- White `--text #fff` on `--panel #6abfc6` (header `style.css:216`, footer 791, and 609, 639, 825, 1385, 1442, 1548) is about 2.1:1, which fails.
- White on `--btn-face #887ecb` (426, 855, 1401) is about 3.6:1, which fails for small text.
- `--text-dim #b8b8b8` (`style.css:13`) on the cyan panel fails badly.
- 46 rules use `opacity:0.3-0.6` on text, for example 505, 1154 `.platform-intro-more` 0.55 and 1506.
- The help close button with `background:#888` and white text (`index.html:849, 865`) is about 3.5:1.

**Motion without a reduced-motion guard**
- `style.css` has only one guard, at 5089-5094 (RPG XP effect). `ui/generator-shell.css:346-350` guards only the tools aside transition. The global guard in `ui/shell.css:145-154` is not loaded on index.html.
- Unguarded infinite animations: `style.css:345, 348` music, 903 glow-pulse, 1169 dice-spin, 1610 pulse, 1908 coin-spin, 2149 timer-pulse (0.5 s), 2573 robot-bounce, 3653 rpg-idle-float. That is 33 `animation:` uses and 28 `@keyframes` in total.
- `cursor-effect.js` (particle burst on mode switch) has no `matchMedia` reduced-motion check. The only JS check is in `js/rpg-xp-fx.js:131`.
- The phone vibrate every 30 s (`script.js:1731-1740`) is also unguarded.

### 3. What the "?" button does today
- `index.html:53` calls `App.UI.openHelp()`, which runs `openModal('help-modal')` (`js/game-ui.js:341, 335-337`) and sets `display:flex`.
- The modal (`index.html:815-851`) is static. It has a "what is it" section, mode descriptions, four "how to use" steps and a shortcuts list.
- There is no tour, no spotlight, no first-run detection and no saved state. A search for "tour", "onboard" or "first_run" finds nothing in the JS.
- `home.html:233` even states "Žiadny onboarding. Žiadny tutoriál."

### 4. Integration points

**(a) Read-aloud**
- Reuse the existing speech code in `js/narrator.js`:
  - `speechSynth` is initialised at 204-208.
  - `getLangBcp47` (108-110) maps sk-SK, cs-CZ, de-DE, es-ES and otherwise en-US. TR is missing; add `tr-TR`.
  - `getPreferredVoice` is at 112-120. The utterance pattern is at 315-327.
  - Expose these through the Narrator module API, or move them to a small new `js/read-aloud.js` loaded before `script.js` (`index.html:975-990`).
- Use the current language from `window.givemegame_currentLang` (`script.js:1146, 1210`).
- For Ctrl+click, add a capture-phase `document.addEventListener('click', …, true)` that reads `e.target.closest('[data-i18n], p, li, h1, h2, h3, .game-pitch, .game-list li, .toast')?.innerText`.
- Avoid a clash with the existing Ctrl+C handler (`script.js:699`). The Space/Enter hijack (`script.js:686-704`) must be fixed first.
- For a toggle mode, put the toggle in the preferences menu (`index.html:64-77`) and save it in localStorage, the same way as the language (`script.js:1211`). Add new i18n keys to all six JSON files.

**(b) Readable-font toggle**
- `ui/tokens.css:4-6` already defines `--font-body` (Atkinson Hyperlegible), `--font-data` and `--font-pixel`, and loads the fonts at line 1.
- `style.css` hardcodes `'Press Start 2P'` and `'VT323'` in about 110 declarations instead of using variables. The base is `body{font-family:'VT323';font-size:20px}` at `style.css:180-184`.
- Approach: add a class on `body`, toggled from the preferences menu (`index.html:62-78`) and saved in localStorage. Load a new small stylesheet after `ui/generator-shell.css` (`index.html:12`) with a rule like `body.readable-font :is(*):not(h1,h2,.brand-title,.modal-title,.welcome-title,.section-title,.rpg-screen-logo,.mode-emoji,.bi){font-family:var(--font-body)!important}`.
- Also lift the minimum size, for example `font-size:max(…,14px)` on the selectors listed in section 2.
- The pattern to copy is `body.generator-shell` (`ui/generator-shell.css:1-24`), which already does a scoped font swap.
- Define the missing `--font-display` in `ui/tokens.css`.
- Apply the class before first paint, either with an inline script in `<head>` or at the start of `init` (`script.js:163`).

**(c) First-run guided tour**
- Start it at the end of `App.init()` after `setLang` (`script.js:335-337`), or better, only after the translation fix so the tour text is in the right language.
- Gate it on a localStorage flag such as `givemegame_tour_done`, using the same try/catch pattern as `script.js:1141, 1211`.
- Suggested spotlight targets, all with stable IDs or classes:
  - `#mode-grid` (`index.html:96`)
  - the filters `.panel-section` (125), or `#creation-basics` (91)
  - `#advanced-options` (190)
  - `#filter-description` (300)
  - `#btn-generate` (304)
  - `.btn-surprise` (309)
  - `#btn-game-tools` (50)
  - the help button (53; give it an id)
  - `#btn-library` (56)
  - `.preferences-menu` (62), the language selector `#lang-selector` (66)
  - `#coin-display` (27)
  - `#btn-join-session` (87)
- Mobile: the left panel is behind `App.UI.toggleMobileFilters()` (`index.html:47`) and the tools are in a drawer (`js/game-ui.js:371`). The tour has to open these before spotlighting inside them.
- Z-index: the existing layers go up to modals 9999 (`style.css:1539`), toast 10000 (1594), RPG 15000 (3969), talent confirm 20000 (3910), avatar picker 21000 (1545) and XP effect 99999/100000 (`js/rpg-xp-fx.js:52,64`). Put the backdrop and spotlight around 30000 so they sit above the app but below the XP effect.
- The tour must use `role="dialog"`, `aria-modal`, a focus trap and Escape to skip; no existing modal in `game-ui.js` provides these to copy.
- Add a "Restart tour" button to the help modal footer (`index.html:848-850`) and step-text keys to all six i18n JSON files.
- During the tour, suspend the global Space/Enter generate shortcut (`script.js:690`).

**What the DB outage changes**
- These come from the paused database, not from code bugs:
  - "Načítavam tvoje aktivity…" and "Načítavam pokrok…" in the student portal (`student/index.html:62,67`)
  - empty coins, quest log and RPG data
- The DB outage does not cause the Czech text. It only stretches how long it shows, because `init` awaits the database calls before the first `setLang` (`script.js:171-337`).