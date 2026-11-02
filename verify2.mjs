import { chromium } from 'playwright';
const ext = '/Users/vernikr/Downloads/projects/smart-dark/dist';
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, colorScheme: 'dark', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let w = ctx.serviceWorkers()[0];
if (!w) { const b = await ctx.newPage(); await b.goto('https://example.com', { timeout: 30000 }).catch(() => {}); w = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null); await b.close(); }
await w.evaluate((v) => chrome.storage.local.set(v), { darkSites: { 'youtube.com': true }, imageSites: {} });
const p = await ctx.newPage();
await p.goto('https://www.youtube.com/watch?v=jfKfPfyJRdk', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
const samples = [];
for (let i = 0; i < 20; i++) {
  await p.waitForTimeout(500);
  samples.push(await p.evaluate(() => {
    const video = document.querySelector('video');
    let chain = 0;
    for (let n = video; n && n !== document.documentElement; n = n.parentElement) if (getComputedStyle(n).filter !== 'none') chain++;
    return { video: !!video, chain, reason: document.documentElement.dataset.sdState },
  }).catch(() => null));
}
console.log(JSON.stringify(samples.filter(Boolean).map((s) => `${s.video ? 'V' : '-'}${s.chain}`)));
await ctx.close();
