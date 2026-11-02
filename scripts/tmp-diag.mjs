import { chromium } from 'playwright';
const ext = '/Users/vernikr/Downloads/projects/smart-dark/dist';
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, colorScheme: 'dark',
  viewport: { width: 1280, height: 860 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const w = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');

// --- YouTube with the site switch forced on ---
await w.evaluate((v) => chrome.storage.local.set(v), { darkSites: { 'youtube.com': true }, imageSites: {} });
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/watch?v=jfKfPfyJRdk', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await yt.waitForTimeout(9000);
console.log('YT', JSON.stringify(await yt.evaluate(() => {
  const video = document.querySelector('video');
  if (!video) return { noVideo: true, text: document.body.innerText.slice(0, 80) };
  const chain = [];
  let n = video;
  while (n && n !== document.documentElement) {
    const f = getComputedStyle(n).filter;
    if (f && f !== 'none') chain.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''} => ${f}`);
    n = n.parentElement;
  }
  const own = [video.style.filter, video.style.webkitFilter].filter(Boolean);
  return { state: document.documentElement.dataset.sdState, videoFilter: getComputedStyle(video).filter, inline: own, chain, poster: video.poster.slice(0, 40) };
}), null, 1));
await yt.screenshot({ path: '/Users/vernikr/Downloads/projects/smart-dark/tmp-yt.png' });

// --- kiro.dev: how long an image stays light after it enters the viewport ---
await w.evaluate((v) => chrome.storage.local.set(v), { darkSites: {}, imageSites: {} });
const k = await ctx.newPage();
await k.goto('https://kiro.dev/blog/software-factory-stability/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await k.waitForTimeout(2500);
console.log('KIRO', JSON.stringify(await k.evaluate(async () => {
  const marks = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting && !marks.has(e.target)) marks.set(e.target, performance.now()); });
  }, { rootMargin: '600px' });
  document.querySelectorAll('img').forEach((i) => io.observe(i));
  const height = document.documentElement.scrollHeight;
  for (let y = 0; y < height; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
  await new Promise((r) => setTimeout(r, 4000));
  return Array.from(document.images).map((i) => ({
    src: (i.currentSrc || i.src).slice(-30),
    done: i.dataset.sdDone || '', skip: i.dataset.sdSkip || '',
    visibleAt: marks.has(i) ? Math.round(marks.get(i)) : null,
    doneAt: i.dataset.sdDone ? null : undefined,
  }));
}), null, 1));
await ctx.close();
