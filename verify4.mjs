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
await worker.evaluate((v) => chrome.storage.local.set(v), { darkSites: {}, imageSites: { 'kiro.dev': true } });
const page = await ctx.newPage();
await page.goto('https://kiro.dev/blog/software-factory-stability/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2000);

const report = await page.evaluate(async () => {
  const rows = [];
  const frame = () => {
    const now = Math.round(performance.now());
    document.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 140) return;
      if (!(r.top < innerHeight && r.bottom > -600)) return;
      let row = rows.find((x) => x.el === img);
      if (!row) {
        row = { el: img, src: (img.currentSrc || '').slice(0, 30), box: `${Math.round(r.width)}x${Math.round(r.height)}`, first: now, darkAt: null };
        rows.push(row);
      }
      if (row.darkAt === null && ((img.currentSrc || '').startsWith('blob:') || img.dataset.sdSkip === 'already-dark')) row.darkAt = now;
    });
    if (rows.length < 40) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const height = document.documentElement.scrollHeight;
  for (let y = 0; y < height; y += 900) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 5000));
  return rows.map((row) => ({
    src: row.src,
    box: row.box,
    skip: row.el.dataset.sdSkip || '',
    pending: row.el.dataset.sdPending || '',
    dark: row.darkAt !== null,
    delay: row.darkAt === null ? -1 : row.darkAt - row.first,
    filter: getComputedStyle(row.el).filter,
  }));
});
console.log(JSON.stringify(report, null, 1));
console.log('ledger', await page.evaluate(() => document.documentElement.dataset.sdImages || 'none'));
await ctx.close();
