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
- Images that fade in through CSS transitions are invisible at first observation; conversion retries a few times instead of dropping them.

## Detection pitfalls
- Sites announce their theme late: YouTube adds `<html dark>` only after its first paint. `detect()` in `src/content/content.js` therefore always re-runs before a render decision and lets a declared verdict (`declared-dark` / `declared-light`) override an earlier measured one; measurement is only the fallback until the site speaks.
- A single dark block (hero banner, sidebar) must not decide the verdict: `measure()` surveys the whole viewport plus a pool of text elements and weighs the verdict against the page canvas (`canvasVote()`). A light canvas needs a 75% dark page to flip, a dark canvas 34%.
- Colours are read from what an element actually paints: `backgroundColor` first, then `background-image` gradients, then the nearest painting ancestor, then text colour. A transparent `body` above a dark canvas is no longer read as a light site.
- Never measure page colours while our own Dark Reader stylesheet is active: `body` becomes our dark background and the site is misread as dark-themed. `withOwnThemeOff` in `src/content/detect.js` disables own sheets around every measurement.
- Compare owned backgrounds (`24,26,27` and friends) as a second guard for sites whose background stays transparent.

## Media that must never be filtered
`THEME.ignoreImageAnalysis` in `src/content/content.js` always contains `video, canvas, picture, iframe` and is merged with the per-site `ignore` list from `data/fixes.json`. Reason: Dark Reader's `INVERT` rules (for example `.html5-video-player` on YouTube) produce `selector > * { filter: invert(...) }`, and without the ignore list the rule lands on the `<video>` element and flips the clip. A test in `scripts/test.mjs` builds this case from `fixtures/video/` on purpose.

## Icons
`npm run icons` re-renders `assets/icons/*.png` from `moon.svg` through Chromium. ImageMagick's SVG delegate produces empty tiles, so never regenerate icons with `convert` alone.

## Release
`git tag v<version>` + GitHub release with the built zip attached; bump `package.json` and the manifest follows automatically at build time.
