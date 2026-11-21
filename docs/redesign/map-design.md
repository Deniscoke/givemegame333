# Visual design system audit: main app (`public/`)

The main app has no single design system. Three token sets, three font stacks and three corner-radius styles are stacked on top of each other. `ui/generator-shell.css` (rounded 14px corners, navy, Atkinson font) was layered over `style.css` (square, mode-coloured, pixel fonts) but only part of the UI was migrated. Most of the inconsistencies you listed come from that half-finished migration. The Czech text in the Slovak UI is a real code bug, and the paused database makes it much worse (§4.4).

Paths below are relative to `C:\Users\Admin\Desktop\gIVEMEGAME.IO-OPENCLAW\.worktrees\hardening\public\`.

**What loads, in order:** Google Fonts (Press Start 2P + VT323) at `index.html:8`, Bootstrap Icons from a CDN at `:9`, `style.css` at `:10`, `ui/tokens.css` at `:11`, `ui/generator-shell.css` at `:12`, `ui/session-shell.css` at `:13`. `ui/tokens.css:1` loads a second font set (Atkinson Hyperlegible, IBM Plex Mono, Press Start 2P again). `ui/shell.css` is not loaded by `index.html`.

---

## 1. Top header

The header bar is `style.css:213-230`: 50px tall (`--header-h`, `:17`), background `var(--panel)`, a 4px `ridge` bottom border, `justify-content: space-between`. Base rule is `overflow-x:auto`; `generator-shell.css:26-29` overrides it to `overflow:visible`.

| Element | Markup | How it's drawn | Size and shape |
|---|---|---|---|
| Brand | `index.html:22-24` | Press Start 2P text, 14px (`style.css:232-245`) | Text only |
| Coin counter | `index.html:27-30` | Emoji 🪙 that spins forever (`style.css:1906-1909`) | Gold gradient pill, `border-radius:8px`, padding 3px 10px, soft glow shadow (`style.css:1886-1905`). Container font is Press Start 10px, but the number is switched to IBM Plex Mono (`generator-shell.css:10`), so the pill mixes two fonts |
| Share link (ngrok only) | `index.html:33-38` | Emoji 🔗 + Press Start 8px | Green gradient, `border-radius:4px` (`style.css:2213-2223`) |
| Challenge pill | `index.html:41-43` | Emoji 🤖 + text | Indigo gradient, `border-radius:8px`, padding 3px 10px, Press Start 8px (`style.css:2238-2257`). `image-rendering:pixelated` does nothing on gradients or text. **Bug:** the HTML already puts "🤖 " before the label and every language file's `robot_challenge` value is "🤖 Challenge" too (`data/i18n/sk.json:195`, cs/en/de/es `:205-206`), so once translations load it shows 🤖🤖 |
| School (EDU) link | `index.html:46` | Emoji 🏫, inline `font-size:16px` | `.btn-retro .btn-action-header`, a square 40×40 (`style.css:849-893`) |
| Mobile filters | `index.html:47-49` | Bootstrap Icon `bi-sliders` | 40×40, square |
| NÁSTROJE | `index.html:50-52` | `bi-grid-3x3-gap` + `<span>Nástroje</span>` | See overflow note below |
| Help "?" | `index.html:53-55` | `bi-question-circle` | 40×40, square, white 3px border, 4px hard shadow |
| Library | `index.html:56-58` | `bi-collection` | 40×40, square |
| Fullscreen | `index.html:59-61` | `bi-arrows-fullscreen` | 40×40, square |
| Nastavenia | `index.html:62-63` | `<details><summary>` with `bi-gear` + text | Rounded `var(--shell-radius)` = 14px, 1px muted border, navy `--shell-raised`, min-height 44px, Atkinson bold (`generator-shell.css:44-57`) |

**Why "NÁSTROJE" overflows:** `.btn-action-header` fixes `width:40px; padding:0` (`style.css:885-893`). `.btn-game-tools` (`generator-shell.css:140-146`) adds `min-height:44px` and `padding-inline:.75rem` but never resets `width`. `.btn-retro` also forces uppercase (`style.css:864`). The result is an icon plus "NÁSTROJE" squeezed into a 40px-wide box. The only size tweak is at ≤420px, where the label shrinks to `.8125rem` (`generator-shell.css:336-338`), which doesn't help. Fix: `width:auto; white-space:nowrap` on `.btn-game-tools`.

**Clashes with the pixel-art concept:**
- **Mixed icon sources:** OS emoji (🪙 🤖 🏫 🔗) next to Bootstrap Icons outline glyphs (vector, anti-aliased, not pixel art). The favicon is a sans-serif "G" (`index.html:6`). The only real pixel art is the CSS-grid SMARTA and Tamagochi avatars (`index.html:566-575`, `596-605`).
- **Four corner styles in one bar:**
  - 0px on the `.btn-retro` buttons (`style.css:858`)
  - 4px on Share (`:2218`)
  - 8px on the Coin and Challenge pills (`:1891`, `:2243`)
  - 14px on Nastavenia (`generator-shell.css:54`)
- **Two shadow styles:** hard 4px offset shadows on `.btn-retro` (`style.css:859`) versus soft blurred glows on Coin, Challenge and Nastavenia (`style.css:1897`, `generator-shell.css:73`).
- **Four heights:** 40px icon buttons, 44px Nastavenia and Nástroje, roughly 22px pills, all inside a 50px bar that has a 4px border.
- **Gradients:** Coin, Challenge and Share use smooth gradients. The rest of the UI uses flat fills.
- **Placement:** because of `space-between`, Coin and Challenge float in the middle of the header, away from the action group.
- **Desktop:** at ≥1200px the tools panel is always visible (`generator-shell.css:259-265`), so NÁSTROJE only switches to the SMARTA tab (`game-ui.js:382-390`). The button is redundant there.

---

## 2. Fonts and readability

| Font | Loaded at | Used for |
|---|---|---|
| Press Start 2P | `index.html:8`, `tokens.css:1` | About 80 rules (`'Press Start 2P', cursive` ×50, `monospace` ×27). Titles, labels, badges, tabs, toasts, footer |
| VT323 | `index.html:8` | Base body font (`style.css:183`, 20px), form fields (`:950`, `:967`), coin dropdown (`:1940`), RPG screen (`:3973`, `:4164`) |
| Atkinson Hyperlegible | `tokens.css:1,4` | `body.generator-shell` (`generator-shell.css:3`) and the selectors overridden at `generator-shell.css:16-24`, `86-93`, `105-112`, `140-146`, `191-203`, `247-253` |
| IBM Plex Mono | `tokens.css:1,5` | Coin count, engine indicator, stat values (`generator-shell.css:8-14`) |
| `var(--font-display)` | `generator-shell.css:167` | **Never defined anywhere.** `.game-tools-title` silently falls back to the inherited font |

Press Start 2P is loaded twice (`index.html:8` and `tokens.css:1`).

**Readability problems:**
- **Font swapped, size kept.** `generator-shell.css:17-18` switches `.panel-label` and `.filter-label` to Atkinson but keeps the pixel-era sizes: 9px uppercase (`style.css:836-848`) and 8px at opacity 0.8 (`style.css:982-989`). Same for `.btn-toggle` at 8px (`style.css:925-931`, font swapped at `generator-shell.css:22`). That gives 8-9px body text.
- **Tiny Press Start text that was never migrated:**
  - Mode names: 7px (`style.css:329-334`), 6px at ≤800px (`style.css:1745`). `generator-shell.css:21` changes `.btn-mode`'s font, but `.mode-name` sets its own font-family, so it stays Press Start.
  - Language buttons: 8px (`:258-269`), 7px on mobile.
  - Game-card badges: 7px (`:1234-1245`); meta values 8px (`:1276-1280`); section titles 10px (`:1290-1297`).
  - SMARTA: style checkboxes at 8px (`:619-625`), hint 8px (`:672-676`), fact text 10px (`:677-678`); quick-view 9px (`:734`).
  - Footer: 9px and 8px at opacity 0.7 (`:801-818`). Profile tabs: 8px at opacity 0.7 (`:394`). Engine indicator: 9px (`:1019-1027`). Toast: 10px (`:1584-1600`).
  - Card footer buttons stay Press Start 9px (`.btn-action`, `style.css:933-939`). Only Join, Generate and Surprise were migrated (`generator-shell.css:105-112`).
- **Contrast:**
  - White text (`--text:#fff`) on the Party panel colour `--panel:#6abfc6` (`style.css:10`, `61`) is about 2.1:1. That affects the header, left-panel sections and footer.
  - Other modes are similar: Circus `#d97c4a` (`:124`), Cooking `#c2651a` (`:145`).
  - The whole RVP filter block is dimmed to opacity 0.6 outside classroom mode (`script.js:747-751`). These are the "greyed-out labels".
  - Help and Export close buttons use an inline grey `#888` with white text (`index.html:849`, `865`), about 3.5:1.
  - Also faded: welcome icon at opacity 0.3, hint at 0.5 (`style.css:1121-1132`); `.platform-intro-more` 11px at 0.55 (`:1154`); RPG disabled nav items at 0.3 (`:4182`).

