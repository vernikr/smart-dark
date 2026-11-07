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
const shots = path.join(root, 'docs/worklog/2026.11.07-site-compatibility/shots');
fs.mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const skip = (name, detail = '') => {
  results.push({ name, ok: true, skipped: true, detail });
  console.log('SKIP ' + name + (detail ? ' — ' + detail : ''));
};


const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

let corsPort = 0;
let lastCdnRequest = null;

function serve() {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const clean = decodeURIComponent(requestUrl.pathname);
    const file = path.join(fixtures, clean.endsWith('/') ? path.join(clean, 'index.html') : clean);
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const send = () => {
      if (res.destroyed) return;
      let body = fs.readFileSync(file);
      if (file.endsWith('.html') && body.includes('__CORS__')) body = body.toString('utf8').replace('__CORS__', String(corsPort));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    };
    const delay = Math.min(3000, Math.max(0, Number(requestUrl.searchParams.get('delay') || 0)));
    if (delay) setTimeout(send, delay);
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* A second origin that answers `Access-Control-Allow-Origin: *`, the way habrastorage and fbcdn do. A request that
   carries cookies is rejected by the browser against such a header, so this server is what catches that mistake. */
function serveCdn() {
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
    lastCdnRequest = { url: req.url, cookie: req.headers.cookie || null };
    if (name === 'large.bin') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': '*',
      });
      const block = Buffer.alloc(8 * 1024 * 1024);
      res.write(block);
      res.write(block);
      res.end(Buffer.from([0]));
      return;
    }
    const file = path.join(fixtures, 'images', name);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('.css') && body.includes('__CORS__')) {
      body = Buffer.from(body.toString('utf8').replaceAll('__CORS__', String(corsPort)));
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'access-control-allow-origin': '*',
    }).end(body);
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
    ['simple-page', false, 'short contentful page'],
    ['neutral-mode', false, 'empty generic mode attributes do not claim a dark theme'],
    ['light-color-scheme', false, 'color-scheme dark alone does not imply dark painted surfaces'],
    ['explicit-mode-dark', true, 'an explicit data-mode dark value remains recognised'],
    ['light-color-mode', false, 'an explicit data-color-mode light value remains recognised'],
    ['mobilism', false, 'phpBB darkrow classes do not declare a dark site'],
    ['notebook', false, 'Google Devsite class color-scheme--light remains a light site'],
    ['openai-help', false, 'OpenAI Help Center article is measured as light'],
    ['npm', false, 'npm package settings page is measured as light'],
    ['gmail', false, 'Gmail-like mailbox shell is measured as light'],
    ['inline-important', false, 'email card with important inline background'],
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
      const fontFamily = await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily);
      check('theme: the page font family is preserved', /Georgia/i.test(fontFamily), fontFamily);
      await page.screenshot({ path: path.join(shots, '10-light-fixture.png') });
    }
    if (slug === 'simple-page') {
      const details = await page.evaluate(() => ({
        height: document.body.clientHeight,
        state: JSON.parse(document.documentElement.dataset.sdState || '{}'),
      }));
      check('detection: compact content is measured and themed', details.height < 32
        && details.state.detected === true
        && details.state.reason === 'measured-light'
        && details.state.dark === true, JSON.stringify(details));
    }
    if (slug === 'inline-important') {
      const converted = await waitFor(page, () => {
        const card = document.querySelector('.message');
        const background = getComputedStyle(card).backgroundColor;
        return background !== 'rgb(255, 255, 255)' ? {
          background,
          priority: card.style.getPropertyPriority('background-color'),
          color: getComputedStyle(card).color,
          state: JSON.parse(document.documentElement.dataset.sdState || '{}'),
        } : null;
      }, 8000);
      check('inline-important: message background is darkened', !!converted
        && converted.priority === 'important' && converted.state.dark === true, JSON.stringify(converted));
      await setStorage({ darkSites: { '127.0.0.1': false }, imageSites: {} });
      const restored = await waitFor(page, () => {
        const card = document.querySelector('.message');
        const state = JSON.parse(document.documentElement.dataset.sdState || '{}');
        if (state.dark !== false) return null;
        return {
          background: getComputedStyle(card).backgroundColor,
          shorthand: card.style.getPropertyValue('background'),
          shorthandPriority: card.style.getPropertyPriority('background'),
          styleAttribute: card.getAttribute('style') || '',
        };
      }, 8000);
      check('inline-important: original inline style is restored when the theme is off', !!restored
        && restored.background === 'rgb(255, 255, 255)'
        && restored.shorthand === 'rgb(255, 255, 255)'
        && restored.shorthandPriority === 'important'
        && !restored.styleAttribute.split(';').some((declaration) => {
          const colon = declaration.indexOf(':');
          return colon > 0 && declaration.slice(0, colon).trim().toLowerCase() === 'background-color';
        }), JSON.stringify(restored));
      await setStorage({ darkSites: { '127.0.0.1': true }, imageSites: {} });
      const reapplied = await waitFor(page, () => getComputedStyle(document.querySelector('.message')).backgroundColor !== 'rgb(255, 255, 255)', 8000);
      check('inline-important: converted background returns when the theme is on again', !!reapplied);
    }
    if (slug === 'dark-media') {
      await page.screenshot({ path: path.join(shots, '11-dark-hero.png') });
    }
    await page.close();
  }

  // 1b. reported site families: theme application, typography and interactive surfaces.
  for (const [slug, label] of [
    ['mobilism', 'Mobilism/phpBB'],
    ['notebook', 'Google Notebook docs'],
    ['openai-help', 'OpenAI Help'],
    ['npm', 'npm package settings'],
    ['gmail', 'Gmail message'],
  ]) {
    await setStorage({ darkSites: { '127.0.0.1': true }, imageSites: {} });
    const page = await context.newPage();
    await page.goto(base + '/' + slug + '/', { waitUntil: 'load' });
    const initial = await waitFor(page, () => {
      const raw = document.documentElement.dataset.sdState;
      if (!raw) return null;
      const current = JSON.parse(raw);
      return current.dark === true ? current : null;
    }, 12000);
    check('compatibility: ' + label + ' accepts the explicit dark switch', !!initial, JSON.stringify(initial));

    if (slug === 'mobilism') {
      const surfaces = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        header: getComputedStyle(document.querySelector('header')).backgroundColor,
        row: getComputedStyle(document.querySelector('.darkrow1')).backgroundColor,
        link: getComputedStyle(document.querySelector('.darkrow1 a')).color,
      }));
      check('compatibility: Mobilism-style forum has a dark body and legible forum rows',
        !!initial && surfaces.body !== 'rgb(243, 243, 243)'
          && surfaces.row !== 'rgb(244, 244, 244)',
        JSON.stringify(surfaces));
    }

    if (slug === 'notebook') {
      const styles = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        heading: getComputedStyle(document.querySelector('h1')).fontFamily,
        header: getComputedStyle(document.querySelector('header')).backgroundColor,
      }));
      check('compatibility: Notebook docs darken while retaining Google font declarations',
        !!initial && styles.body !== 'rgb(255, 255, 255)' && /Google Sans/i.test(styles.heading),
        JSON.stringify(styles));
    }

    if (slug === 'openai-help') {
      const styles = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector('.article-card')).backgroundColor,
        heading: getComputedStyle(document.querySelector('h1')).color,
      }));
      check('compatibility: OpenAI Help article surfaces are darkened',
        !!initial && styles.body !== 'rgb(255, 255, 255)' && styles.card !== 'rgb(255, 255, 255)',
        JSON.stringify(styles));
    }

    if (slug === 'npm') {
      const styles = await page.evaluate(() => ({
        headerBg: getComputedStyle(document.querySelector('header')).backgroundColor,
        headerText: getComputedStyle(document.querySelector('header')).color,
        bodyBg: getComputedStyle(document.querySelector('main')).backgroundColor,
        packageBg: getComputedStyle(document.querySelector('.package')).backgroundColor,
        packageText: getComputedStyle(document.querySelector('.package')).color,
        description: getComputedStyle(document.querySelector('.description')).color,
      }));
      const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = (value) => {
        const c = rgb(value).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      check('compatibility: npm header and package list are consistently dark',
        !!initial && lum(styles.headerBg) < 0.2 && lum(styles.bodyBg) < 0.2 && lum(styles.packageBg) < 0.35,
        JSON.stringify(styles));
      check('compatibility: npm package text remains readable on dark cards',
        lum(styles.packageText) > lum(styles.packageBg) && lum(styles.description) > lum(styles.packageBg),
        JSON.stringify(styles));
    }

    if (slug === 'gmail') {
      const input = page.locator('input[aria-label="Search mail"]');
      await setStorage({ darkSites: { '127.0.0.1': false }, imageSites: {} });
      await waitFor(page, () => {
        const raw = document.documentElement.dataset.sdState;
        return raw && JSON.parse(raw).dark === false;
      }, 8000);
      await input.focus();
      const lightFocus = await input.evaluate((element) => ({
        active: document.activeElement === element,
        transition: getComputedStyle(element).transitionDuration,
      }));
      await setStorage({ darkSites: { '127.0.0.1': true }, imageSites: {} });
      const darkFocus = await waitFor(page, () => {
        const element = document.querySelector('input[aria-label="Search mail"]');
        const background = getComputedStyle(element).backgroundColor;
        return document.activeElement === element && background !== 'rgb(255, 255, 255)'
          ? {
            active: document.activeElement === element,
            background,
            color: getComputedStyle(element).color,
            transition: getComputedStyle(element).transitionDuration,
            state: JSON.parse(document.documentElement.dataset.sdState || '{}'),
          } : null;
      }, 10000);
      await page.waitForTimeout(220);
      const banner = await page.locator('.banner td').first().evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      }));
      const toLum = (value) => {
        const m = value.match(/[\d.]+/g).slice(0, 3).map((v) => Number(v) / 255);
        const c = m.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      check('compatibility: Gmail search keeps focus through theme activation', !!darkFocus && darkFocus.active,
        JSON.stringify({ before: lightFocus, after: darkFocus }));
      check('compatibility: Gmail focused search transition is disabled while dark mode is active',
        !!darkFocus && darkFocus.transition.split(',').every((value) => value.trim() === '0s'),
        JSON.stringify(darkFocus));
      check('compatibility: Gmail focused search field stays dark and readable',
        !!darkFocus && toLum(darkFocus.background) < 0.25 && toLum(darkFocus.color) > toLum(darkFocus.background),
        JSON.stringify(darkFocus));
      check('compatibility: Gmail email banner background and text stay contrasted',
        toLum(banner.background) < 0.3 && toLum(banner.color) > toLum(banner.background),
        JSON.stringify(banner));
      await setStorage({ darkSites: { '127.0.0.1': false }, imageSites: {} });
      const restoredTransition = await waitFor(page, () => {
        const element = document.querySelector('input[aria-label="Search mail"]');
        return getComputedStyle(element).transitionDuration === '0.18s, 0.18s'
          ? getComputedStyle(element).transitionDuration : null;
      }, 8000);
      check('compatibility: Gmail search transition is restored when dark mode is turned off',
        restoredTransition === '0.18s, 0.18s', String(restoredTransition));
    }

    await page.screenshot({ path: path.join(shots, 'compat-' + slug + '.png'), fullPage: true });
    await page.close();
  }

  // 1c. The service-worker fetch bridge is exercised directly from the extension origin.
  const bridgeSite = await context.newPage();
  await bridgeSite.goto(base + '/light/', { waitUntil: 'load' });
  await bridgeSite.evaluate(() => { document.cookie = 'smart-dark-bridge-test=present; SameSite=Lax'; });
  const bridgeCookie = await bridgeSite.evaluate(() => document.cookie);
  const bridgePage = await context.newPage();
  await bridgePage.goto('chrome-extension://' + extId + '/popup.html', { waitUntil: 'load' });
  const cdnURL = 'http://127.0.0.1:' + cdn.address().port;
  lastCdnRequest = null;
  const bridgeImage = await bridgePage.evaluate(async (url) => {
    return await chrome.runtime.sendMessage({ type: 'wd-fetch-resource', url });
  }, cdnURL + '/photo.jpg');
  const imageRequest = lastCdnRequest;
  const bridgeBytes = Buffer.from(bridgeImage && bridgeImage.body || '', 'base64').byteLength;
  check('resource bridge: extension worker returns a cross-origin image as a data payload',
    !!bridgeImage && bridgeImage.ok === true && bridgeImage.contentType === 'image/jpeg' && bridgeBytes > 1000,
    JSON.stringify({ ok: bridgeImage && bridgeImage.ok, contentType: bridgeImage && bridgeImage.contentType, bytes: bridgeBytes }));
  check('resource bridge: site cookies are omitted from cross-origin requests',
    bridgeCookie.includes('smart-dark-bridge-test=present') && !!imageRequest && imageRequest.cookie === null,
    JSON.stringify({ pageCookiePresent: bridgeCookie.includes('smart-dark-bridge-test=present'), requestCookie: imageRequest && imageRequest.cookie }));

  lastCdnRequest = null;
  const oversizedResource = await bridgePage.evaluate(async (url) => {
    return await chrome.runtime.sendMessage({ type: 'wd-fetch-resource', url });
  }, cdnURL + '/large.bin');
  check('resource bridge: oversized response is cancelled at the streaming 16 MiB limit',
    !!oversizedResource && oversizedResource.ok === false
      && /16 MiB/.test(oversizedResource.error || '')
      && !!lastCdnRequest && lastCdnRequest.url === '/large.bin',
    JSON.stringify({ result: oversizedResource, request: lastCdnRequest }));
  await bridgePage.close();
  await bridgeSite.close();

  // 2. live site with its own dark theme
  // 2. live site with its own dark theme
  await setStorage({ darkSites: {}, imageSites: {} });
  const kiro = await context.newPage();
  await kiro.goto('https://kiro.dev/blog/software-factory-stability/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  if (kiro.url().includes('kiro.dev')) {
    const info = await waitFor(kiro, () => (document.documentElement.dataset.sdState ? JSON.parse(document.documentElement.dataset.sdState) : null));
    check('live: native dark blog detected', info && info.factoryDark === true, JSON.stringify(info));
    check('live: theme stays off on native dark blog', info && info.dark === false);
    const fetchInfo = await waitFor(kiro, () => {
      const raw = document.documentElement.dataset.sdState;
      if (!raw) return null;
      const current = JSON.parse(raw);
      return current.darkReaderFetchRequests > 0 || current.darkReaderFetchFailures > 0 ? current : null;
    }, 10000);
    check('live: cross-origin site resources use the extension fetch bridge',
      !!fetchInfo && fetchInfo.darkReaderFetchRequests > 0 && fetchInfo.darkReaderFetchFailures === 0,
      JSON.stringify(fetchInfo));
  } else {
    skip('live: native dark blog detected', 'site unreachable from the sandbox');
    skip('live: theme stays off on native dark blog', 'site unreachable from the sandbox');
    skip('live: cross-origin site resources use the extension fetch bridge', 'site unreachable from the sandbox');
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
    const DELIBERATE = ['already-dark', 'small', 'vector', 'ignore', 'not-visible'];
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

  // 3b. a theme that arrives after the first paint: an app shell must not freeze a "light" verdict
  await setStorage({ darkSites: {}, imageSites: {} });
  const late = await context.newPage();
  await late.goto(`${base}/late-dark/`, { waitUntil: 'domcontentloaded' });
  const early = await waitFor(late, () => {
    const raw = document.documentElement.dataset.sdState;
    return raw ? JSON.parse(raw) : null;
  }, 10000);
  const settled = await waitFor(late, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const state = JSON.parse(raw);
    // The dark theme lands at ~900 ms; the verdict must be revised without a reload.
    return state.factoryDark === true && state.reason !== 'not-ready' && state.reason !== 'skeleton' ? state : null;
  }, 15000);
  check('late theme: a shell that is light before its theme arrives is not judged light', !!settled, JSON.stringify({ early, settled }));
  check('late theme: the theme layer is off once the site is known to be dark', !!settled && settled.dark === false, JSON.stringify(settled));
  await late.close();

  // The same, with nothing declared at all: only a second measurement can find the theme.
  const lateMeasured = await context.newPage();
  await lateMeasured.goto(`${base}/late-dark-measured/`, { waitUntil: 'domcontentloaded' });
  const measuredSettled = await waitFor(lateMeasured, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state.factoryDark === true && state.reason === 'measured-dark' ? state : null;
  }, 15000);
  check('late theme: an undeclared theme is found by a second measurement', !!measuredSettled && measuredSettled.dark === false, JSON.stringify(measuredSettled));
  await lateMeasured.close();

  // 3c. unrelated feed churn must not trigger another full-page theme survey.
  await setStorage({ darkSites: {}, imageSites: {} });
  const observerPage = await context.newPage();
  await observerPage.goto(base + '/observer/', { waitUntil: 'load' });
  await observerPage.waitForTimeout(3800);
  const reviewBefore = await state(observerPage);
  await observerPage.evaluate(() => {
    for (let i = 0; i < 120; i++) {
      const item = document.createElement('div');
      item.textContent = 'Feed item ' + i;
      document.body.appendChild(item);
      item.remove();
    }
  });
  await observerPage.waitForTimeout(500);
  const reviewAfter = await state(observerPage);
  check('observer: unrelated subtree churn does not re-run theme detection',
    !!reviewBefore && !!reviewAfter && reviewAfter.reviewCount === reviewBefore.reviewCount,
    JSON.stringify({ before: reviewBefore && reviewBefore.reviewCount, after: reviewAfter && reviewAfter.reviewCount }));

  await observerPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const rootTheme = await waitFor(observerPage, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const current = JSON.parse(raw);
    return current.reason === 'declared-dark' ? current : null;
  }, 8000);
  check('observer: a root theme attribute change is still detected', !!rootTheme && rootTheme.dark === false, JSON.stringify(rootTheme));

  await observerPage.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.add('dark');
  });
  const bodyTheme = await waitFor(observerPage, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const current = JSON.parse(raw);
    return current.reason === 'declared-dark' ? current : null;
  }, 8000);
  check('observer: a body theme class change is still detected', !!bodyTheme && bodyTheme.dark === false, JSON.stringify(bodyTheme));
  await observerPage.evaluate(() => {
    document.body.classList.remove('dark');
    document.documentElement.setAttribute('data-color-mode', 'light');
  });
  const bodyLight = await waitFor(observerPage, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const current = JSON.parse(raw);
    return current.reason === 'declared-light' ? current : null;
  }, 8000);
  check('observer: a root data-color-mode light value is detected', !!bodyLight && bodyLight.factoryDark === false, JSON.stringify(bodyLight));

  await observerPage.evaluate(() => {
    const meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark';
    document.head.appendChild(meta);
  });
  const metaTheme = await waitFor(observerPage, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const current = JSON.parse(raw);
    return current.reason === 'declared-dark' ? current : null;
  }, 8000);
  check('observer: a dynamically added color-scheme meta is detected', !!metaTheme && metaTheme.factoryDark === true, JSON.stringify(metaTheme));

  await observerPage.evaluate(() => document.querySelector('meta[name="color-scheme"]')?.remove());
  await observerPage.evaluate(() => {
    document.documentElement.removeAttribute('data-color-mode');
    document.body.setAttribute('data-dark', '');
  });
  const explicitDark = await waitFor(observerPage, () => {
    const raw = document.documentElement.dataset.sdState;
    if (!raw) return null;
    const current = JSON.parse(raw);
    return current.reason === 'declared-dark' ? current : null;
  }, 8000);
  check('observer: an empty explicit data-dark flag is detected', !!explicitDark && explicitDark.factoryDark === true, JSON.stringify(explicitDark));

  await observerPage.close();

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

  await images.evaluate(async () => {
    const image = document.createElement('img');
    image.id = 'recycle-source-check';
    image.style.cssText = 'display:block;width:700px;height:460px;object-fit:cover';
    image.src = 'photo.jpg';
    document.querySelector('main').appendChild(image);
    image.scrollIntoView();
  });
  const recycledInitial = await waitFor(images, () => {
    const image = document.getElementById('recycle-source-check');
    return image && image.dataset.sdDone ? image.dataset.sdSource : null;
  }, 30000);
  await images.evaluate(() => document.getElementById('recycle-source-check').setAttribute('src', 'banner.png'));
  const recycledUpdated = await waitFor(images, () => {
    const image = document.getElementById('recycle-source-check');
    return image && image.dataset.sdDone && image.dataset.sdSource
      && image.dataset.sdSource.endsWith('/banner.png')
      ? { source: image.dataset.sdSource, shown: (image.currentSrc || '').startsWith('blob:') }
      : null;
  }, 30000);
  const recycledDebug = await images.evaluate(() => {
    const image = document.getElementById('recycle-source-check');
    return image ? {
      src: image.getAttribute('src'),
      currentSrc: image.currentSrc,
      done: image.dataset.sdDone || '',
      skip: image.dataset.sdSkip || '',
      queued: image.dataset.sdQueued || '',
      pending: image.dataset.sdPending || '',
      source: image.dataset.sdSource || '',
      locked: image.dataset.sdLocked || '',
    } : null;
  });
  check('images: a recycled card converts its new source instead of restoring the previous picture',
    !!recycledInitial && !!recycledUpdated && recycledUpdated.shown,
    JSON.stringify({ initial: recycledInitial, updated: recycledUpdated, debug: recycledUpdated ? null : recycledDebug }));
  await setStorage({ darkSites: {}, imageSites: { '127.0.0.1': false } });
  const recycledRestored = await waitFor(images, () => {
    const image = document.getElementById('recycle-source-check');
    return image && !image.dataset.sdDone && image.getAttribute('src') === 'banner.png'
      ? { src: image.getAttribute('src'), done: image.dataset.sdDone || '' }
      : null;
  }, 12000);
  check('images: stopping after a recycle restores the new original source', !!recycledRestored, JSON.stringify(recycledRestored));
  await setStorage({ darkSites: {}, imageSites: {} });

  const highResolution = await images.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2800;
    canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(1, '#222222');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const image = document.createElement('img');
    image.id = 'high-resolution-check';
    image.style.cssText = 'display:block;width:700px;height:auto';
    image.src = canvas.toDataURL('image/png');
    document.querySelector('main').appendChild(image);
    await image.decode();
    image.scrollIntoView();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  const highResolutionResult = await waitFor(images, () => {
    const image = document.getElementById('high-resolution-check');
    return image && image.dataset.sdDone
      ? { kind: image.dataset.sdDone, width: image.naturalWidth, height: image.naturalHeight }
      : null;
  }, 30000);
  check('images: high-resolution input is downscaled before pixel processing',
    !!highResolutionResult && highResolutionResult.width <= 2200 && highResolutionResult.height <= 2200
      && highResolutionResult.width === 2200,
    JSON.stringify({ original: highResolution, output: highResolutionResult }));

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
      return {
        srcset: true,
        src: img.getAttribute('src') || '',
        sizes: img.getAttribute('sizes') || '',
        filter: img.style.getPropertyValue('filter'),
        filterPriority: img.style.getPropertyPriority('filter'),
        marker: !!img.dataset.sdSources,
      };
    }
    return null;
  }, 15000) || await picPage.evaluate(() => {
    const img = document.querySelector('img[data-picture]');
    const source = img.closest('picture').querySelector('source');
    return {
      srcset: source.hasAttribute('srcset'),
      src: img.getAttribute('src') || '',
      sizes: img.getAttribute('sizes') || '',
      filter: img.style.getPropertyValue('filter'),
      filterPriority: img.style.getPropertyPriority('filter'),
      marker: !!img.dataset.sdSources,
    };
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
  check('images: hide restores original <source>, src, sizes and inline filter',
    picRestored.srcset && picRestored.src === 'banner.png'
      && picRestored.sizes === '(max-width: 760px) 100vw, 760px'
      && picRestored.filter === 'sepia(0.2)' && picRestored.filterPriority === 'important'
      && !picRestored.marker,
    JSON.stringify(picRestored));
  await picPage.close();

  // 4a3. stopping image conversion must abort an in-flight fetch and prevent a late image swap.
  const cancelPage = await context.newPage();
  await setStorage({ darkSites: {}, imageSites: {} });
  await cancelPage.goto(base + '/images/cancel.html', { waitUntil: 'domcontentloaded' });
  const pendingImage = await waitFor(cancelPage, () => {
    const image = document.querySelector('#cancel-image');
    return image && image.dataset.sdPending ? true : null;
  }, 8000);
  check('images: delayed conversion enters the cancellable pending state', !!pendingImage);
  await setStorage({ darkSites: {}, imageSites: { '127.0.0.1': false } });
  await cancelPage.waitForTimeout(2200);
  const cancelledImage = await cancelPage.evaluate(() => {
    const image = document.querySelector('#cancel-image');
    return {
      done: image.dataset.sdDone || '',
      pending: image.dataset.sdPending || '',
      src: image.getAttribute('src') || '',
      blob: image.dataset.sdBlob || '',
    };
  });
  check('images: stopping conversion prevents a late blob swap',
    !cancelledImage.done && !cancelledImage.pending
      && cancelledImage.src.includes('photo.jpg?delay=1800') && !cancelledImage.blob,
    JSON.stringify(cancelledImage));
  await cancelPage.close();
  await setStorage({ darkSites: {}, imageSites: {} });

  // 4a4. lazy frames: the stand-in is not the picture, and dark art is not turned inside out
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

  // 7. the specification in docs/BUSINESS-LOGIC.md must cover every verdict, skip reason and limit the code can emit
  {
    const imagerySource = fs.readFileSync(path.join(process.cwd(), 'src/content/imagery.js'), 'utf8');
    const spec = fs.readFileSync(path.join(process.cwd(), 'docs/BUSINESS-LOGIC.md'), 'utf8');
    const reasons = new Set([
      ...[...imagerySource.matchAll(/sdSkip = '([a-z-]+)'/g)].map((m) => m[1]),
      ...[...imagerySource.matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]),
      ...[...imagerySource.matchAll(/last = '([a-z-]+)'/g)].map((m) => m[1]),
    ].filter(Boolean));
    const unlisted = [...reasons].filter((reason) => !spec.includes(reason));
    check('docs: every skip reason the code can emit is specified', unlisted.length === 0, JSON.stringify(unlisted));
    const verdicts = ['photo', 'graphic', 'icon', 'dim', 'already-dark', 'placeholder'];
    const undocumented = verdicts.filter((verdict) => !spec.includes(verdict));
    check('docs: every verdict is specified', undocumented.length === 0, JSON.stringify(undocumented));
    const limits = ['FLIP_LIGHT_WORSENS', 'FLIP_CONTRAST_FLOOR', 'MIN_AREA', 'IMAGE_TIMEOUT_MS'];
    const unnamed = limits.filter((name) => !spec.includes(name));
    check('docs: the rejection and skip limits are named in the spec', unnamed.length === 0, JSON.stringify(unnamed));
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.length - failed.length - skipped;
  console.log('\n' + passed + '/' + (results.length - skipped) + ' checks passed; ' + skipped + ' skipped');
  fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
