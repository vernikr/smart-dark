# DOM observation and image-processing lifecycle

Issue: https://github.com/vernikr/smart-dark/issues/2

## Scope

- Coalesce theme review work and ignore unrelated feed mutations.
- Keep root and body theme announcements observable without registering competing observers on the same node.
- Make image fetch/decode cancellable and prevent late writes after the layer is stopped.
- Downscale large images before the pixel-remapping loop.
- Bound transformed-image cache entries and release temporary object URLs.
- Restore the original image attributes and inline filter exactly.

## Regression coverage

- Unrelated DOM churn does not increase the full theme-detection counter.
- Root data-theme/data-color-mode values, body theme class/data-dark flags and a dynamically added color-scheme meta are detected.
- A 2800 px input is transformed to an output with a maximum side of 2200 px.
- Turning image conversion off during a delayed fetch prevents a late blob assignment.
- src, picture source srcset, sizes, and inline filter important are restored.

## Verification

Baseline before implementation: npm test — 56/56 checks passed.

Unavailable live sites are reported as skipped checks rather than product failures. Local fixture checks remain mandatory.

## Final verification

- npm run build — passed; generated the extension package.
- npm test — 72/72 checks passed, 0 skipped in the final run.
- node --check — passed for the changed JavaScript files.
- git diff --check — passed.

The final E2E run included the Kiro live-site integration and all local regression fixtures. When that external site is
unreachable in a future run, the optional integration is reported as SKIP.