---

## 3. Theming, animation and motion

### Token systems (there are three)
1. **`style.css:8-29` (legacy):** `--bg --panel --border --text --text-dim --btn-face --btn-active --accent --accent2 --mode-color --mode-color2 --mode-bg-tint --card-bg --card-text --tag-bg`, plus a light theme at `:32-43`.
2. **`ui/tokens.css:3-24` (shell):** `--shell-bg/surface/raised/text/muted/violet/cyan/yellow/danger/success/focus`, `--shell-radius:14px`, spacing scale. It is dark-only, so toggling light mode (`game-ui.js:324-332`) leaves the right panel, advanced options and settings menu navy.
3. **`style.css:4943-4968` (`--px-*`, "use these for all new RPG/EDU UI"):** includes `--px-radius:0`. It's only used by the RPG and EDU styles.

### How modes recolour the UI
`script.js:722-728` swaps a `body.mode-*` class.
- `style.css:52-175` sets the accent colours plus dark and light `--bg/--panel/--btn-face/--btn-active` for each mode:

| Mode | Lines | Accent | Dark background / panel |
|---|---|---|---|
| Party | `:52-70` | `#ff6b6b` | `#352879` / `#6abfc6` |
| Classroom | `:73-91` | `#3a86ff` | `#1a2744` |
| Reflection | `:94-112` | `#a855f7` | (not listed) |
| Circus | `:115-133` | `#ef4444` | (not listed) |
| Cooking | `:136-154` | `#f97316` | (not listed) |
| Meditation | `:157-175` | `#6366f1` | (not listed) |

