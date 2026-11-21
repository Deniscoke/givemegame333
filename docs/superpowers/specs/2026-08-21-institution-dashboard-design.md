# Institution Dashboard Design Direction

## Subject, audience, job

- Subject: measurable learning impact for the four INVOK competency modules.
- Audience: a teacher or school administrator checking whether workshops changed student outcomes.
- Single job: move from “which school/class?” to “what improved?” and export the evidence.

## Visual system

- **Night ledger** `#090A18`: page background.
- **Archive violet** `#17172F`: panels and filter rail.
- **Signal violet** `#8B5CF6`: primary actions and active context.
- **Evidence cyan** `#38BDF8`: post-test/result markers.
- **Workshop gold** `#F6C85F`: pre-test markers and cautions.
- **Paper mist** `#E8ECF8`: primary text.
- Display: `Press Start 2P`, used only for the product mark and short section titles.
- Body: `Atkinson Hyperlegible`, optimized for longer labels and accessibility.
- Data/utility: `IBM Plex Mono`, used for percentages, dates, filters, and export metadata.

## Layout concept

The dashboard is a calm “impact field notebook” inside the existing retro universe. Pixel borders remain as a brand trace, while dense administrative content uses clean spacing, readable type, and restrained motion.

```text
desktop
┌ navigation ┬──────────────────────────────────────────────────────┐
│ EDU links  │ impact heading                 school / class filter │
│            ├──────────────────────────────────────────────────────┤
│            │ evidence summary strip                              │
│            ├───────────────────────────────┬──────────────────────┤
│            │ impact trail: pre → post      │ cohort / attempts    │
│            │ one rail per INVOK module     │ export evidence      │
│            ├───────────────────────────────┴──────────────────────┤
│            │ detailed, horizontally scrollable evidence table    │
└────────────┴──────────────────────────────────────────────────────┘

mobile
┌ impact heading ┐
│ school filter  │
│ class filter   │
├ summary strip  ┤
│ impact trails  │
│ stacked rows   │
├ export action  ┤
└ detail table → ┘
```

## Signature element

The memorable element is the **Impact Trail**: every module is rendered as a compact pre-to-post rail, with gold pre score, cyan post score, and a labeled delta between them. It borrows the project’s RPG progression language but represents real learning evidence instead of decoration.

## Interaction and accessibility

- No content depends on color alone: every score and delta has text.
- Native labeled selects and buttons; visible `:focus-visible` outlines.
- Status changes use an `aria-live="polite"` region; failures explain the next action.
- Touch targets are at least 40px.
- Motion is limited to one first-load trail reveal and is disabled by `prefers-reduced-motion`.
- User-controlled names are assigned with `textContent`, never interpolated into HTML.
- The results table remains a real semantic table with a caption and responsive horizontal overflow.

## Self-critique

The initial concept risked becoming another dark dashboard made from generic metric cards. The revision makes the pre/post relationship—not decorative cards—the visual thesis. Pixel styling is confined to identity and dividers; the evidence area prioritizes legibility, which is specific to the teacher/reporting job and the project’s WCAG direction.
