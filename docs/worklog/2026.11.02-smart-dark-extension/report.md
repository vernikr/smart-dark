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

`npm test` runs 32 end-to-end checks in Chromium against local fixtures and the reference page `kiro.dev/blog/software-factory-stability/`: detection variants, live native-dark page, image classes with pixel statistics, switch persistence and popup wiring. Screenshots land in `shots/`.

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

## 1.2.0 follow-up

| Report | Cause | Fix |
| --- | --- | --- |
| Icon glyph floated inside the tile with a visible margin | The SVG was rasterised with its own padding | `scripts/make-icons.mjs` crops the rendered glyph to `path.getBBox()` (+2% breathing room) before resizing, so the moon fills 16–128 px tiles |
| Popup could not be rounded | Chrome draws the native action popup window itself; its shape is not stylable, and an inner `border-radius` merely double-rounds the corners with a seam | The popup stays the plain toolbar popup. No in-page panel, no extra surface to maintain |
| Already dark images were converted again | Only the presence of light pixels was checked, never their share | `lightShare` (pixels with luma > 0.5 on a 48×48 grid) skips frames below 25% (icons 8%), reason `already-dark` |
| YouTube seen as a light site while its system theme is dark | The `<html>` tag carries a bare `dark` attribute (plus `darker-dark-theme`), which only `body`/`data-theme` checks missed; YouTube adds it after the first paint, and the early measured verdict `measured-light` was never revisited | Declared-signal table covers classes, `data-*`, `inert` attributes like `dark`/`night`, `color-scheme`; `render()` re-detects each time and a declared verdict always replaces a measured one; measurement itself is now a page-wide survey with a canvas vote |
| Turning the site switch on inverted the video | With the theme forced, Dark Reader applies the YouTube fix `INVERT .html5-video-player`, generating `.html5-video-player > * { filter: invert() }` — that child is the `<video>` | `ignoreImageAnalysis` always includes `video, canvas, picture, iframe`, merged with the per-site list; verified by a fixture where the player wrapper is inverted on purpose |

Detection thresholds after the rewrite: the survey votes per sampled point and per text element, the page canvas (html/body paint) decides the bar — light canvas requires ≥75% dark votes, dark canvas ≥34%, no canvas ≥55%. Fixtures `fixtures/dark-body-class/`, `fixtures/dark-painted/` and `fixtures/youtube/clip.html` (a saved YouTube watch page, markup only) lock the three cases down.

## 1.2.1 follow-up

Reported on the installed build: the video on YouTube still flipped, and large pictures on kiro.dev still appeared light for a moment during a fast scroll. Both were reproduced live through the bridge and traced to real causes.

| Report | Cause | Fix |
| --- | --- | --- |
| Video inverted on YouTube with the site switch on | The site had no factory dark theme, so Dark Reader applied the YouTube fix list; `.html5-video-player` is in it, and the player wrapper sits above the `<video>`, so its child filter reached the clip. The list is written for the light layout and does not fit a page the reader itself darkened | `invertSelectors()` drops every media container (`video`, `player`, `media` in the selector) once the document holds a `<video>`; `fixesFor()` drops the whole light-site list on a page with a declared dark theme; `applyTheme()` now keys on the applied list, not just on the flag, so the theme is re-applied when a video arrives late |
| A late `<html dark>` was ignored | Detection was re-run on a fixed schedule; YouTube sets its theme attribute after that window | A `MutationObserver` watches `html`/`body` attributes and added nodes; a changed scheme or a newly mounted `<video>` triggers a re-render |
| Pictures show light before they are converted on kiro.dev | Three causes in a row: preloading started only 600 px ahead, conversions ran strictly one at a time, and candidates inside a reveal animation were treated as invisible and retried, by which time the light original had been painted | Prefetch margin 2400 px, a pool of 3 concurrent conversions, reveal animations (opacity 0) are no longer a reason to postpone, and a candidate is faded (`opacity .25`) while its replacement is prepared |
| kiro.dev blog covers stay light | The covers are mounted in a grid whose cells are laid out later, so the frame had no box yet; those retries ran out and the element was dropped | A frame that reports no size (common before layout) is sized from its parent, so the box arrives a frame later and still gets measured; photos below the light-share threshold are reported as `already-dark` instead of being left unprocessed |

Live result on the installed build: no filter anywhere in the video's ancestor chain at any sampled moment (20 samples over 10 s), and no large kiro.dev picture was left at its light original.

The ledger, `html[data-sd-images="started/converted/reasons"]`, now names each skip (`small`, `vector`, `already-dark`, `not-visible`, `claimed`, `empty-body`, `cross-origin`), because without it a light picture is indistinguishable from an unprocessed one.

## Known limits (1.2.1)

- A `.svg` picture is never converted: it is not decoded to pixels, and the page theme cannot recolour it either. Blog art delivered as SVG stays as drawn.
- A site whose dark theme is painted by the page but never announced can still be measured as light; the announced-signal watch only covers attributes and added nodes.