- **What follows the mode:** header, footer, left-panel sections (`--panel`), active mode button and language button (`--mode-color`, `:317-323`, `:274-280`), selected tool tab (`var(--accent)`, `generator-shell.css:205-209`).
- **What doesn't:** the right panel, advanced options and settings menu (fixed `--shell-*` colours, `generator-shell.css:148-156`, `114-119`, `61-74`). The library modal, coin dropdown and RPG screen are fixed purple/navy.
- Card mode badge gradients: Party, Classroom, Reflection and Circus at `style.css:528-547`; Cooking and Meditation in a separate block at `:2197-2202`.
- Brand colours are hardcoded (`style.css:242-245`).

### Animations (all CSS unless noted)
**Running forever:**
- Coin spin (`style.css:1908`, 3s)
- Generate-button glow (`:903`, 3s)
- Footer status dot (`:1610`)
- Music button pulse and bounce while playing (`:345`, `:348`)
- Loading dice (`:1169`)
- Timer pulse (`:2149`)
- Robot bounce (`:2573`)
- RPG idle float (`:3653`)

**One-shot:** card appear (`:1203-1219`), coin pop (`:1914-1924`), phone vibrate (`:371-382`, triggered by a `setInterval` at `script.js:1735`).

28 `@keyframes` in total. Many hover effects use `transform: scale`/`translate`.

**Canvas particle effects:**
- **`cursor-effect.js`:** a full-viewport canvas (`index.html:907`, `style.css:2178-2192`). On every mode change it starts a `requestAnimationFrame` loop capped at 30fps (`cursor-effect.js:141-182`, `199`). It spawns a 15-particle burst plus one particle per frame at the cursor (max 120), and each particle is drawn as up to 64 `fillRect` calls. That is up to about 7,700 rects per frame for 4s, then a 2s fade (`:202-212`). It's light overall but not free.
  - It also declares top-level globals (`canvas`, `ctx`, `particles`, `init`, `resize`, `tick`) in a classic script (`cursor-effect.js:62-90`, `index.html:991`). The comment says "ESM module" but it isn't loaded as one, so these can collide with other globals.
