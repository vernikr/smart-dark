# Smart Dark — implementation report

## Goal

Browser extension with two remembered per-site switches:

1. `Затемнять сайт <domain>` — appears when the site has no factory dark theme.
2. `Затемнять изображения на <domain>` — smart dark conversion of large images, independent of the site theme.

Reference points: Dark Reader for page recolouring quality, DarkPage for image handling.

## What was built

| Area | Decision |
| --- | --- |
| Page recolouring | Dark Reader bundle embedded and driven from the content script; per-site fix lists compiled from the vendored Dark Reader tree |
| Detection | Body background luminance first, viewport sampling of painted backgrounds as fallback, then `color-scheme`, `data-theme` hints and text luminance |
| Image classes | `photo` (many colours, midtones), `graphic` (few colours or light-background flat art), `icon` (transparency) |
| Tone mapping | Perceptual sRGB lightness remap; graphics flip polarity into a dark band, photos are gently dimmed, ink stays legible; hue and chroma kept, alpha untouched |
| Swap | Pixels re-encoded to a PNG blob and assigned to `img.src`; `filter` cleared so Dark Reader cannot double-process |
| Persistence | `storage.local` maps `darkSites` / `imageSites`, `false`/`true` are explicit overrides, missing key means auto |

## Verification

`npm test` runs 19 end-to-end checks in Chromium against local fixtures and the reference page `kiro.dev/blog/software-factory-stability/`: detection variants, live native-dark page, image classes with pixel statistics, switch persistence and popup wiring. Screenshots land in `shots/`.

Tone curves were prototyped in Python against real artwork before porting, which caught two defects: a linear-space/perc-heights confusion that crushed dark text, and a hue-scaling branch that turned white logos grey.

## Repository notes

The Dark Reader checkout (source of the fix lists) is not committed: `dist-templates/fixes.json` carries the compiled snapshot so a clean clone builds offline, and `npm run sync-fixes` refreshes it from upstream when needed.

## 1.1.0 follow-up

| Report | Cause | Fix |
| --- | --- | --- |
| Toolbar icon invisible | ImageMagick rendered the SVG through a delegate that produced fully transparent tiles | Icons are rendered from `moon.svg` in Chromium (`npm run icons`), popup header uses the PNG asset |
| Popup font | Explicit Web-font stack | Native system stack (`-apple-system`, `Segoe UI Variable Text`, `system-ui`) |
| Images off by default | Switch treated an unset site as off | Unset now means on; an explicit `false` turns the layer off and restores originals in place |
| Footer duplicated the status line | Static hint text in the footer | Footer renders only with the re-check action, otherwise hidden and not laid out |
| arena.ai read as dark | Detection ran after our own repaint set `body` to the Dark Reader background | Declared signals first, then measurement with own stylesheets disabled and own colours rejected |

## Known limits

- Cross-origin images without CORS headers are skipped (browser restriction); they render as-is.
- `srcset`/`sizes` are cleared on converted images, so the conversion runs at natural size (capped) instead of per-DPR variants.
- Animated images are flattened to a single frame.
- Dark Reader refuses protected pages (`chrome://`, extension pages, PDF viewer).

## Bugs found and fixed during the work

- Service-worker install handler overwrote site settings on reload; defaults are now read without writing.
- The global `INVERT: img` rule from Dark Reader's fix list marked every image as an icon; global blocks are excluded at build time.
- Images whose opacity animates in were dropped as "invisible"; now retried a few times.
- Site re-renders could restart conversion forever; each element/source pair is now claimed once.
- Slow image loads could stall the queue; each image is bounded by a timeout.
