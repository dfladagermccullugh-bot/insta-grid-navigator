# Instagram Activity & Grid Optimizer

A lightweight, build-free **Manifest V3 browser extension** that restores native
browser utility and content discoverability on desktop Instagram's
**"Your Activity"** (Likes, Comments) and **"Saved"** (Collections, Reels)
grids.

Instagram's desktop grids are heavily locked down: thumbnails are deeply nested
React elements with no usable anchors, native mouse gestures are blocked by
invisible overlay layers, clicking "Back" after deep-scrolling resets the feed
to the top, and thumbnails expose no caption or description metadata. This
extension fixes all four problems.

## Features

| Feature | What it does |
| --- | --- |
| **Native link restoration** | Overlays a real `<a target="_blank">` on every grid thumbnail and disarms Meta's click-shield overlays, so **middle-click**, **right-click → Open in new tab**, and **Ctrl/Cmd + click** all work. |
| **Scroll memory** | Remembers your exact scroll position per page (in `sessionStorage`) and restores it when you navigate back — no more being thrown to the top of the feed. |
| **Hover tooltips** | Surfaces the hidden `alt`-text caption / auto-generated description for each post in a clean dark tooltip on hover. |
| **Local search filter** | Injects a search bar that instantly filters the loaded thumbnails by keyword, matching against their caption / description text. |

## Installation (Load Unpacked)

This is an unpacked developer extension — there is no build step.

1. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, etc.).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`insta-nav-optimizer/`** folder from this repository.

The extension activates automatically on the target pages — no configuration
needed.

## Usage

Navigate to any of the supported pages while logged in:

- `https://www.instagram.com/your_activity/*` (e.g. `/your_activity/interactions/likes`)
- `https://www.instagram.com/saved/*`
- `https://www.instagram.com/<username>/saved/*`

Then:

- **Open posts in a new tab** — middle-click, right-click, or Ctrl/Cmd + click any thumbnail.
- **See the caption** — hover over a thumbnail; a dark tooltip shows its description text.
- **Filter** — type a keyword into the search bar pinned at the top of the page; non-matching posts hide instantly. Clear the box to show everything again.
- **Keep your place** — scroll deep, open a post, hit Back; you return to where you left off.

## Project Structure

```text
insta-nav-optimizer/
├── manifest.json   # Manifest V3 config (matches the target paths, run_at: document_end)
├── content.js      # All logic — single IIFE, no globals, no dependencies
├── styles.css      # Namespaced (.igopt-*), theme-aware (light/dark) styles
└── icon.png        # Toolbar / extensions-page icon
```

### How it works

`content.js` is a single self-contained IIFE organized into five cooperating
modules:

1. **Bootstrap** — a `requestAnimationFrame`-debounced `MutationObserver`
   reprocesses cells as Instagram lazy-loads them, plus `history.pushState` /
   `replaceState` / `popstate` hooks to handle SPA navigation.
2. **Link wrapping** — resolves each post URL (preferring a real
   `a[href*="/p/" | "/reel/" | "/tv/"]`, falling back to React fiber props),
   overlays an anchor, neutralizes blocking overlays, and binds `auxclick` for
   middle-click.
3. **Scroll memory** — throttled save of `scrollY` per path; restores it on a
   short retry interval to survive lazy re-rendering.
4. **Hover tooltips** — a single shared, delegated tooltip element reads cached
   `alt` text.
5. **Search filter** — toggles `display:none` on cells whose cached `alt` text
   doesn't match the query.

To stay resilient against Instagram's frequently-changing hashed class names,
DOM lookups query by **structure** (anchor `href` patterns, `img[alt]`,
aspect-ratio containers) rather than CSS classes; React fiber traversal is used
only as a last-resort fallback.

## Design Constraints

This project is intentionally minimal for speed and performance:

- **No build tooling** — no TypeScript, Vite, Webpack, Babel, React, Vue, or Tailwind. Just vanilla JS, plain CSS, and a Manifest V3 JSON file.
- **No dependencies** — nothing to `npm install`.
- **No automated tests** — testing is done manually by loading the unpacked extension (see above).

## Limitations

Some Instagram grids (notably **Your Activity → Likes/Comments**) are rendered
with **Bloks**, Meta's server-driven UI. On those pages the thumbnails carry no
caption/description text in the DOM (`alt` is empty), so:

- **Open-in-new-tab still works** — the post link is reconstructed from the
  thumbnail's embedded media id (`ig_cache_key` → shortcode → `/p/<shortcode>/`).
- **Hover tooltips and keyword search are inert there** because there is no text
  to read, so the search bar **auto-hides** on those grids. Both features
  activate automatically on grids that do expose `alt` text (e.g. standard
  profile / Saved React grids).

## Compatibility

Desktop **Chromium-based browsers** (Chrome, Edge, Brave, etc.) with Manifest V3
support. Designed for the desktop web layout of Instagram.

## Disclaimer

This is an unofficial, independent utility and is not affiliated with,
endorsed by, or sponsored by Instagram or Meta. It only reads and re-presents
data already rendered in your own browser; it sends nothing anywhere. Because it
relies on Instagram's DOM structure, site changes may occasionally require
updates.