- **`js/rpg-xp-fx.js`:** a second rAF canvas (`:122`, `:186`). It does check reduced motion (`:131-140`).

### `prefers-reduced-motion`
- **Respected only by:** the tools-drawer transition (`generator-shell.css:346-350`), `ui/shell.css:145` (not loaded on this page), and the RPG XP overlay (`style.css:5089-5094`, `rpg-xp-fx.js:131`).
- **Not respected:** `cursor-effect.js` (no check at all) and every endless CSS animation listed above, including the coin spin and the generate glow.

---

## 4. Panels

### 4.1 Left panel
- **Container:** `aside` background `var(--bg)`, `style.css:561-571`; width overridden to `min(100%,28rem)` at `generator-shell.css:95-98`.
- **Section style:** `.panel-section` cards are square, 3px black border, 4px hard shadow, background `--panel` (`style.css:825-833`). Mode, filters, description, engine and SMARTA all use this.
- **Rozšírené možnosti** (`index.html:190-295`) is a different style: 1px muted border, 14px radius, navy `--shell-surface`, Atkinson bold summary (`generator-shell.css:114-138`). It also contains:
  - **A square card inside the rounded box:** the RVP block `#rvp-filters-section`, a full `.panel-section` (`index.html:252-293`).
  - **Filter groups loose on navy:** the energy/activity/depth/cuisine/focus groups sit directly on the navy, not in a card, so the 8px labels have different contrast there.
  - **Messy markup:** indentation at `index.html:188-295` shows the `<details>` was inserted mid-structure.
- **Buttons:** square `.btn-retro` (Join, Generate, Surprise) next to the rounded advanced box. The Generate button is green `--success` with a glow (`style.css:895-905`) and doesn't follow the mode accent. Surprise uses `--accent2` (`:919-924`).
- **Leftovers:** a hidden emoji-only `🎮` `.btn-icon` (`index.html:314-317`) and the engine panel "IndieWeb Engine" (`:319-328`).
- **Forms:** VT323 selects and textarea, square (`style.css:942-976`).

### 4.2 Centre
- **Welcome card:** square, 4px border, 8px hard shadow (`style.css:1107-1117`). It contains `.platform-intro` with `border-radius:10px` and a 1px border (`:1133-1154`), so the card mixes square and rounded.
- **Game card:** square, consistent internally (`style.css:1203-1360`).
  - Badges are Bootstrap-style pastel fills (`:1246-1250`).
  - Badge and meta labels are hardcoded Czech in `game-ui.js:22`, `33`, `35`, `43-46` ("Uvnitř/Venku/Kdekoli", "hráčů", "Věk", "Hráči", "Délka", "Prostředí"), and the history meta at `game-ui.js:292`.
- **Session notes:** inline 8px-radius textarea (`index.html:486-491`).

### 4.3 Right panel (Herné nástroje)
Navy `--shell-surface`, 14px rounded (`generator-shell.css:148-253`):
- Tabs in a 2×2 grid, rounded.
- "Profil a postup" box, rounded (`:232-253`).
- The two profile buttons are `.btn-retro` (square, hard shadow) inside that rounded box (`index.html:652-653`).

Inside the tab panels the legacy styles come back:
- SMARTA is a square cyan `.panel-section` with a square `.narrator-bot` and a brown-tinted fact box (`style.css:629-700`).
- Tamagochi device, history list and stats are all legacy square.

So every tab is a rounded navy shell around square cyan cards. The RPG HUD (`index.html:658-664`) uses inline styles.

### 4.4 Slovak/Czech mixing: cause and fix
- **Czech is the HTML default.** All `data-i18n` fallback text in `index.html` is Czech:
  - `:103` Třída, `:107` Reflexe, `:115` Vaření, `:119` Meditace
  - `:336` "Připraveni generovat?"
  - `:126` Filtry, `:300` placeholder, `:673` PŘIPRAVEN, and the help modal `:817-845`
