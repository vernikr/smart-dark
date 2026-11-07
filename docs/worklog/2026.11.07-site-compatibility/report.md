# Site compatibility follow-up

Issue: https://github.com/vernikr/smart-dark/issues/4
Base: PR #3 (fix/2-observation-image-lifecycle)

## Findings

- The active npm tab's theme control reads “Light mode — click for dark”, confirming that the user-facing page is in light mode. The older npm invert selectors in the bundled Dark Reader fix snapshot target legacy marketing-page assets and do not recolour the current settings surfaces.
- The Google Notebook docs HTML has body class color-scheme--light and loads Google Sans, Roboto and Material Icons. Its root/body signal is explicitly light; font-family declarations must remain untouched.
- The OpenAI Help article is a conventional light article surface.
- Mobilism's forum rows use phpBB-style class names such as darkrow1/darkrow2; these names must not be interpreted as a page-level dark declaration.
- Gmail's shell and message can be represented with a focused search input and a message table whose inline background declarations include important. The shared Dark Reader runtime recolours the mail banner when the inline-important background adapter is active.

## Change

While the site layer is enabled, install a narrowly targeted CSS rule for Gmail's accessible search field to disable its background transition. This prevents a light intermediate frame when the user enables darkening while the search field is focused. The rule is removed when the site layer is disabled.

The remaining reported page families use the shared Dark Reader 4.9.134 path and the general theme/typography fixes from PR #3; no stale per-site invert selectors or broad host-specific background overrides are added.

## Verification

The local compatibility fixtures cover phpBB/Mobilism row classes, Google Devsite typography, OpenAI Help article surfaces, npm settings header/cards, and Gmail focused search plus inline-important email banner. Screenshots and machine-readable results are stored in shots.

Live tabs were read through the connected browser context. Computed live-page styles could not be queried by the read-only browser connector; after the PRs are merged and the extension is reloaded, the five original pages still require a final visual check.

## Final verification

- npm run build — passed.
- npm test — 92/92 checks passed, 0 skipped.
- node --check — passed for content.js and test.mjs.
- git diff --check — passed.

The browser context confirmed the npm page's light-mode control and the Google Devsite light-scheme class. The Gmail message and search control were visible in the open tab. The connected browser interface is read-only and does not expose computed live-page CSS; the visual checks on the five original pages therefore remain a post-merge/reload step. No changes to the upstream site-fix snapshot were made: the local fixtures show that Dark Reader 4.9.134 already recolours the representative npm, Notebook, OpenAI Help and Gmail surfaces.

The final local run completed with 92/92 checks passing and no skips. It includes the new Gmail focus-state regression,
all five site-family fixtures, and the previous shared lifecycle, image, theme detection, YouTube and live Kiro checks.
