# b01 — Update the checkout on the user's Mac to v1.2.0 (resolved)

## What is needed

The clone at `/Users/vernikr/Downloads/projects/smart-dark` still builds v1.1.0. The sandbox has no route to that machine in this session, so the update has to run there:

```
cd /Users/vernikr/Downloads/projects/smart-dark
git pull --ff-only
rm -rf scripts/__pycache__
npm install --ignore-scripts --no-audit --no-fund
npm run build
grep '"version"' package.json     # expect 1.2.0
```

Then reload the unpacked extension from `…/smart-dark/dist` in `chrome://extensions`.

## Why it is a blocker

Earlier rounds reached the Mac through a bridge that is not present now (no local endpoint, no credentials). Nothing else is missing: `main` and the tag `v1.2.0` are pushed, and the release carries `smart-dark-1.2.0.zip`.

## Resolved when

`git -C … rev-parse HEAD` reports `6465fcb` or newer and `dist/manifest.json` reports `1.2.0`.

## Resolution

Reached the machine through the Arena Bridge on the second attempt. `git pull --ff-only` moved the clone from `4bf6dff` to `d6afa64`, `npm run build` produced `dist/` (1.1 MB) with manifest `1.2.0` and `smart-dark-1.2.0.zip` (206 555 B), and `npm test` reported 32/32 checks passed after installing the Playwright Chromium build the fresh `node_modules` needed.
