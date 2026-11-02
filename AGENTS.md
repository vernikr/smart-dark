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

## Release
`git tag v<version>` + GitHub release with the built zip attached; bump `package.json` and the manifest follows automatically at build time.