- **VAŘENÍ** = "Vaření" with `text-transform:uppercase` from `.mode-name` (`style.css:332`).
- **When Slovak gets applied:** `sk.json` does have the translations (`:10-15` Párty/Trieda/Chill/Cirkus/Varenie/Meditácia, `:91` welcome title), but they are only applied at the very end of `init()` (`script.js:335-337`). That happens after a series of sequential database calls:
  1. `syncAuthFromSupabase({verify:true})` (`:171`), with 8s timeouts on `getSession`/`getUser` (`:964`, `:991`)
  2. `loadStats()` (`:319`), a `profiles` query with **no** timeout (`:1055`)
  3. `loadQuestLog()` (`:323`), 8s timeout (`:1107`)
  4. `UserPreferences.load()` (`:332`), 8s timeout plus a fetch

  With Supabase paused, the Czech defaults can stay on screen for 10-25s+, or indefinitely if the `profiles` call hangs. **This is a real code bug** (blocking order) **that the paused database exposes.** Fix: call `setLang(currentLang)` before any awaited database call.
- **Badge set too early:** `setMode('party')` runs at `script.js:329`, before translations exist, so the card badge text falls back to the raw key "party" (`script.js:757`). It isn't refreshed after `setLang`.
- **Hardcoded Slovak with no `data-i18n`** (won't translate to CZ/EN/DE): "Nástroje" `:51`, "Nastavenia" `:63`, "Rozšírené možnosti" `:191`, "Herné nástroje" `:523`, tab labels `:529-532`, "Profil a postup" `:650`, profile modal `:689-736`, library `:943-961`, coin dropdown `:917-930`, edit modal `:998-1027`.
- **Library filter is English** (`index.html:950-955`).
- **Slovak strings mix in English slang:** "Setup", "SPAWNUJ HRU", "Energy", "Help", "READY" (`sk.json:17`, `:86`, `:37`, `:162`, `:122`).
- **Cyrillic typo:** "Talenты" (`index.html:791`). Bytes confirmed: "ты" is Cyrillic.

---

## 5. Modals and overlays

| Surface | Style | Where |
|---|---|---|
| Generic `.modal-box` (help, export, edit, reflection) | `--panel` background, 4px white border, 8px black hard shadow, square, Press Start title | `style.css:1547-1562` |
| gIVEME profile modal | Same `.modal-box` plus a header with an emoji "✕" (`index.html:690`) | `style.css:387-509` |
| | Tabs: Press Start 8px at 0.7 opacity | `style.css:394` |
| | Avatar is a circle (`border-radius:50%`); login CTA is a dashed blue Google-coloured box at 8px radius | `style.css:422-433`, `445-471` |
| | Coins and billing boxes are square | `style.css:472-505` |
| | Logout uses red `#e74c3c` | `style.css:507` |
| | gIVEME iframe background `#1a1a2e` (a third surface colour) | `style.css:399` |
| RPG overlay (`rpg-screen.js`, `index.html:764-812`) | Fixed `#09091a` with scanlines and decorative SVG pattern overlays | `style.css:3966-4003` |
| | Header 48px, purple glow logo, 4px-radius close button | `style.css:4016-4048` |
| | Nav buttons VT323 16px, 2px radius (10px on mobile) | `style.css:4154-4182`, `4775` |
| | Uses the purple `--px-*` palette; ignores the current mode and light theme | |
| | Emoji-labelled nav, "soon" badges | `index.html:791-798` |
| Settings dropdown | Rounded 14px, navy, soft shadow | `generator-shell.css:61-93` |
| | Contains the square Press Start `.btn-lang` buttons (`style.css:258-280`) and `.btn-retro` items with fonts swapped to Atkinson | |
| | "Účet a gIVEMECOIN" is a text-only `.btn-phone` with `padding !important` | `index.html:74`, `style.css:363-366` |
| Library modal | `#1a1a2e`, 16px radius, purple glow, blurred backdrop | `style.css:2720-2745` |
| Coin dropdown | `#1a1a2e`, 2px gold border, 10px radius, VT323 | `style.css:1929-1945` (width redefined at `:2118`) |

These modals use five background colours (`--panel`, `#1a1a2e`, `#09091a`, `--shell-surface`, `#0f0f24`), four radii (0, 4, 10/14, 16) and both hard and blurred shadows.

**Paused-database symptoms (not design bugs):**
- **RPG screen:** "Nie si členom školy" / "Načítavam…" / "Prihlás sa pre zobrazenie odmien." (`rpg-screen.js:157`, `242-251`, `368`).
- **Profile modal:** login CTA showing, coins stuck at 0.
- **Coin dropdown:** "Otváram históriu..." (`index.html:923`).
- **Library:** "Načítavam..." (`:965`).

These states are expected while the database is paused.

---

## Redesign targets (most impact first)

1. **Pick one token set.** Merge `style.css:8-175`, `ui/tokens.css:3-24` and `style.css:4943-4968` into mode-aware, light/dark-aware tokens. Set `--shell-radius` to 0 (or 2px) to match `--px-radius:0`.
2. **Fix the NÁSTROJE overflow.** Add `width:auto; white-space:nowrap` to `.btn-game-tools` (`generator-shell.css:140-146`), or use icon plus tooltip. Also drop the uppercase that `.btn-retro` adds (`style.css:864`).
3. **Unify the header controls** (`index.html:27-79`): one height (40 or 44px), one radius, hard pixel shadows. Use one icon source (a pixel icon set or SVG sprite) instead of Bootstrap Icons (`index.html:9`) plus 🪙/🤖/🏫. Restyle Coin, Challenge and Share (`style.css:1886-1909`, `2213-2257`) to match `.btn-retro`. Move them into `.header-actions`.
4. **Remove the double 🤖.** Take the emoji out of `index.html:42` or out of each language file's `robot_challenge`.
5. **Apply translations first.** Call `setLang(currentLang)` before the database awaits in `init()` (`script.js:171-337`). Add a timeout to `loadStats` (`script.js:1055`). Re-render the card badge after translations load (`script.js:754-760`).
6. **Change the HTML defaults to Slovak** (`index.html:95-845`). Add `data-i18n` to the hardcoded Slovak strings (`:51`, `:63`, `:191`, `:523-532`, `:650`, profile/library/coin/edit modals). Move the Czech strings in `game-ui.js:22-46`, `292`, `305` to `t()`. Fix "Talenты" (`index.html:791`). Review the English slang in `sk.json`.
7. **Set a type scale.** Press Start only for display text (brand, game title, section headings), minimum 12px. Readable font for everything else, minimum 14px. Fix in particular:
   - `.mode-name` (`style.css:329-334`, `1745`)
   - `.panel-label` and `.filter-label` (`style.css:836-848`, `982-989`)
   - `.badge` and `.meta-value` (`style.css:1234`, `1276`)
   - `.btn-lang`, `.btn-toggle`, `.btn-action`
   - narrator text (`style.css:619-678`), footer (`style.css:801-818`), profile tabs (`style.css:394`), toast (`style.css:1584`)

   Define `--font-display` (used at `generator-shell.css:167`) and remove the duplicate font import (`tokens.css:1` vs `index.html:8`).
8. **Fix contrast.** Darken `--panel` per mode or switch to dark text (white on `#6abfc6` fails; `style.css:61`, `124`, `145`). Replace the 0.6-opacity RVP dimming (`script.js:750`) with a label or badge. Replace the inline `#888` close buttons (`index.html:849`, `865`).
9. **Rozšírené možnosti:** restyle `#advanced-options` (`generator-shell.css:114-138`) as a square card. Un-nest the RVP `.panel-section` (`index.html:252`).
10. **Right panel:** make the tool shell and the inner `.panel-section` cards one style (`generator-shell.css:148-253` vs `style.css:629-700`). Use square tabs that follow the mode accent. Hide NÁSTROJE at ≥1200px.
11. **Modals:** one shared shell (header, ✕ icon button, body, footer) for `.modal-box`, `.library-modal` (`style.css:2725`), `.coin-history-dropdown` (`:1929`), the settings menu and the RPG header. Fix the welcome card's rounded `.platform-intro` (`:1133`) and the circular avatar (`:422`).
12. **Motion:** add a global `@media (prefers-reduced-motion: reduce)` that stops the endless animations (`style.css:345`, `348`, `903`, `1169`, `1610`, `1908`, `2149`, `2573`, `3653`). Add a `matchMedia` check in `cursor-effect.js:180-199`. Stop the coin spin and generate glow even with motion allowed. Wrap `cursor-effect.js` in an IIFE so it stops creating globals.
13. **Light theme:** add light variants of the `--shell-*` tokens, or the right panel and menus stay dark when "Vzhľad" is toggled (`game-ui.js:324-332`). Also save the theme choice, which currently isn't stored.

Outside this scope: `game-ui.js:290` puts `game.title` into `innerHTML` without escaping. Worth a look in the security pass.