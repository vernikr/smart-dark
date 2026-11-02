/** Capture the article body of a page for visual review. */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'dist');
const out = process.argv[3] || '/tmp/view.png';
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1300, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const url = process.argv[2];
const host = new URL(url).hostname.replace(/^www\./, '');
await worker.evaluate(async (h) => chrome.storage.local.set({ imageSites: { [h]: true }, darkSites: {} }), host);
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 200)); }
});
await page.waitForTimeout(4000);
const img = page.locator('article img, main img').filter({ hasNot: page.locator('[src*="wordmark" i]') });
const target = page.locator('img[data-sd-done]').first();
if (await target.count()) await target.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log('shot', out);
await context.close();
