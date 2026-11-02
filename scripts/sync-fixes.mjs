#!/usr/bin/env node
/** Fetches the Dark Reader sources needed for the fix lists into ./vendor/darkreader. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'vendor/darkreader');
const repo = 'https://github.com/darkreader/darkreader.git';

if (fs.existsSync(path.join(target, 'src/config'))) {
  console.log('[sync-fixes] fix lists already present');
  process.exit(0);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
try {
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', repo, target], { stdio: 'inherit' });
  execFileSync('git', ['-C', target, 'sparse-checkout', 'set', 'src/config', 'LICENSE'], { stdio: 'inherit' });
  console.log('[sync-fixes] done');
} catch (err) {
  console.error('[sync-fixes] failed, the prebuilt snapshot in dist-templates will be used:', err.message);
  process.exit(1);
}
