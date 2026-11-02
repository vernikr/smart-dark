# Compact-page theme detection

## Finding

The supplied page contains a short, real confirmation paragraph, but the extension mirrored `reason: "not-ready"` and `detected: false`. The detector treated a body under 32 CSS pixels as unfinished without checking whether it already contained meaningful visible content. A second shallow-page guard could likewise defer a low-element-count page on a light canvas. The UI therefore had no factory-theme verdict for a normal, compact document.

## Change

Readiness now uses visible semantic text and distinct visible lines as evidence, rather than body height and element count alone. Short meaningful documents are measured; empty/loading shells remain deferred. The 19-pixel regression fixture reproduces the attached page's content and checks both the measured-light verdict and automatic theme application.

## Verification

- `npm run build` — passed; generated manifest and archive are version 1.2.7.
- `npm test` — 52/52 checks passed, including the 19-pixel compact-page regression and the late-theme shell tests.

## Release and local update

- Published [v1.2.7](https://github.com/vernikr/smart-dark/releases/tag/v1.2.7) with `smart-dark-1.2.7.zip` attached.
- Rebuilt the Mac checkout at `/Users/vernikr/Downloads/projects/smart-dark`; `dist/manifest.json` reports 1.2.7. Cleanly restarted Chrome so the unpacked extension loads the rebuilt files.
