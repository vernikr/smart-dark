import { chromium } from 'playwright';

const ext = '/Users/vernikr/Downloads/projects/smart-dark/dist';
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, colorScheme: 'dark', viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let worker = ctx.serviceWorkers()[0];
if (!worker) {
  const boot = await ctx.newPage();
  await boot.goto('https://example.com', { timeout: 30000 }).catch(() => {});
  worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
  await boot.close();
}
await worker.evaluate((v) => chrome.storage.local.set(v), { darkSites: { 'youtube.com': true }, imageSites: {} });
const page = await ctx.newPage();
await page.goto('https://www.youtube.com/watch?v=jfKfPfyJRdk', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

const seen = [];
for (let i = 0; i < 16; i += 1) {
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => document.documentElement.dataset.sdState || '').catch(() => '');
  if (state && seen[seen.length - 1] !== state) seen.push(state);
}
console.log(seen.join('\n'));

const sheet = await page.evaluate(() => {
  const hits = [];
  for (const style of document.styleSheets) {
    let rules = [];
    try { rules = Array.from(style.cssRules); } catch { return 'blocked:' + style.href; }
    rules.forEach((rule) => {
      if (rule.selectorText && /\.html5-video-player/.test(rule.selectorText) && rule.style && rule.style.filter) hits.push(rule.cssText.slice(0, 160));
    });
  }
  return hits;
});
console.log('SHEET', JSON.stringify(sheet));
await ctx.close();
