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
await page.waitForTimeout(8000);
console.log(JSON.stringify(await page.evaluate(() => {
  const hits = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = Array.from(sheet.cssRules); } catch { continue; }
    const walk = (list) => list.forEach((rule) => {
      if (rule.cssRules) walk(Array.from(rule.cssRules));
      if (rule.selectorText && /movie_player|html5-video-player/.test(rule.selectorText)) hits.push(rule.cssText.slice(0, 200));
    });
    walk(rules);
  }
  return { state: document.documentElement.dataset.sdState, hits: hits.slice(0, 6) };
}), null, 1));
await ctx.close();
