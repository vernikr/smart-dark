import { chromium } from 'playwright';
const ext = '/Users/vernikr/Downloads/projects/smart-dark/dist';
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, colorScheme: 'dark', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let w = ctx.serviceWorkers()[0];
if (!w) {
  const boot = await ctx.newPage();
  await boot.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  w = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  await boot.close();
}
if (!w) { console.log('NO_SW'); await ctx.close(); process.exit(0); }

await w.evaluate((v) => chrome.storage.local.set(v), { darkSites: { 'youtube.com': true }, imageSites: {} });
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/watch?v=jfKfPfyJRdk', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await yt.waitForTimeout(6000);
await yt.evaluate(() => window.scrollTo(0, 300)).catch(() => {});
await yt.waitForTimeout(4000);
console.log('YOUTUBE', JSON.stringify(await yt.evaluate(() => {
  const video = document.querySelector('video');
  if (!video) return { noVideo: true, title: document.title, body: document.body.innerText.slice(0, 50) };
  const chain = [];
  let n = video;
  while (n && n !== document.documentElement) { const f = getComputedStyle(n).filter; if (f && f !== 'none') chain.push(`${n.tagName.toLowerCase()}#${n.id || '-'} => ${f}`); n = n.parentElement; }
  return { state: document.documentElement.dataset.sdState, videoFilter: getComputedStyle(video).filter, chain };
})));

await w.evaluate((v) => chrome.storage.local.set(v), { darkSites: {}, imageSites: {} });
const k = await ctx.newPage();
await k.goto('https://kiro.dev/blog/software-factory-stability/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await k.waitForTimeout(2500);
const flicker = await k.evaluate(async () => {
  const isDark = (img) => (img.currentSrc || '').startsWith('blob:') || img.dataset.sdSkip === 'already-dark';
  const marks = new Map();
  let running = true;
  const frame = () => {
    if (!running) return;
    const now = Math.round(performance.now());
    document.querySelectorAll('img').forEach((img) => {
      if (!img.naturalWidth || img.naturalWidth < 260) return;
      const r = img.getBoundingClientRect();
      if (!(r.top < innerHeight && r.bottom > 0 && r.width > 200)) return;
      let e = marks.get(img);
      if (!e) { e = { at: now, darkAt: isDark(img) ? now : null }; marks.set(img, e); return; }
      if (e.darkAt === null && isDark(img)) e.darkAt = now;
    });
    requestAnimationFrame(frame);
  };
  frame();
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y < h; y += 900) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  await new Promise((r) => setTimeout(r, 5000));
  running = false;
  const seen = Array.from(marks.values());
  return { seen: seen.length, stillLight: seen.filter((e) => e.darkAt === null).length, delays: seen.map((e) => (e.darkAt === null ? 'never' : e.darkAt - e.at)) };
});
console.log('KIRO', JSON.stringify(flicker), 'ledger', await k.evaluate(() => document.documentElement.dataset.sdImages || 'none'));
await ctx.close();
