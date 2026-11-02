# b01 — Update the checkout on the user's Mac to v1.2.0

## What is needed

The clone at `/Users/vernikr/Downloads/projects/smart-dark` still builds v1.1.0. The sandbox has no route to that machine, so the update has to be run there:

```
cd /Users/vernikr/Downloads/projects/smart-dark
git pull --ff-only                # brings in 49d0cf3, version 1.2.0
rm -rf scripts/__pycache__
npm install --ignore-scripts --no-audit --no-fund   # sandbox-independent; node_modules is not in the repo
npm run build                     # rebuilds dist/ from the new sources
grep '"version"' package.json     # expect 1.2.0
```

Then reload the unpacked extension from `…/smart-dark/dist` in `chrome://extensions`.

## Why it is a blocker

Every previous round reached the Mac through a bridge that is not available in this session (no local endpoint, no credentials). Nothing else is missing: the commit is on `main` and the release with `smart-dark-1.2.0.zip` is published.

## Resolved when

`git -C … rev-parse HEAD` shows `49d0cf3` and `dist/manifest.json` reports `1.2.0`.
