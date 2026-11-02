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

`npm test` runs 44 end-to-end checks in Chromium against local fixtures and the reference page `kiro.dev/blog/software-factory-stability/`: detection variants, live native-dark page, image classes with pixel statistics, switch persistence and popup wiring. Screenshots land in `shots/`.

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

## 1.2.2 follow-up

Reported on habr.com: the photo with the gas tanks in the feed and both illustrations of the cloud.ru article stayed light.

| Report | Cause | Fix |
| --- | --- | --- |
| Nothing is darkened on habr.com at all | Images are served from `habrastorage.org`, which answers `Access-Control-Allow-Origin: *`. A request that carries cookies is rejected by the browser against a wildcard origin, and the bitmap fetch used `credentials: 'include'` — so every picture ended in `cross-origin` | The anonymous request is tried first and the credentialed one is kept as a fallback for hosts that need a session. Confirmed against the old build: `cross-origin`, against the new one: read and converted |
| The 1320×300 cloud.ru header stays light | It is flat brand art (45 colours, 25% midtones, 68% light) but the class threshold was 32 colours, so it fell into `photo`, and the soft photo curve only pulls its mean to 0.55 | The flat-art threshold is 64 colours: the header is now `graphic` and its mean lands at 0.364. Real photographs keep hundreds of colours at the 40×40 grid (the cisterns photo: 132), so they are unaffected |
| The runners illustration looks almost unchanged | Not a bug in this build: 79 colours and 47% midtones is a photograph by every measure, so the soft curve applies and the mean goes 0.672 → 0.361. Where it still reads light is the pale sky band — the soft curve never drives anything to black. Open question for the user: is that acceptable, or should photographs with a large flat light area get a stronger curve |

Live ledger after the fix — feed: `35/1/{"small":28,"already-dark":6}` with `photo/132/0.48/1.00` on the tanks photo; article: `14/7/{"small":3,"already-dark":4}` with `graphic/45/0.25/1.00` on the header and `photo/79/0.47/1.00` on the runners. Screenshots: `docs/worklog/2026.11.02-smart-dark-extension/shots/` is unchanged for this round, the captures are in the user-facing comparison page.

## 1.2.3 follow-up

Reported on meduza.io: pictures are darkened for a moment and then look restored.

| Report | Cause | Fix |
| --- | --- | --- |
| A darkened picture on meduza.io looks bright again | Every picture there is a responsive `<picture>`. The frame the browser paints is chosen by the `<source srcset>` children, and that choice outranks `img.src`. The swap put the dark PNG into `src`, the `<source>` still pointed at the bright original, so `currentSrc` never left the original and the tone-mapped frame was simply not displayed. The `data-sd-*` markers said `graphic`/`photo`, which is why it read as "darkened, then restored" rather than "never darkened" | The `<source>` children are emptied when the swap happens and their values are parked in `data-sd-sources`, so hiding images for the origin puts the page back exactly as it was. Confirmed on the live front page: converted pictures now report `currentSrc = blob:` instead of the original URL |
| The same, on a framework re-render | After the swap a re-render can put `srcset` back on the element or on its `<source>` children, and either wins over our blob | A converted image is held, not silently overridden: a mutation that carries returning sources re-clears them, and only a genuinely new URL with no `<source>` present is handed back to the queue (paging recycles cards, so a new URL must still be converted) |

Live after the fix — meduza front page: `16/5/{"already-dark":11}`, article: `15/5/{"small":2,"already-dark":8}`; every converted picture reports `currentSrc = blob:` and none of them has a live `<source srcset>`. Covered by two new checks in `npm test` (a `<picture>` fixture and a forced re-render that restores `srcset`); the suite is 40/40.

## 1.2.4 follow-up

Reported on `meduza.io/feature/2026/11/02/schitay-nas-prodali-no-my-privykli`: the photographs are not visible at all on first load, one picture is mistaken for an illustration and inverted, and after that inversion the frame holds more light than the original.

| Report | Cause | Fix |
| --- | --- | --- |
| The photographs of the article are invisible | The loader parks a 1×1 transparent GIF in `img.src` and keeps the real frame in the `<source srcset>` of the `<picture>`. The layer read the element, so it classified and converted a one-pixel image (`graphic/1/0.00`) and then emptied the `<source>` children — the article was left with nothing but a darkened stand-in | A picture whose element decodes to 4 px or less is never read from the element: the frame is resolved from the `<source srcset>` children (live ones first, then the parked values of an earlier swap) and that frame is what gets classified. When no frame can be resolved the picture is left alone with `sdSkip=placeholder` |
| A photograph is taken for an illustration and inverted | The stand-in was a photo, so cover pictures inherited the stand-in's analysis; and dark art with light lettering (a poster on a near-black plate) is genuinely flat — few colours — so the flat-art rule flipped it into a light page with dark lettering | Nothing left to invert once the frame is read. On top of that a flip is now checked against the original: if it raises the light share of the frame by more than 5 points, or keeps less than 45% of the original edge contrast, the picture gets the photographic curve instead (`dim`) — darkened, never inverted — and is skipped outright when even that would leave it lighter |
| After the inversion the picture holds more light than before | Same rule, measured: the dark poster goes 10% → 66% light pixels; the dark strip of the legal footer goes 26% → 96% light and 32% → 57% mean, losing half its edge contrast | Both are now `dim` (0.22 mean, 0% light for the strip) or unchanged; the failure is caught by the before/after comparison, not by a class name |

Measured on the live frames of that article (extension off, frames read through `<source>`): photographs `photo/79…134`, mean 0.42→0.29 and light 0.33→0.04; the bright illustration `graphic/57`, 0.72→0.34 — it is still flipped, correctly. The dark banner `already-dark` is untouched, and the dark strip is `dim` (0.32→0.22, light 0.26→0.00).

`npm test` is 44/44: new fixtures `images/lazy.html` (a 1×1 `data:` stand-in with the frame in `<source>`, a dark lettering poster, a flat dark strip, and a bright control photograph), `poster-dark.png` and `strip-dark.png`.

## Known limits (1.2.4)

- The verdict of a flip is judged on a 160 px thumbnail; a picture whose light and dark areas swap their balance within that thumbnail can still be dimmed when a reader might have preferred the flip.
- A stand-in that is larger than 4 px (a blurred low-res placeholder, for instance) is still read as a picture.

## Known limits (1.2.3)

- A `<picture>` whose `<source>` children are added *after* the swap and point at a *different* picture is treated as a re-render and cleared; the frame stays the dark one. Recycling that swaps the picture through `<source>` alone is not followed.

## Known limits (1.2.2)

- A `.svg` picture is never converted: it is not decoded to pixels, and the page theme cannot recolour it either. Blog art delivered as SVG stays as drawn.
- A site whose dark theme is painted by the page but never announced can still be measured as light; the announced-signal watch only covers attributes and added nodes.
- A photograph with a large uniformly light region (an overcast sky, a white studio backdrop) keeps that region light: the soft photo curve compresses contrast instead of forcing a dark background.
- A CDN that requires credentials *and* answers a wildcard origin is unreadable from a content script; such hosts now land in `cross-origin` only after both attempts fail.
