# Site compatibility follow-up

Issue: https://github.com/vernikr/smart-dark/issues/4
Base: main (PR #3 was merged before this follow-up)

## Findings

- The active npm tab's theme control reads “Light mode — click for dark”, confirming that the user-facing page is in light mode. The older npm invert selectors in the bundled Dark Reader fix snapshot target legacy marketing-page assets and do not recolour the current settings surfaces.
- The Google Notebook docs HTML has body class color-scheme--light and loads Google Sans, Roboto and Material Icons. Its root/body signal is explicitly light; font-family declarations must remain untouched.
- The OpenAI Help article is a conventional light article surface.
- Mobilism's forum rows use phpBB-style class names such as darkrow1/darkrow2; these names must not be interpreted as a page-level dark declaration.
- Gmail's shell and message can be represented with a focused search input and a message table whose inline background declarations include important. The shared Dark Reader runtime recolours the mail banner when the inline-important background adapter is active.

## Changes

- While the site layer is enabled, install a narrowly targeted CSS rule for Gmail's accessible search field to disable its background transition. This prevents a light intermediate frame when the user enables darkening while the search field is focused. The rule is removed when the site layer is disabled.
- Replace the embedded Dark Reader's default cross-origin rejection with a service-worker fetch bridge. The original extension messaging method is captured before Dark Reader wraps it; the service worker fetches public resources with credentials omitted, enforces a streaming 16 MiB response limit, and returns the bytes as a normal Response to Dark Reader.
- No legacy npm selectors or broad host-specific background overrides were added: the shared Dark Reader runtime handles the representative site surfaces in the local test matrix.

## Verification

The local compatibility fixtures cover phpBB/Mobilism row classes, Google Devsite typography, OpenAI Help article surfaces, npm settings header/cards, and Gmail focused search plus inline-important email banner. The service-worker bridge has direct tests for cross-origin image retrieval, cookie omission, and the streaming size limit. Screenshots and machine-readable results are stored in shots.

- npm run build — passed.
- npm test — 99/99 checks passed, 0 skipped (including four strict-CSP proxy checks).
- The live Kiro page used the new service-worker bridge for one cross-origin resource request; no fetch failures were recorded.
- node --check — passed for all changed JavaScript files.
- git diff --check — passed.

The local live-site smoke test was run in an isolated Chromium profile. Notebook and Meduza received the dark theme. npm and Mobilism were shown Cloudflare verification pages; OpenAI Help also served a verification shell; the unsigned Gmail session redirected to Google sign-in. These four pages could not be evaluated in their authenticated/live state by this isolated profile. The main Chrome visual pass was obstructed by a macOS screen-recording permission dialog; its screenshots were therefore not used as authoritative visual evidence.

The final fix packages Dark Reader's upstream MAIN-world proxy as a separate declarative content script at document_start. It is triggered through a DOM event from the isolated runtime, so the page never receives an injected inline script or external extension-origin script tag. A strict CSP fixture with script-src 'self' verifies that the proxy initializes exactly once, dynamically inserted CSSStyleSheet rules are recoloured, no proxy script element is inserted, and no inline-script violation is emitted.
