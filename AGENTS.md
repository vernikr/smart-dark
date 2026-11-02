# Project notes

## Commands
- `npm install` — dependencies (Playwright Chromium is already provisioned in the sandbox).
- `npm run build` — builds `dist/` and `smart-dark-<version>.zip`. Fix lists come from `vendor/darkreader` when present, otherwise from `dist-templates/fixes.json`.
- `npm run sync-fixes` — sparse clone of the Dark Reader config tree.
- `npm test` — Chromium end-to-end suite over `fixtures/` plus the reference page; writes screenshots and `results.json` to the worklog folder. Exits non-zero on failure.
- `npm run shot -- <url> <out.png>` — visual check of a single page.

## Environment facts worth remembering
- Extension E2E requires `channel: 'chromium'` in Playwright; the bundled headless shell cannot load extensions.
- Content scripts run in an isolated world: pages and Playwright `page.evaluate` cannot see their globals. The site state mirror is the `data-sd-state` attribute on `<html>`.
- A freshly installed extension may miss the first document of a session; tests warm it up once before asserting.
- Pages with their own scroll container ignore `window.scrollTo`; the reusable helper in `scripts/test.mjs` sets `scrollTop` on `documentElement` and `body` as well.
- Images that fade in through CSS transitions used to be postponed until the transition ended, which is exactly when the light original is on screen. A transparent image is a candidate; only `display: none`, `visibility: hidden` and a missing box postpone it, and retries are bounded.
- A grid cell can be laid out after its image mounts, so an image may report a `0x0` box while its parent already has the final size. Size guesses fall back to the parent (`fallbackBox()` in `src/content/imagery.js`).
- `html[data-sd-images="started/converted/{reasons}"]` is the ledger: every skip carries a reason (`small`, `vector`, `already-dark`, `not-visible`, `claimed`, `ignore`, `placeholder`, `not-loaded`, `timeout`, `empty`, `decode-failed`, `empty-body`, `cross-origin`, `http-<code>`, `fetch-failed`). A light picture without a reason is a bug, not a policy.
- The whole rule set (detection thresholds, decision tables, skip reasons, non-goals) is specified in `docs/BUSINESS-LOGIC.md`. Change a rule → change that file in the same commit; a rule that is in the code and not in the document is an unfinished change.

## Detection pitfalls
- Sites announce their theme late: YouTube adds `<html dark>` only after its first paint. `detect()` in `src/content/content.js` therefore always re-runs before a render decision and lets a declared verdict (`declared-dark` / `declared-light`) override an earlier measured one; measurement is only the fallback until the site speaks.
- A single dark block (hero banner, sidebar) must not decide the verdict: `measure()` surveys the whole viewport plus a pool of text elements and weighs the verdict against the page canvas (`canvasVote()`). A light canvas needs a 75% dark page to flip, a dark canvas 34%.
- Colours are read from what an element actually paints: `backgroundColor` first, then `background-image` gradients, then the nearest painting ancestor, then text colour. A transparent `body` above a dark canvas is no longer read as a light site.
- Never measure page colours while our own Dark Reader stylesheet is active: `body` becomes our dark background and the site is misread as dark-themed. `withOwnThemeOff` in `src/content/detect.js` disables own sheets around every measurement.
- Compare owned backgrounds (`24,26,27` and friends) as a second guard for sites whose background stays transparent.

## Fix lists on pages that are already dark
`data/fixes.json` is a slice of Dark Reader's config, written for sites that ship a light layout. Applying it to a page our own theme darkened inverted the YouTube player wrapper and the clip with it. Two guards in `src/content/content.js`: `fixesFor()` drops the whole list when the site declares its own dark theme, and `invertSelectors()` drops every media container (`video`, `player`, `media` in the selector) while the document holds a `<video>`. `applyTheme()` keys on the applied list rather than on a yes/no flag, so a video mounting later re-applies the theme without it.

## Lazy stand-ins and responsive `<picture>`
A lazy loader can park a 1×1 transparent GIF in `img.src` while the real frame sits in a `<source srcset>`. Reading the element then means reading one pixel: `classify()` called it `graphic/1/0.00`, the layer swapped in a darkened stand-in and cleared the `<source>` children — meduza.io articles showed nothing. `process()` therefore resolves the frame from `parkedFrames()` → `pictureFrames()` → `srcsetFrames()` whenever the element decodes to 4 px or less, and `build()` refuses a stand-in outright (`sdSkip=placeholder`). The `<source>` values are parked in `data-sd-sources`, never deleted, so `restore()` puts the page back exactly; a re-render that returns `srcset` is cleared again by `holdOwn()`.

## When a transformation is rejected as "worse"
A polarity flip is not automatically an improvement. `build()` compares the result with the original on a 160 px thumbnail (`thumbnailStats()`): a flip that raises the light share by more than 5 points, or keeps less than 45 % of the edge contrast, is replaced by the photographic curve and reported as `dim`. This is what keeps dark art with light lettering and flat dark banners from turning into light pages. Do not "fix" a `dim` verdict by widening the class threshold — the threshold describes the picture, this check describes the result.

## Media that must never be filtered
`THEME.ignoreImageAnalysis` in `src/content/content.js` always contains `video, canvas, picture, iframe` and is merged with the per-site `ignore` list from `data/fixes.json`. Reason: Dark Reader's `INVERT` rules (for example `.html5-video-player` on YouTube) produce `selector > * { filter: invert(...) }`, and without the ignore list the rule lands on the `<video>` element and flips the clip. A test in `scripts/test.mjs` builds this case from `fixtures/video/` on purpose.

## Icons
`npm run icons` re-renders `assets/icons/*.png` from `moon.svg` through Chromium. ImageMagick's SVG delegate produces empty tiles, so never regenerate icons with `convert` alone.

## Updating the installed copy on the user's Mac
An unpacked extension is read from disk only when Chrome loads it, so rebuilding `dist/` changes nothing until the extension reloads. On macOS the reload button on `chrome://extensions` cannot be triggered from the keyboard without driving the UI, so the practical route is a full restart: `osascript -e 'tell application "Google Chrome" to quit'`, wait for the process to exit, then `open -na "Google Chrome"` — the session comes back with `restore_on_startup` unset because Chrome records a clean shutdown.

Chrome only opens a DevTools port when it is the one starting the process: launching with `--remote-debugging-port=9222` while a normal instance runs just forwards the URL to that instance, and adding `--user-data-dir` starts a separate profile instead. Both were tried. Without CDP, the bridge's `mac_see` / `mac_click` (with foreground consent) are the tools that can look at the window; a toolbar icon can be read from a screenshot crop, but not its version.

## Release
`git tag v<version>` + GitHub release with the built zip attached; bump `package.json` and the manifest follows automatically at build time. The zip lands in the repository root (`smart-dark-<version>.zip`), not in `dist/`. `gh` is not installed in the sandbox: create the release with `POST /repos/.../releases` and attach the zip with `POST https://uploads.github.com/repos/.../releases/<id>/assets?name=<file>`. The Mac checkout drifts when artifacts are committed (modified screenshots block `git pull`); sync it with `git fetch && git reset --hard origin/main`, which is safe now that it holds nothing unique.
