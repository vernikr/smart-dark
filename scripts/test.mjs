/**
 * End-to-end suite: loads the built extension in Chromium and checks detection,
 * theme toggles, persistence and image conversion on local fixtures and live sites.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'dist');
const fixtures = path.join(root, 'fixtures');
const shots = path.join(root, 'docs/worklog/2026.11.02-smart-dark-extension/shots');
fs.mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

let corsPort = 0;

function serve() {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(fixtures, clean.endsWith('/') ? path.join(clean, 'index.html') : clean);
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.html') && body.includes('__CORS__')) body = body.toString('utf8').replace('__CORS__', String(corsPort));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* A second origin that answers `Access-Control-Allow-Origin: *`, the way habrastorage and fbcdn do. A request that
   carries cookies is rejected by the browser against such a header, so this server is what catches that mistake. */
function serveCdn() {
  const server = http.createServer((req, res) => {
    const file = path.join(fixtures, 'images', path.basename(decodeURIComponent(req.url.split('?')[0])));
    if (!file.startsWith(fixtures) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'access-control-allow-origin': '*',
    }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    corsPort = server.address().port;
    resolve(server);
  }));
}

const scrollThrough = async (page) => {
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' }).catch(() => {});
  await page.evaluate(async () => {
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 400) {
      window.scrollTo(0, y);
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y;
      await new Promise((r) => setTimeout(r, 220));
    }
  });
};

const state = (page) => page.evaluate(() => {
  const raw = document.documentElement.dataset.sdState;
  return raw ? JSON.parse(raw) : null;
});

async function waitFor(page, predicate, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await page.evaluate(predicate);
    if (value) return value;
    await page.waitForTimeout(300);
  }
  return null;
}

