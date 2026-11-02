import { chromium } from 'playwright';

const ext = '/Users/vernikr/Downloads/projects/smart-dark/dist';
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  colorScheme: 'dark',
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

let worker = ctx.serviceWorkers()[0];
if (!worker) {
  const boot = await ctx.newPage();
  await boot.goto('https://example.com', { timeout: 30000 }).catch(() => {});
  worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
  await boot.close();
}
if (!worker) {
  console.log('NO_SW');
  await ctx.close();
  process.exit(0);
}

await worker.evaluate((v) => chrome.storage.local.set(v), { darkSites: { 'youtube.com': true }, imageSites: {} });
const page = await ctx.newPage();
await page.goto('https://www.youtube.com/watch?v=jfKfPfyJRdk', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

const samples = [];
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(500);
  const sample = await page
    .evaluate(() => {
      const video = document.querySelector('video');
      let chain = 0;
      for (let node = video; node && node !== document.documentElement; node = node.parentElement) {
        if (getComputedStyle(node).filter !== 'none') chain += 1;
      }
      const raw = document.documentElement.dataset.sdState || '{}';
      return { video: !!video, chain, reason: JSON.parse(raw).reason || '-' };
    })
    .catch(() => null);
  if (sample) samples.push(`${sample.video ? 'V' : '-'}${sample.chain}${sample.reason === 'declared-dark' ? 'D' : ''}`);
}
console.log(samples.join(' '));
await ctx.close();
