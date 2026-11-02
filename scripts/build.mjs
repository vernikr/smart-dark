#!/usr/bin/env node
/**
 * Builds the unpacked extension into ./dist:
 *  - copies static assets (manifest, icons, darkreader runtime)
 *  - concatenates shared/content scripts in manifest order
 *  - compiles the fixes subset from the vendored Dark Reader tree
 *  - packages a zip for distribution
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const vendorFixes = path.join(root, 'vendor', 'darkreader');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const log = (...args) => console.log('[build]', ...args);

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** Parses a Dark Reader fixes config into [{urls, invert, ignore}]. */
function parseFixes(text) {
  const blocks = text.replace(/\r/g, '').split(/^\s*={2,}\s*$/gm);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const commandIndices = [];
    lines.forEach((line, i) => {
      if (/^[A-Z]+(\s[A-Z]+){0,2}$/.test(line)) commandIndices.push(i);
    });
    if (!commandIndices.length) continue;
    const urls = lines.slice(0, commandIndices[0]).join('\n').split('\n').map((s) => s.trim()).filter(Boolean);
    const entry = { urls, invert: [], ignore: [] };
    commandIndices.forEach((index, i) => {
      const command = lines[index].trim();
      const body = lines.slice(index + 1, i === commandIndices.length - 1 ? lines.length : commandIndices[i + 1]);
      const values = body.map((s) => s.trim()).filter(Boolean);
      if (command === 'INVERT') entry.invert.push(...values);
      if (command === 'IGNORE IMAGE ANALYSIS') entry.ignore.push(...values);
    });
    entries.push(entry);
  }
  return entries;
}

function buildFixes() {
  const dynamic = path.join(vendorFixes, 'src/config/dynamic-theme-fixes.config');
  const invert = path.join(vendorFixes, 'src/config/inversion-fixes.config');
  if (!fs.existsSync(dynamic) || !fs.existsSync(invert)) {
    const fallback = path.join(root, 'dist-templates/fixes.json');
    if (fs.existsSync(fallback)) {
      fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
      fs.copyFileSync(fallback, path.join(dist, 'data/fixes.json'));
      log('fixes: copied prebuilt snapshot (vendored Dark Reader tree is absent)');
      return;
    }
    throw new Error('missing Dark Reader fix lists; run `npm run sync-fixes` first');
  }
  const out = {};
  const push = (key, entry) => {
    const target = out[key] || (out[key] = { invert: [], ignore: [] });
    entry.invert.forEach((sel) => target.invert.includes(sel) || target.invert.push(sel));
    entry.ignore.forEach((sel) => target.ignore.includes(sel) || target.ignore.push(sel));
  };

  if (fs.existsSync(dynamic)) {
    for (const entry of parseFixes(fs.readFileSync(dynamic, 'utf8'))) {
      if (!entry.urls.length) continue;
      if (entry.urls.includes('*')) continue;
      if (!entry.invert.length && !entry.ignore.length) continue;
      for (const url of entry.urls) push(url, entry);
    }
  }
  if (fs.existsSync(invert)) {
    for (const entry of parseFixes(fs.readFileSync(invert, 'utf8'))) {
      if (entry.urls.includes('*')) continue;
      for (const url of entry.urls) push(url, entry);
    }
  }

  const sorted = {};
  Object.keys(out).sort().forEach((key) => {
    sorted[key] = { invert: out[key].invert, ignore: out[key].ignore };
  });
  const target = path.join(dist, 'data/fixes.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(sorted));
  const size = (fs.statSync(target).size / 1024).toFixed(0);
  log(`fixes: ${Object.keys(sorted).length} entries, ${size} KB`);
  const snapshot = path.join(root, 'dist-templates/fixes.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.copyFileSync(target, snapshot);
}

function buildDarkReader() {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const entry = requireFromRoot.resolve('darkreader');
  const file = entry.endsWith('.mjs') ? path.join(path.dirname(entry), 'darkreader.js') : entry;
  copy(file, path.join(dist, 'lib/darkreader.js'));
  log('darkreader runtime copied');
}

function buildManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  manifest.name = pkg.displayName || manifest.name;
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`manifest v${manifest.version}`);
}

function buildScripts() {
  const files = [
    ['src/shared/common.js', 'common.js'],
    ['src/content/detect.js', 'detect.js'],
    ['src/content/imagery.js', 'imagery.js'],
    ['src/content/content.js', 'content.js'],
    ['src/background/bg.js', 'bg.js'],
  ];
  for (const [from, to] of files) copy(path.join(root, from), path.join(dist, to));
  log('scripts copied');
}

function buildPopup() {
  for (const file of ['popup.html', 'popup.css', 'popup.js']) {
    copy(path.join(root, 'src/popup', file), path.join(dist, file));
  }
  log('popup copied');
}

function buildIcons() {
  for (const size of [16, 32, 48, 128]) {
    copy(path.join(root, `assets/icons/icon-${size}.png`), path.join(dist, `icons/icon-${size}.png`));
  }
  log('icons copied');
}

function packageZip() {
  const zip = path.join(root, `smart-dark-${pkg.version}.zip`);
  fs.rmSync(zip, { force: true });
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dist });
    log(`packaged ${path.basename(zip)}`);
  } catch (err) {
    log('zip skipped:', err.message.split('\n')[0]);
  }
}

rimraf(dist);
fs.mkdirSync(dist, { recursive: true });
buildManifest();
buildScripts();
buildPopup();
buildIcons();
buildDarkReader();
buildFixes();
if (!process.argv.includes('--no-zip')) packageZip();
log('done ->', path.relative(root, dist));
