# Smart Dark — business logic

Every rule the extension follows, in one place: what it decides, on what evidence, and what it deliberately does not
do. Source of truth is the code; this document is the specification it is expected to match. If a rule below is not in
the code, that is a bug in the document; if a rule is in the code and not below, that is a bug in the change.

Files: `src/content/detect.js` (site theme detection), `src/content/content.js` (orchestration, Dark Reader, fixes),
`src/content/imagery.js` (image classification and re-toning), `src/popup/popup.js` (switches), `src/shared/common.js`
(settings model).

---

## 1. Product rules

1. **Two independent layers.** The *site layer* recolours the page. The *image layer* re-tones large pictures. They have
   separate per-site switches and neither implies the other: a site with its own dark theme is left alone but its
   pictures can still be re-toned.
2. **Unset means "auto".** A site without a saved value gets the automatic verdict. There are no global settings and no
   other options — only the two per-site switches in the toolbar popup.
3. **The user's explicit choice always wins.** `true` forces a layer on, `false` forces it off, and both are remembered
   for the site. `false` is stored, not "deleted", so an override survives later detection changes.
4. **Nothing is shipped to a server.** No analytics, no remote configuration; pictures are read and re-encoded inside the
   page and settings live in `storage.local`.
5. **A page is never made lighter than it was.** Every image rule below follows from this: when the honest result of a
   transformation would be more light than the original, the transformation is not applied.

---

## 2. Site layer

### 2.1 Detection (`detect.js`)

Detection answers one question: **does this site ship a dark theme of its own?** Two families of evidence, declared
first.

| Step | Evidence | Verdict |
| --- | --- | --- |
| 1 | `<meta name="color-scheme">` is exactly `dark` / `light` (`only dark` allowed) | `declared-dark` / `declared-light` |
| 2 | `<html>` or `<body>` attribute from the dark list (`dark`, `dark-mode`, `data-theme="dark"`, `data-scheme`, `night`, `color-scheme`, …) holds `''`, `true`, `1` or a dark scheme word | `declared-dark` |
| 3 | `<html>`/`<body>` class matches the dark word list (`dark`, `darkmode`, `dark-theme`, `night`, `theme-dark`, …) or the light list (`light`, `light-theme`, …) | `declared-dark` / `declared-light` |
| 4 | No body yet | `no-body` — nothing claimed, retried later |
| 5 | Body has no element children, or is under 32 px tall without substantive visible text | `not-ready` — nothing claimed, retried later |
| 6 | A shell: no more than 16 elements in the body, a light canvas, and no substantive visible text | `skeleton` — nothing claimed, retried later; the system preference is reported in the meantime |
| 7 | Measurement over the page | `measured-dark` / `measured-light` |

**Compact pages.** Geometry alone cannot distinguish an unfinished shell from a complete short document. Visible semantic text
(headings, paragraphs, list items, quotations, preformatted text and captions) of at least 12 characters is usable content;
otherwise distinct visible lines need 24 characters in total. Obvious loading placeholders do not count. Such content bypasses
both the short-body and shallow-shell guards, so a compact light page is measured instead of remaining unrecognised.

**Measurement.** The page is sampled at up to 4×4 points of the viewport plus up to 48 text elements (`h1, h2, p, li,
span, a, button`). For each sample the module takes, in order: the element's own opaque background colour, then the
average colour of a `background-image` gradient/`url()`, then the nearest painting ancestor (max 8 levels), then the
text colour. Lightness is relative luminance; above `0.6` is light, below `0.4` a text colour means a light site.

**Sample pool.** 4×4 viewport points and up to 48 text elements; when the page paints fewer than 6 votes that way (a
mail list is rows of `div`s, not paragraphs), painted containers (`div, td, section, article, aside, nav`) are sampled
too. `detect()` reports the number of votes as `samples` so a near-empty measurement can be recognised.

**Canvas vote.** The page canvas (`body`, else `html`) is the strongest single hint:

| Canvas | Share of dark samples needed to call the site dark |
| --- | --- |
| light | 75 % (a light canvas needs a near-unanimous dark page) |
| dark | 34 % (a dark canvas needs only a clear majority) |
| none painted | 55 % |

One dark hero banner or sidebar therefore cannot decide the verdict for the whole page.

**Guards.**
- Our own Dark Reader sheets are disabled around every measurement (`withOwnThemeOff`), otherwise `body` is measured as
  our dark background and every site reads as dark-themed.
- Colours we paint ourselves (`24,26,27`, `33,36,38`, `220,218,215`) are ignored as evidence.
- When the canvas is transparent all the way down, the verdict falls back to the text colour and to what the composited
  background would be (`rootFallsBackToLight`).
