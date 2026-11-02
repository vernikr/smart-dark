/** Serves the local fixture, lets the extension convert it, and screenshots the result. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs/worklog/2026.11.02-smart-dark-extension/fixture');
const ext = path.join(root, 'dist');
const out = process.argv[2] || '/tmp/fixture-shot.png';

const server = http.createServer((req, res) => {
  const file = path.join(dir, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404).end('nope'); return; }
  const type = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 900, height: 1200 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
await worker.evaluate(async () => chrome.storage.local.set({ imageSites: { '127.0.0.1': true }, darkSites: {} }));
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(7000);
const state = await page.evaluate(() => JSON.parse(document.documentElement.dataset.sdState));
const images = await page.evaluate(() => Array.from(document.images).map((i) => ({ src: i.src.slice(0, 42), done: i.dataset.sdDone || '', info: i.dataset.sdInfo || '', skip: i.dataset.sdSkip || '' })));
console.log(JSON.stringify({ state, images }));
await page.screenshot({ path: out, fullPage: true });
await context.close();
server.close();