async function main() {
  const cdn = await serveCdn();
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 1100 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = worker.url().split('/')[2];
  const setStorage = (value) => worker.evaluate((v) => chrome.storage.local.set(v), value);

  // 0. warm-up: the first document after a fresh install can miss the content script
  const warmup = await context.newPage();
  await warmup.goto(`${base}/light/`, { waitUntil: 'load' });
  await waitFor(warmup, () => document.documentElement.dataset.sdState !== undefined, 8000);
  await warmup.reload({ waitUntil: 'load' });
  await waitFor(warmup, () => document.documentElement.dataset.sdState !== undefined, 8000);
  await warmup.close();

  // 1. factory dark detection on well-known variants
  for (const [slug, expected, label] of [
    ['light', false, 'light page'],
    ['dark-attribute', true, 'data-theme dark page'],
    ['dark-body-class', true, 'body.dark page'],
    ['dark-painted', true, 'page whose dark canvas is painted by gradients'],
    ['dark-media', false, 'page with a dark hero only'],
  ]) {
    await setStorage({ darkSites: {}, imageSites: {} });
    const page = await context.newPage();
    await page.goto(`${base}/${slug}/`, { waitUntil: 'load' });
    const info = await waitFor(page, () => (document.documentElement.dataset.sdState ? JSON.parse(document.documentElement.dataset.sdState) : null));
    check(`detection: ${label}`, info && info.factoryDark === expected, JSON.stringify(info));
    if (slug === 'light') {
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('detection: light page gets the theme without manual action', info && info.dark === true, bg);
      await page.screenshot({ path: path.join(shots, '10-light-fixture.png') });
    }
    if (slug === 'dark-media') {
      await page.screenshot({ path: path.join(shots, '11-dark-hero.png') });
    }
    await page.close();
  }

  // 2. live site with its own dark theme
  await setStorage({ darkSites: {}, imageSites: {} });
  const kiro = await context.newPage();
  await kiro.goto('https://kiro.dev/blog/software-factory-stability/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (kiro.url().includes('kiro.dev')) {
    const info = await waitFor(kiro, () => (document.documentElement.dataset.sdState ? JSON.parse(document.documentElement.dataset.sdState) : null));
    check('live: native dark blog detected', info && info.factoryDark === true, JSON.stringify(info));
    check('live: theme stays off on native dark blog', info && info.dark === false);
  } else {
    check('live: native dark blog detected', false, 'site unreachable from the sandbox');
  }

  // 2b. a light page reached through a challenge screen must not be read as dark
  await setStorage({ darkSites: {}, imageSites: {} });
  const arena = await context.newPage();
  await arena.goto('https://arena.ai', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (arena.url().includes('arena.ai')) {
    const probe = await waitFor(arena, () => {
      const state = document.documentElement.dataset.sdState;
      return state ? { state: JSON.parse(state), title: document.title, body: document.body.innerText.slice(0, 40) } : null;
    });
    const challenge = /security verification|just a moment|verifying/i.test(`${probe.title} ${probe.body}`);
    console.log('arena probe:', JSON.stringify(probe));
    if (challenge) {
      check('arena.ai: light challenge page is not mistaken for a dark theme', probe.state.factoryDark === false && probe.state.dark === true, JSON.stringify(probe.state));
    } else {
      const bodyBg = await arena.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check('arena.ai: detection matches the real page', typeof probe.state.factoryDark === 'boolean', `${probe.state.factoryDark} | ${bodyBg}`);
    }
    await arena.screenshot({ path: path.join(shots, '16-arena.png') });
  }
  await arena.close();

  // 3. image conversion on the same native dark site
  await setStorage({ darkSites: {}, imageSites: {} });
  if (kiro.url().includes('kiro.dev')) {
    await kiro.reload({ waitUntil: 'domcontentloaded' });
    await scrollThrough(kiro);
    await kiro.waitForTimeout(1500);
    await scrollThrough(kiro);
    const diagnostics = await kiro.evaluate(() => Array.from(document.images).map((i) => ({
      src: (i.currentSrc || i.src).slice(-24), tracked: i.dataset.sdTracked || '', queued: i.dataset.sdQueued || '',
      done: i.dataset.sdDone || '', skip: i.dataset.sdSkip || '',
      box: `${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`,
    })));
    await kiro.waitForTimeout(6000);
    const ledger = await waitFor(kiro, () => {
      const raw = document.documentElement.dataset.sdImages;
      if (!raw) return null;
      const [started, converted, reasons] = raw.split('/');
      return Number(converted) >= 1 ? { started: Number(started), converted: Number(converted), reasons: JSON.parse(reasons) } : null;
    }, 30000);
    check('live: article diagrams converted on a native dark site', !!ledger, ledger ? JSON.stringify(ledger) : 'no conversion');
    // Every skip must be a deliberate decision, never a breakdown: small and vector pictures are not candidates at all.
    const DELIBERATE = ['already-dark', 'small', 'vector', 'ignore'];
    const broken = diagnostics.filter((d) => d.skip && !DELIBERATE.includes(d.skip));
    check('live: no image left in a failed state', !broken.length, JSON.stringify(broken));
    check('live: every skipped image says why', diagnostics.every((d) => !d.skip || DELIBERATE.includes(d.skip)), JSON.stringify(diagnostics.filter((d) => d.skip).map((d) => d.skip)));
    const firstConverted = kiro.locator('img[data-sd-done]').first();
    if (await firstConverted.count()) {
      await firstConverted.scrollIntoViewIfNeeded();
      await kiro.waitForTimeout(700);
      await kiro.screenshot({ path: path.join(shots, '12-kiro-images.png') });
    }
  }

  // 3b. a real YouTube page saved to disk: the site announces its dark theme only after the first paint
  await setStorage({ darkSites: {}, imageSites: {} });
  const yt = await context.newPage();
  await yt.goto(`${base}/youtube/clip.html`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (yt.url().includes('youtube/clip.html')) {
    const ytState = await waitFor(yt, () => {
      const raw = document.documentElement.dataset.sdState;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed.reason === 'declared-dark' ? parsed : null;
    });
    check('youtube: the dark theme announced on <html> is picked up', !!ytState && ytState.factoryDark === true, JSON.stringify(ytState));
    check('youtube: no layer of our theme is painted over the page', !!ytState && ytState.dark === false, JSON.stringify(ytState));
    const ytFilters = await yt.evaluate(() => {
      const video = document.querySelector('video');
      const player = document.querySelector('.html5-video-player');
      let chain = 0;
      for (let node = video; node && node !== document.documentElement; node = node.parentElement) {
        if (getComputedStyle(node).filter !== 'none') chain++;
      }
      return {
        video: video ? getComputedStyle(video).filter : 'none',
        player: player ? getComputedStyle(player).filter : 'none',
        chain,
      };
    });
    check('youtube: the clip is never inverted', ytFilters.video === 'none' && ytFilters.player === 'none', JSON.stringify(ytFilters));
    check('youtube: no container filter reaches the video', ytFilters.chain === 0, JSON.stringify(ytFilters));
  }
  await yt.close();

  // 4. image classes on the fixture
  await setStorage({ darkSites: {}, imageSites: {} });
  const images = await context.newPage();
  await images.goto(`${base}/images/`, { waitUntil: 'load' });
  await scrollThrough(images);
  const classes = await waitFor(images, () => {
    const done = Array.from(document.images).filter((i) => i.dataset.sdDone);
    return done.length >= 3 ? done.map((i) => ({ kind: i.dataset.sdDone, info: i.dataset.sdInfo })) : null;
  }, 30000);
  const kinds = classes ? classes.map((c) => c.kind) : [];
  check('images: photo, diagrams and logo classified separately', kinds.includes('photo') && kinds.filter((k) => k === 'graphic').length === 3, JSON.stringify(kinds));
  check('images: transparent logo treated as an icon', kinds.includes('icon'), JSON.stringify(kinds));

  const pixels = await images.evaluate(() => Array.from(document.images).filter((i) => i.dataset.sdDone).map((img) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, Math.min(300, canvas.height)).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      count++;
    }
    return { kind: img.dataset.sdDone, mean: Math.round(sum / count), alpha: ctx.getImageData(0, 0, 4, 4).data[3] };
  }));
  const photo = pixels.find((p) => p.kind === 'photo');
  const graphic = pixels.find((p) => p.kind === 'graphic');
  const icon = pixels.find((p) => p.kind === 'icon');
  check('images: photo keeps midtone range', photo && photo.mean > 80 && photo.mean < 165, JSON.stringify(photo));
  check('images: diagram background moved into the dark band', graphic && graphic.mean < 70, JSON.stringify(graphic));
  check('images: icon transparency preserved', icon && icon.alpha === 0, JSON.stringify(icon));
  const darkSkip = await images.evaluate(() => {
    const img = Array.from(document.images).find((i) => (i.currentSrc || i.src).includes('dark-photo'));
    return img ? { skip: img.dataset.sdSkip || '', done: img.dataset.sdDone || '', source: img.dataset.sdSource || '' } : null;
  });
  check('images: an already dark photo is left alone', !!darkSkip && darkSkip.skip === 'already-dark' && !darkSkip.source, JSON.stringify(darkSkip));

  // 4a. a CDN that allows any origin but not credentials: the bitmap must still be readable
  const cdnPage = await context.newPage();
  await cdnPage.goto(`${base}/images/cors.html`, { waitUntil: 'load' });
  await scrollThrough(cdnPage);
  const cdnResult = await waitFor(cdnPage, () => {
    const img = document.querySelector('img');
    if (!img) return null;
    if (img.dataset.sdDone) return { done: img.dataset.sdDone, info: img.dataset.sdInfo || '' };
    if (img.dataset.sdSkip) return { skip: img.dataset.sdSkip };
    return null;
  }, 30000);
  check('images: a permissive CDN is read without credentials', !!cdnResult && cdnResult.done === 'graphic' && !cdnResult.skip, JSON.stringify(cdnResult));
  await cdnPage.close();

  // 4a2. a <picture> picks its frame from <source srcset>, which outranks the swapped img src
  const picPage = await context.newPage();
  await picPage.goto(`${base}/images/picture.html`, { waitUntil: 'load' });
  await scrollThrough(picPage);
  const picResult = await waitFor(picPage, () => {
    const img = document.querySelector('img[data-picture]');
    if (!img) return null;
    if (img.dataset.sdDone) {
      const shown = img.currentSrc || '';
      return { done: img.dataset.sdDone, shown: shown.startsWith('blob:') ? 'blob' : shown, parked: img.dataset.sdSources || '' };
    }
    return img.dataset.sdSkip ? { skip: img.dataset.sdSkip } : null;
  }, 30000);
  check('images: a <picture> shows the dark frame, not the original source', !!picResult && picResult.done === 'graphic' && picResult.shown === 'blob' && !!picResult.parked, JSON.stringify(picResult));
  // Turning images off for the origin makes the content script restore the page, sources included.
  await setStorage({ darkSites: {}, imageSites: { '127.0.0.1': false } });
  const picRestored = await waitFor(picPage, () => {
    const img = document.querySelector('img[data-picture]');
    const source = img.closest('picture').querySelector('source');
    if (source.hasAttribute('srcset')) {
      return { srcset: true, src: (img.getAttribute('src') || '').replace(location.origin, ''), marker: !!img.dataset.sdSources };
    }
    return null;
  }, 15000) || await picPage.evaluate(() => {
    const img = document.querySelector('img[data-picture]');
    const source = img.closest('picture').querySelector('source');
    return { srcset: source.hasAttribute('srcset'), src: (img.getAttribute('src') || '').replace(location.origin, ''), marker: !!img.dataset.sdSources };
  });
  await setStorage({ darkSites: {}, imageSites: {} });
  // A framework re-render puts the original sources back after the swap; the dark frame must win again.
  const picAgain = await waitFor(picPage, () => {
    const img = document.querySelector('img[data-picture]');
    return img.dataset.sdLocked && (img.currentSrc || '').startsWith('blob:') ? { locked: true } : null;
  }, 15000);
  check('images: the picture is converted again once images are back on', !!picAgain, JSON.stringify(picAgain));
  const picFight = await waitFor(picPage, () => {
    const img = document.querySelector('img[data-picture]');
    if (!img.dataset.testFought) {
      img.dataset.testFought = '1';
      img.setAttribute('srcset', 'banner.png 1x');
      img.closest('picture').querySelector('source').setAttribute('srcset', 'banner.png');
      return null;
    }
    const shown = (img.currentSrc || '').startsWith('blob:');
    // Clearing srcset leaves an empty attribute behind in Chrome, so an empty value counts as clean.
    const clean = !img.getAttribute('srcset') && img.closest('picture').querySelectorAll('source[srcset]').length === 0;
    return shown && clean ? { shown: 'blob', srcset: false, sources: 0, fought: true } : null;
  }, 8000);
  const picFightNow = !picFight ? await picPage.evaluate(() => {
    const img = document.querySelector('img[data-picture]');
    return { shown: (img.currentSrc || '').slice(0, 24), srcset: img.getAttribute('srcset'), sources: img.closest('picture').querySelectorAll('source[srcset]').length, parked: img.dataset.sdSources || '', locked: img.dataset.sdLocked || '', done: img.dataset.sdDone || '' };
  }) : null;
  check('images: a re-render that restores srcset does not bring the light original back', !!picFight && picFight.shown === 'blob' && picFight.fought === true, JSON.stringify(picFight || picFightNow));
  check('images: hide puts the <source srcset> back', picRestored.srcset && picRestored.src === '/images/banner.png' && !picRestored.marker, JSON.stringify(picRestored));
  await picPage.close();

  // 4a3. lazy frames: the stand-in is not the picture, and dark art is not turned inside out
  const lazy = await context.newPage();
  await lazy.goto(`${base}/images/lazy.html`, { waitUntil: 'load' });
  await scrollThrough(lazy);
  const lazyRows = await waitFor(lazy, () => {
    const pick = (sel) => document.querySelector(sel);
    const lazyImg = pick('img[data-lazy]');
    const dark = pick('img[data-dark-art]');
    const strip = pick('img[data-strip]');
    const control = pick('img[data-control]');
    const state = (img) => (img.dataset.sdDone || (img.dataset.sdSkip ? `skip:${img.dataset.sdSkip}` : ''));
    if (!state(lazyImg) || !state(dark) || !state(strip) || !state(control)) return null;
    const lum = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = Math.max(1, Math.round(120 * img.naturalHeight / img.naturalWidth));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let light = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        sum += l;
        if (l > 0.5) light++;
      }
      return { mean: sum / (data.length / 4), light: light / (data.length / 4) };
    };
    return {
      lazy: { state: state(lazyImg), natural: `${lazyImg.naturalWidth}x${lazyImg.naturalHeight}`, parked: !!lazyImg.dataset.sdSources, size: lazyImg.src.length },
      dark: { state: state(dark), kind: dark.dataset.sdDone || '', ...lum(dark) },
      strip: { state: state(strip), kind: strip.dataset.sdDone || '', ...lum(strip) },
      control: { state: state(control), kind: control.dataset.sdDone || '', ...lum(control) },
    };
  }, 30000);
  check('images: a lazy 1x1 stand-in is not converted — the real frame is', !!lazyRows && lazyRows.lazy.state === 'photo' && lazyRows.lazy.natural !== '1x1' && lazyRows.lazy.parked, JSON.stringify(lazyRows && lazyRows.lazy));
  check('images: dark art with light lettering is dimmed, not inverted', !!lazyRows && lazyRows.dark.state === 'dim' && lazyRows.dark.mean < 0.35, JSON.stringify(lazyRows && lazyRows.dark));
  check('images: a flat dark strip is never inverted', !!lazyRows && (lazyRows.strip.state === 'dim' || lazyRows.strip.state === 'skip:already-dark'), JSON.stringify(lazyRows && lazyRows.strip));
  check('images: a bright control photograph is still darkened', !!lazyRows && lazyRows.control.kind === 'photo' && lazyRows.control.mean < 0.45, JSON.stringify(lazyRows && lazyRows.control));
  await lazy.close();

  // 4b. a player that a site fix inverts must keep the clip un-inverted
  await setStorage({ darkSites: { '127.0.0.1': true }, imageSites: {} });
  const player = await context.newPage();
  await player.goto(`${base}/video/`, { waitUntil: 'load' });
  const playerState = await waitFor(player, () => (document.documentElement.dataset.sdState ? JSON.parse(document.documentElement.dataset.sdState) : null));
  check('video: forced theme is applied', playerState && playerState.dark === true, JSON.stringify(playerState));
  const filters = await player.evaluate(() => {
    const wrapper = document.querySelector('.html5-video-player');
    const video = document.querySelector('video');
    return { player: getComputedStyle(wrapper).filter, video: getComputedStyle(video).filter };
  });
  check('video: an inverted player wrapper does not invert the clip', /invert/.test(filters.player) && filters.video === 'none', JSON.stringify(filters));
  await player.close();

  // 4c. the same player on a site that announces its own dark theme: the forced layer must not reuse light-site fixes
  const ownDark = await context.newPage();
  await ownDark.goto(`${base}/dark-media/`, { waitUntil: 'load' });
  await ownDark.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.className = 'html5-video-player';
    wrapper.id = 'own-dark-player';
    wrapper.style.cssText = 'width:320px;height:180px;background:#000';
    document.querySelector('main').appendChild(wrapper);
  });
  await waitFor(ownDark, () => document.documentElement.dataset.sdState);
  await ownDark.waitForTimeout(800);
  const ownDarkFilter = await ownDark.evaluate(() => getComputedStyle(document.getElementById('own-dark-player')).filter);
  check('video: a native dark site keeps its player un-inverted', ownDarkFilter === 'none', ownDarkFilter);
  await ownDark.close();
  await images.screenshot({ path: path.join(shots, '13-image-classes.png'), fullPage: true });

  // 5. toggles, persistence and popup on the light fixture
  await setStorage({ darkSites: {}, imageSites: {} });
  const site = await context.newPage();
  await site.goto(`${base}/light/`, { waitUntil: 'load' });
  await waitFor(site, () => document.documentElement.dataset.sdState);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await site.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(1500);
  const popupText = await popup.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  check('popup targets the active site', /127\.0\.0\.1/.test(popupText), popupText.slice(0, 90));
  const labels = await popup.evaluate(() => [document.getElementById('label-dark').textContent, document.getElementById('label-images').textContent]);
  check('popup uses the requested labels', /Затемнять сайт/.test(labels[0]) && /Затемнять изображения/.test(labels[1]), JSON.stringify(labels));
  const initial = await popup.evaluate(() => ({ dark: document.getElementById('toggle-dark').checked, images: document.getElementById('toggle-images').checked }));
  check('popup reflects the auto-enabled theme', initial.dark === true, JSON.stringify(initial));
  check('images are on by default', initial.images === true, JSON.stringify(initial));
  const footer = await popup.evaluate(() => {
    const foot = document.getElementById('foot');
    const style = getComputedStyle(foot);
    return { hidden: foot.hidden, display: style.display, height: foot.getBoundingClientRect().height, text: foot.innerText.trim() };
  });
  check('footer is hidden while it has nothing to offer', footer.hidden && footer.display === 'none' && footer.height === 0, JSON.stringify(footer));
  const iconOk = await popup.evaluate(() => {
    const el = document.querySelector('.head__icon');
    const url = getComputedStyle(el).backgroundImage.match(/url\("(.*)"\)/);
    return { matches: !!url, url: url ? url[1] : null };
  });
  check('popup shows the icon asset', iconOk.matches, JSON.stringify(iconOk));
  await popup.screenshot({ path: path.join(shots, '14-popup-on.png') });

  await popup.click('#row-dark');
  await popup.waitForTimeout(1200);
  const stored = await worker.evaluate(() => chrome.storage.local.get({ darkSites: {}, imageSites: {} }));
  check('dark switch state is persisted', stored.darkSites['127.0.0.1'] === false, JSON.stringify(stored.darkSites));
  await popup.click('#row-images');
  await popup.waitForTimeout(1200);
  const stored2 = await worker.evaluate(() => chrome.storage.local.get({ darkSites: {}, imageSites: {} }));
  check('image switch can be turned off and is persisted', stored2.imageSites['127.0.0.1'] === false, JSON.stringify(stored2.imageSites));

  await popup.reload();
  await popup.waitForTimeout(1200);
  const restored = await popup.evaluate(() => ({ dark: document.getElementById('toggle-dark').checked, images: document.getElementById('toggle-images').checked }));
  check('popup restores saved switch states', restored.dark === false && restored.images === false, JSON.stringify(restored));

  await site.waitForTimeout(800);
  check('site layer follows the switch', (await state(site)).dark === false, JSON.stringify(await state(site)));
  await popup.screenshot({ path: path.join(shots, '15-popup-off.png') });

  await context.close();
  server.close();
  cdn.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