- `color-scheme: dark` on `<html>` counts as dark on its own.

### 2.2 Orchestration (`content.js`)

- **Declared beats measured, and a verdict can be revised.** Any `declared-*` verdict replaces a measured one at any
  time. A measured verdict may also replace an earlier measured one, for as long as the page has not been quiet for
  12 s (`REVISION_QUIET_MS`, driven by a MutationObserver on children, classes, styles and theme attributes). After
  that the measured verdict is final.
- **An unfinished page is never evidence.** `not-ready` and `skeleton` do not claim a verdict: the previous knowledge
  stands and the next render asks again. Reason: Gmail is an application shell that lays out before its dark surface
  exists, and a verdict taken at `not-ready` used to stick for the whole session — the popup said "сайт в светлом
  оформлении" on an account with the dark theme on.
- **The system preference is a hint, not a veto.** `prefers-color-scheme: dark` decides only the case where nothing can
  be measured (`skeleton`), never a page that can be measured.
- **Decision table** (`render()`):

| Saved value | Factory dark | Site layer |
| --- | --- | --- |
| unset | true | off (the site's own theme is already correct) |
| unset | false or unknown | on |
| `true` | any | on — forces the theme even over a native dark theme |
| `false` | any | off, stays light on later visits |

- **Re-render points.** On boot, again after 400 ms / 1.5 s / 3 s (late layout), on `load` if nothing was detected yet,
  and whenever the theme announcement changes (`class`, `dark`, `data-theme`, `data-mode`, `data-color-mode`,
  `data-scheme` on `<html>`/`<body>`, or new nodes) or a `<video>` appears or disappears.
- **Theme settings** (`THEME`): brightness/contrast 100, no grayscale or sepia, system font stack, Dark Reader's
  background/text pairs, system controls themed.

**Inline-important backgrounds.** Dark Reader can mark an element with `data-darkreader-inline-bgcolor` while its
stylesheet conversion still loses to the page's inline `background` or `background-color` declaration with
`!important`. For those marked elements only, the extension temporarily applies Dark Reader's resolved computed
background as inline `background-color: … !important`, so the marked card itself is recoloured. Before doing so it
saves the element's inline background-family declarations; when the theme is disabled, the marker disappears, or the
element is detached, it restores those declarations and removes only the temporary background override. This is generic
and does not target Gmail, message text, or specific selectors.

### 2.3 Fix lists and media safety

- Fix lists come from `data/fixes.json`, a compiled slice of Dark Reader's config, matched against the hostname
  (`*`, `*.example.com`, exact and sub-domain forms). Matching entries are merged into `invert` and `ignore` lists.
- **A site that declares its own dark theme gets no fix lists** (`fixesFor`): those rules are written for light
  layouts, and applying them on top of the site's own dark theme inverted the YouTube player and the clip with it. The
  `ignore` list is kept, because it only protects media.
- **With a `<video>` on the page, every media container** (`video`, `player`, `media` in a class/id selector) is dropped
  from the `invert` list, because `invert` on a player wrapper flips the clip.
- **Irreplaceable media is never recoloured.** `ignoreImageAnalysis` always contains `video, canvas, picture, iframe,
  .html5-video-player` and is merged with the per-site ignore list. Without it, a Dark Reader `INVERT` rule such as
  `.html5-video-player` lands on the `<video>` element and flips the clip.
- The applied theme is keyed on the effective fix list rather than on a yes/no flag, so a video mounting later
  re-applies the theme without the inverted wrapper.

---

## 3. Image layer

### 3.1 Which pictures are considered

Candidates are `<img>` elements seen by an `IntersectionObserver` with a `2400px` prefetch margin, plus every `<img>`
added later. A picture is processed when:

| Check | Rule | Skip reason |
| --- | --- | --- |
| Source | no source, `data:image/svg`, or an `.svg` URL | `vector` (SVG is never decoded or recoloured) |
| Lazy stand-in | element decodes to ≤ 4 px and a real frame is available in `<source srcset>` / parked sources / `srcset` | resolved from the frame, never read from the stand-in |
| Same stand-in, no frame | nothing to read | `placeholder` |
| Visibility | `display: none`, `visibility: hidden` or no box: retried up to 4 times, 700 ms apart | `not-visible` |
| Size | box (or `naturalWidth/Height`, or the parent's box as a fallback) with width ≥ 260 **and** height ≥ 140, **or** area ≥ 90 000 px² (`MIN_AREA`) | `small` |
| Own analysis | pictures matching the per-site `invert` list are treated as icons (the site's own artwork, not content) | — |
| Per-site `ignore` list | selector match | `ignore` |
| Already handled | this element + this URL was already claimed | `claimed` |
| Fetch | bitmap cannot be read (CDN refuses, 4xx, empty body) | `cross-origin`, `empty-body`, `http-<code>`, `fetch-failed` |
| Decode | the body arrived but is not a decodable image | `decode-failed` |
| Private blob not decoded yet | element is a `blob:` source that has not finished loading | `not-loaded` |
| Timeout | one picture takes longer than 10 s end to end (`IMAGE_TIMEOUT_MS`) | `timeout` |

Reading a bitmap: an anonymous request (`credentials: 'omit'`) first, then a credentialed one. Reason: hosts that answer
`Access-Control-Allow-Origin: *` reject any request carrying cookies, so the credentialed attempt alone failed on
habrastorage.org and every picture there stayed light. Private `blob:` URLs that cannot be fetched again are read from
the element itself.

Three conversions run at a time. Results are cached per `url + soft/auto`, so the same picture in several places is
converted once.

### 3.2 Classification (`classify`)

The picture is downsampled to 48×48 for luminance statistics and to a 40×40 colour grid (24-step buckets).

| Measure | Meaning |
| --- | --- |
| `opaque` | share of pixels with alpha ≥ 26 |
| `colors` | distinct colour buckets on the 40×40 grid |
| `midShare` | share of pixels with relative luminance in (0.2, 0.8) — the midtone mass |
| `lightShare` | share of pixels above 0.5 luminance |
| `meanLum` | mean relative luminance |

Verdict, in this order:

| Condition | Class | Why |
| --- | --- | --- |
| `opaque < 0.98` | `icon` | transparency means a logo or UI glyph, where hue and edge must survive |
| `colors ≤ 64` **or** `midShare < 0.18` | `graphic` | posterised art of a few brand colours, or a flat plate with no midtones — however bright |
| otherwise | `photo` | hundreds of colours across the grid |

### 3.3 Re-toning (`toneMap`)

The remap works in linear-light sRGB: source luminance selects a target luminance from a per-class curve, and the
RGB ratios are preserved, so hue and chroma stay (with a per-class saturation nudge). Fully transparent pixels are
untouched, so alpha is preserved.

| Class | Polarity | Target luminance band | Saturation |
| --- | --- | --- | --- |
| `graphic` | inverted (light art → dark band) | 0.135 … 0.880 | 1.20 |
| `photo` | unchanged, compressed | 0.060 … 0.640 | 1.06 |
| `icon` | unchanged, lifted | 0.300 … 0.880 | 1.10 |
| `dim` | unchanged, compressed | 0.060 … 0.640 | 1.06 |

A picture whose longest side exceeds 2200 px is scaled down for output.

### 3.4 Skip rules — when a picture is left exactly as it is

| Condition | Result |
| --- | --- |
| `lightShare < 0.25` (`< 0.08` for icons) | `already-dark` — less than a quarter of the frame is light |
| `photo` with `meanLum < 0.22` | `already-dark` |
| `graphic`/`icon` with `meanLum < 0.18` | `already-dark` |
| a stand-in of ≤ 4 px with no readable frame | `placeholder` |
| a picture whose re-toning was rejected as "worse" (below) | not touched at all |

### 3.5 The "did it get worse?" check

A flip can be technically correct and still ruin a picture: dark art with light lettering becomes a light page with dark
lettering, and a flat plate loses most of its edge contrast. So the result of a `graphic` flip is compared with the
original on a 160 px thumbnail:

| Measured on the result | Threshold | Consequence |
| --- | --- | --- |
| `lightShare` grows compared with the original | more than **5 percentage points** (`FLIP_LIGHT_WORSENS`) | the flip is rejected |
| edge contrast (mean horizontal luminance gradient) kept | less than **45 %** (`FLIP_CONTRAST_FLOOR`) | the flip is rejected |

A rejected flip falls back to the photographic curve and the picture is reported as **`dim`** — darkened, never
inverted. If even the dim leaves the picture lighter than the original (`lightShare` up again by more than 5 points), it
is skipped as `already-dark`. The same contrast floor also rejects a non-flip remap that flattened the picture.

Measured examples (live frames): a dark poster with cream lettering goes 10 % → 66 % light under a flip, and is `dim`
instead; a dark legal strip goes 26 % → 96 % light and loses half its contrast, also `dim`; a bright illustration
(72 % mean) is still flipped correctly, 0.72 → 0.34.

### 3.6 How the picture is replaced, and how it is put back

- The re-toned pixels become a PNG object URL assigned to `img.src`; a `filter: none !important` is set so the site
  layer cannot re-process our own result.
- **Responsive `<picture>`.** The frame a browser paints for a `<picture>` is chosen by its `<source srcset>` children,
  and that choice outranks `img.src`. The `srcset` of the element and the `srcset` of every `<source>` are cleared on
  swap and **parked in `data-sd-sources`** (never deleted), so turning the layer off restores the page exactly.
- **Re-renders.** If a framework puts `srcset` back after the swap, it is cleared again rather than accepted; a
  converted picture is held, not overwritten. Only a genuinely new URL on an element with no live `<source>` is handed
  back to the queue — paging recycles cards, so a new URL must still be converted.
- **Turning the layer off** (`stop`) disconnects the observers, restores every parked `srcset`/`<source>` and puts the
  original `src` back in place, without a reload.

### 3.7 Diagnostics (contract with tests and with support)

Every decision leaves a trace on the element and on `<html>`:

| Attribute | Content |
| --- | --- |
| `data-sd-done` | the verdict: `photo`, `graphic`, `icon`, `dim` |
| `data-sd-skip` | the skip reason from the tables above |
| `data-sd-info` | `<class>/<colors>/<midShare>/<opaque>` |
| `data-sd-source` | the URL that was converted |
| `data-sd-locked`, `data-sd-blob`, `data-sd-sources`, `data-sd-srcset` | internal bookkeeping for re-assert and restore |
| `html[data-sd-images]` | ledger `started/converted/{reasons}` |
| `html[data-sd-state]` | site layer: `factoryDark`, `detected`, `dark`, `reason`, `imageError`, `video`, `invertCount`, `styleKey` |

A light picture without a reason is a bug, not a policy: every skip must name itself.

---

## 4. Settings model (`common.js`, `popup.js`)

- Storage: `{ darkSites: { "<host>": boolean }, imageSites: { "<host>": boolean } }` in `storage.local`.
- The key is `location.hostname` with a leading `www.` removed; sub-domains are separate sites.
- Dark layer: unset → automatic verdict; `imageSites` unset → **on**.
- The popup reads the active tab, asks the content script for a live snapshot and paints:
  - status line — `оформление сайта не распознано` / `у сайта своя тёмная тема` / `тёмная тема включена` /
    `сайт в светлом оформлении`;
  - the re-check action appears only when a site with its own dark theme is being darkened by an override.
- Non-`http(s)` pages (the new-tab page, `chrome://`, the extension's own pages) show "страница недоступна" and no
  switches.

---

## 5. Deliberate non-goals

- No SVG recolouring: an SVG is not decoded to pixels, and the page theme does not recolour it either.
- No processing of small UI icons (below the size gate) and no attempt to detect "images" that are CSS backgrounds.
- No per-element or per-picture exceptions; the only scope of a decision is a whole site.
- No cross-frame work: the content script runs in the top frame only (`all_frames: false`).
- No settings sync, no profiles, no schedule; per-site switches only.

## 6. Known limits

- A photograph with a large uniformly light region (overcast sky, white studio backdrop) keeps that region light: the
  photo curve compresses contrast instead of forcing a dark background. Open product question, left to the user.
- A CDN that demands credentials **and** answers a wildcard origin cannot be read from a content script; such pictures
  land in `cross-origin` after both attempts.
- A stand-in larger than 4 px (a blurred low-resolution placeholder) is still read as a picture.
- The "did it get worse?" judgement is made on a 160 px thumbnail; a picture whose light and dark areas trade places at
  that size can still be dimmed where a flip was wanted.
- A `<picture>` that swaps to a *different* picture through `<source>` alone is treated as a re-render and keeps the
  dark frame.
- A site whose dark theme arrives later than 12 s after its last DOM change is measured as light and stays that way.
- A theme applied only through a stylesheet whose rules cannot be read from the content script (an opaque `<link>` the
  browser refuses to expose) cannot be classified as declared; measurement is the only route there.

## 7. How the rules are verified

`npm test` (`scripts/test.mjs`) runs the built extension in Chromium against local fixtures and live pages; 44 end-to-end
checks cover detection variants, the decision table, media safety, classification, the skip rules, the "worse" check,
`<picture>` sources, re-assert after a re-render, restore-on-off, and switch persistence. Screenshots and `results.json`
land in `docs/worklog/2026.11.02-smart-dark-extension/shots/`.

Each rule in this document is expected to have a check or a documented reason why it does not. The per-release history
of *why* a rule exists is in `docs/worklog/2026.11.02-smart-dark-extension/report.md`.
