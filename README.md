# Marginalia

Tufte-style sidenotes for [Obsidian](https://obsidian.md), displayed in the margin of your notes with automatic numbering.

This is a fork of [cparsell/sidenotes](https://github.com/cparsell/sidenotes), simplified to support HTML sidenotes only (footnote-based sidenotes and margin notes have been removed). Inspired by [Gwern.net](https://gwern.net/sidenote) and [Edward Tufte's conventions](https://edwardtufte.github.io/tufte-css/).

> **Note:** If you previously used the original Sidenotes plugin, disable it before enabling Marginalia — both act on the same `<span class="sidenote">` elements and will conflict.

## Features

- **Sidenotes in the margin** — shown in both Editing (Live Preview) and Reading modes, with automatically incrementing numbers.
- **Per-note side override** — force an individual sidenote into the left or right margin, regardless of the global position setting.
- **Per-note styling** — each sidenote can have its own background color, text color, font size, and font family. Edit styles via a gear icon or by hand in source mode.
- **Edit in the margin** — click a sidenote to edit it in place. `ENTER` commits, `SHIFT+ENTER` adds a new line, `ESC` cancels. Editing in Reading mode can be enabled in settings.
- **Links and formatting** — internal (`[[Note]]`) and external links, **bold**, _italic_, and `inline code` all work inside sidenotes.
- **Collision handling** — overlapping sidenotes are automatically spaced apart, per margin column.
- **Responsive layout** — sidenotes shrink in narrow windows and hide below a configurable breakpoint.
- **PDF export** (experimental) — optionally include sidenotes in the margin of exported PDFs.
- **Web-publishing friendly** — sidenotes are plain HTML spans in your Markdown, so the same notes can be styled with CSS when published (e.g. with [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden)).

## Usage

Sidenotes are written as HTML spans directly in your Markdown:

```html
This is a sentence.<span class="sidenote">This appears in the margin.</span>
```

To force a specific side:

```html
<span class="sidenote sidenote-left">Always in the left margin.</span>
<span class="sidenote sidenote-right">Always in the right margin.</span>
```

### Commands

| Command                | Inserts                                        |
| ---------------------- | ---------------------------------------------- |
| `Insert sidenote`      | `<span class="sidenote"></span>`               |
| `Insert left sidenote` | `<span class="sidenote sidenote-left"></span>` |
| `Insert right sidenote`| `<span class="sidenote sidenote-right"></span>`|

Each command places the cursor inside the span, or wraps the current selection if you have text selected.

### Editing

Click a sidenote in the margin to edit it. Press `ENTER` to save, `SHIFT+ENTER` for a new line, `ESC` to cancel. To edit sidenotes in Reading mode, enable **Allow Sidenote Edits in reading mode** in settings.

### Per-Note Styling

Each sidenote can have its own background color, text color, font size, and font family.

**Via the style modal (Live Preview and Reading mode):**

Hover over a sidenote margin box and a gear icon appears. Click it to open the style editor:
- The note preview and config panel sit side-by-side, mirrored to match your note's margin side (left notes show preview on the left, right notes on the right).
- Adjust background, text color, font size, and font family. Changes live-update the preview and the note itself.
- **Save** commits the styles to your document; **Cancel** reverts.

**By hand (source mode):**

Styles are stored as a plain `style` attribute on the sidenote span, so you can edit them directly in source:

```html
<span class="sidenote" style="background: #fdd; color: #333; font-size: 14px; font-family: Georgia">Styled note</span>
```

Supported CSS properties: `background`, `background-color`, `color`, `font-size`, `font-family`, and any other properties except layout-breaking ones (`position`, `width`, `transform`, `z-index`, etc., which the plugin filters out to preserve the margin layout).

## Settings

- **Display** — left or right margin, show/hide numbers, number style (Arabic, Roman, letters), badge style (plain, neumorphic, pill), number color.
- **Width & spacing** — min/max sidenote width, gaps between text, sidenote, and editor edge, anchor mode (text or editor edge), page offset.
- **Breakpoints** — window widths at which sidenotes switch to compact mode or hide.
- **Typography** — font size (normal and compact), line height, text color, hover color, alignment.
- **Behavior** — collision spacing, transitions, per-heading numbering reset, Reading-mode editing, PDF export.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release (or build from source, below).
2. Copy them into `YOUR-VAULT/.obsidian/plugins/marginalia/`.
3. Restart Obsidian and enable **Marginalia** in **Settings → Community plugins**.

### Building from source

```bash
npm install
npm run build
```

This produces `main.js` at the repository root. Copy it together with `manifest.json` and `styles.css` into the plugin folder as above.

## Known issues and limitations

- Reading mode: committing an edit to the last sidenote can scroll the view up.
- Changing style settings can cause Editing-mode sidenotes to disappear until restart.
- Per-note styling: if two sidenotes contain byte-identical text, the style editor targets the first occurrence in the file (same limitation as text editing).

## Credits

- Forked from [cparsell/sidenotes](https://github.com/cparsell/sidenotes).
- Sidenote conventions from [Edward Tufte](https://edwardtufte.github.io/tufte-css/) and [Gwern.net](https://gwern.net/sidenote).

## AI disclaimer

Large Language Models (LLMs) were used in the production and editing of this code.
