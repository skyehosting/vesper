# 04 — Design system

Mood: a clear night just after sunset. Deep indigo dark, one warm star. Calm, legible, intimate — a place to talk, not
a dashboard. Shares Orrery's craft (glass panels, fine lines, Inter + JetBrains Mono) but warmer.

## Themes
Dark (default), Light, System. All colors are CSS custom properties on `:root[data-theme]`; components never hard-code
colors. Contrast: body text ≥ 7:1, secondary text ≥ 4.5:1 on every surface it appears on.

### Dark
| Token | Value | Use |
| --- | --- | --- |
| `--bg-0` | `#07070d` | app background (behind the Star) |
| `--bg-1` | `#0c0c16` | sidebars |
| `--bg-2` | `#121222` | panels, composer |
| `--bg-3` | `#1a1a2e` | hover, inputs |
| `--line` | `rgba(255,255,255,.07)` | hairlines |
| `--line-strong` | `rgba(255,255,255,.14)` | input borders |
| `--text-0` | `#f3f1fb` | primary text |
| `--text-1` | `#c5c1d8` | secondary |
| `--text-2` | `#8f8aa8` | tertiary / meta |
| `--glass` | `rgba(18,18,34,.72)` + 14 px blur | floating surfaces |
| `--user-bubble` | accent at 14 % over `--bg-2` | user messages |
| `--success` `--warning` `--danger` | `#4ade80` `#fbbf24` `#f87171` | states |

### Light
`--bg-0 #f7f6fb`, `--bg-1 #efedf6`, `--bg-2 #ffffff`, `--bg-3 #e9e6f3`, `--text-0 #16141f`, `--text-1 #45405a`,
`--text-2 #6d6884`, lines `rgba(20,16,40,.08/.16)`. The Star keeps a dark stage in light theme (a night window).

### Accents (Settings → Appearance)
| Accent | Hex | Star core / corona |
| --- | --- | --- |
| **Vesper gold** (default) | `#f5b84c` | warm white-gold core, violet-rose corona |
| Dusk violet | `#a78bfa` | lilac core, indigo corona |
| Rose | `#fb7185` | pink core, plum corona |
| Aurora | `#34d399` | mint core, teal corona |
| Ice | `#7dd3fc` | blue-white core, cyan corona |
`--accent`, `--accent-soft` (14 %), `--accent-strong` (hover), `--on-accent` (text on accent, ≥ 4.5:1).

## Type
Inter Variable (UI, messages) · JetBrains Mono (code, IDs). Sizes: `--fs-xs 11` `--fs-sm 12.5` `--fs-md 14`
`--fs-lg 16` `--fs-xl 20` `--fs-2xl 28`. Messages 15 px / 1.6 line height (user-adjustable: 13–20 px). Numbers
tabular where they align.

## Space, shape, motion
4 px grid; radii `--r-sm 6` `--r-md 10` `--r-lg 16` `--r-xl 22`; shadows soft and few. Motion `--ease-out
cubic-bezier(.2,.8,.2,1)`, durations 120/200/320 ms; everything honors reduced motion (app setting + OS).

## Components (kit)
Button (primary/secondary/ghost/danger, sm/md/lg, icon, loading), IconButton, Input, Textarea (auto-grow), Select,
Combobox (searchable — voices, models), Switch, Checkbox, Radio cards (wizard choices), Slider (with value),
Segmented, Tabs, Tooltip, Popover, Menu/ContextMenu, Dialog (focus trap), Sheet (mobile), Toast, Badge/Chip, Kbd,
EmptyState, Skeleton, Callout (info/warn/privacy), SecretInput (masked, reveal, "saved" state, never prefilled with
the real key), CopyButton, QRCode, Avatar (the mini Star for AI messages), ProgressBar/Ring, StatusDot.

## Messages
- **User**: right-aligned bubble (`--user-bubble`), max 72 % width, attachments as chips/thumbnails above text.
- **AI**: full-width, mini-Star avatar at left, markdown (headings, lists, tables, blockquotes, code blocks with
  language label + copy, inline code, math), streaming caret; voice-revealed text fades each glyph in (opacity + 2 px
  rise over 120 ms).
- Meta row on hover: time (local, relative on hover), model, tokens, copy, regenerate (AI), edit (user), speak
  again (AI, voice on), delete.
- Day separators ("Yesterday", "Friday 12 September"), and a **time-gap marker** when a session resumes after > 6 h
  ("— 23 days later —").

## Icons
lucide-react, 16/18/20 px, 1.75 stroke.
