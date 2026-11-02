/* Smart image darkening: content classification, perceptual tone remap, hover-free in-place swap. */
(function () {
  'use strict';

  const LUMA = [0.2126, 0.7152, 0.0722];
  const MIN_WIDTH = 260;
  const MIN_HEIGHT = 140;
  const MIN_AREA = 90000;
  const ANALYSIS_SIZE = 48;
  const COLOR_GRID = 40;
  const COLOR_STEP = 24;
  const MAX_SIDE = 2200;
  const IMAGE_TIMEOUT_MS = 10000;
  const VISIBILITY_RETRIES = 4;
  const PREFETCH_MARGIN = '2400px';
  const CONCURRENCY = 3;
  const VISIBILITY_RETRY_MS = 700;
  const LIGHT_PIXEL_LUMA = 0.5;
  const MIN_LIGHT_SHARE = 0.25;
  const MIN_LIGHT_SHARE_ICON = 0.08;
  const SKIP_DARK_PHOTO_BELOW = 0.22;
  const SKIP_DARK_GRAPHIC_BELOW = 0.18;

  const CURVES = {
    icon: { flip: false, floor: 0.300, ceil: 0.880, sat: 1.10 },
    graphic: { flip: true, floor: 0.135, ceil: 0.880, sat: 1.20 },
    photo: { flip: false, floor: 0.060, ceil: 0.640, sat: 1.06 },
  };

  const srgbToLin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    srgbToLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const linToSrgb = (c) => {
    const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };

  const gainLUT = new Map();

  function buildMaps(curve) {
    const key = `${curve.floor}|${curve.ceil}|${curve.flip}`;
    let maps = gainLUT.get(key);
    if (maps) return maps;
    const target = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const src = i / 255;
      const x = curve.flip ? 1 - src : src;
      const tgt = curve.floor + (curve.ceil - curve.floor) * x;
      target[i] = srgbToLin[Math.round(tgt * 255)];
    }
    maps = { target };
    gainLUT.set(key, maps);
    return maps;
  }

  function canvasOf(w, h) {
    const c = (typeof OffscreenCanvas !== 'undefined' && typeof OffscreenCanvas.prototype.getContext === 'function')
      ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    if (!c.width) c.width = w;
    if (!c.height) c.height = h;
    return c;
  }

  function classify(source, width, height) {
    const small = canvasOf(ANALYSIS_SIZE, ANALYSIS_SIZE);
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, 0, 0, width, height, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
    const data = ctx.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE).data;
    let transparent = 0;
    let mid = 0;
    let lumSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 26) { transparent++; continue; }
      const l = (LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]) / 255;
      lumSum += l;
      if (l > 0.2 && l < 0.8) mid++;
    }
    const total = data.length / 4;
    const opaque = 1 - transparent / total;

    const grid = canvasOf(COLOR_GRID, COLOR_GRID);
    const gctx = grid.getContext('2d', { willReadFrequently: true });
    gctx.clearRect(0, 0, COLOR_GRID, COLOR_GRID);
    gctx.drawImage(source, 0, 0, width, height, 0, 0, COLOR_GRID, COLOR_GRID);
    const gdata = gctx.getImageData(0, 0, COLOR_GRID, COLOR_GRID).data;
    const seen = new Set();
    for (let i = 0; i < gdata.length; i += 4) {
      seen.add(((gdata[i] / COLOR_STEP) | 0) * 441 + ((gdata[i + 1] / COLOR_STEP) | 0) * 21 + ((gdata[i + 2] / COLOR_STEP) | 0));
    }

    const midShare = mid / Math.max(1, total - transparent);
    let kind = 'photo';
    if (opaque < 0.98) kind = 'icon';
    else if (seen.size <= 32 || midShare < 0.18) kind = 'graphic';
    let lightPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 26) continue;
      if ((LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]) / 255 > LIGHT_PIXEL_LUMA) lightPixels++;
    }
    const lightShare = lightPixels / Math.max(1, total - transparent);
    return {
      kind, colors: seen.size, midShare, opaque, lightShare,
      meanLum: lumSum / Math.max(1, total - transparent),
    };
  }

  function toneMap(source, width, height, kind) {
    const curve = CURVES[kind];
    const canvas = canvasOf(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const px = image.data;
    const maps = buildMaps(curve);
    const target = maps.target;
    const sat = curve.sat;

    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const idx = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) | 0;
      const t = target[idx > 255 ? 255 : idx];
      const rl0 = srgbToLin[r];
      const gl0 = srgbToLin[g];
      const bl0 = srgbToLin[b];
      const lum = 0.2126 * rl0 + 0.7152 * gl0 + 0.0722 * bl0;
      const k = lum > 1e-6 ? t / lum : 0;
      const rl = lum > 1e-6 ? rl0 * k : t;
      const gl = lum > 1e-6 ? gl0 * k : t;
      const bl = lum > 1e-6 ? bl0 * k : t;
      let rr = linToSrgb(rl);
      let gg = linToSrgb(gl);
      let bb = linToSrgb(bl);
      const grey = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      rr = grey + (rr - grey) * sat;
      gg = grey + (gg - grey) * sat;
      bb = grey + (bb - grey) * sat;
      px[i] = rr <= 0 ? 0 : rr >= 1 ? 255 : rr * 255;
      px[i + 1] = gg <= 0 ? 0 : gg >= 1 ? 255 : gg * 255;
      px[i + 2] = bb <= 0 ? 0 : bb >= 0 ? (bb >= 1 ? 255 : bb * 255) : 0;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  async function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch (err) { /* svg and exotic formats are not bitmap-decodable */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode-failed'));
      img.src = URL.createObjectURL(blob);
    });
  }

  async function loadBitmap(url) {
    if (url.startsWith('data:')) return decodeBlob(await (await fetch(url)).blob());
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error('fetch-failed');
    return decodeBlob(await response.blob());
  }

  function toObjectURL(canvas) {
    return new Promise((resolve) => {
      if (typeof canvas.convertToBlob === 'function') {
        canvas.convertToBlob({ type: 'image/png' }).then((blob) => resolve(URL.createObjectURL(blob)));
        return;
      }
      canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
    });
  }

  class Processor {
    constructor(selectors) {
      this.selectors = selectors;
      this.cache = new Map();
      this.handled = new WeakMap();
      this.queue = [];
      this.running = 0;
    }

    claim(img, url) {
      let sources = this.handled.get(img);
      if (!sources) {
        sources = new Set();
        this.handled.set(img, sources);
      }
      if (sources.has(url)) return false;
      sources.add(url);
      return true;
    }

    matches(el, list) {
      for (const sel of list) {
        try {
          if (el.matches(sel)) return true;
        } catch (err) { /* invalid selector from data file */ }
      }
      return false;
    }

    isLarge(el) {
      const rect = el.getBoundingClientRect();
      const w = rect.width || el.naturalWidth || 0;
      const h = rect.height || el.naturalHeight || 0;
      return (w >= MIN_WIDTH && h >= MIN_HEIGHT) || w * h >= MIN_AREA;
    }

    isVisible(el) {
      if (!el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
    }

    enqueue(img) {
      if (img.dataset.sdDone || img.dataset.sdQueued) return;
      img.dataset.sdQueued = '1';
      this.queue.push(img);
      this.drain();
    }

    /* A single large picture used to hold the whole queue; a few conversions now run side by side. */
    drain() {
      while (this.running < CONCURRENCY && this.queue.length) {
        this.running++;
        this.run(this.queue.shift()).finally(() => {
          this.running--;
          this.drain();
        });
      }
    }

    async run(img) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), IMAGE_TIMEOUT_MS));
      ledger.started++;
      try {
        const outcome = await Promise.race([this.process(img), timeout]);
        if (outcome === 'timeout') img.dataset.sdSkip = 'timeout';
      } catch (err) {
        img.dataset.sdSkip = err && err.message ? err.message : 'error';
      }
      if (img.dataset.sdDone) {
        ledger.converted++;
        ledger.kinds[img.dataset.sdDone] = (ledger.kinds[img.dataset.sdDone] || 0) + 1;
      } else {
        ledger.skipped++;
        const reason = img.dataset.sdSkip || 'unprocessed';
        ledger.reasons[reason] = (ledger.reasons[reason] || 0) + 1;
      }
      publishLedger();
      delete img.dataset.sdPending;
    }

    async process(img) {
      if (!img.isConnected) return;
      const url = img.currentSrc || img.src;
      if (!url || url.startsWith('data:image/svg') || /\.svg(\?|#|$)/i.test(url)) return;
      // Images that fade in or mount late are retried shortly instead of being dropped.
      if (!this.isVisible(img)) {
        const attempts = Number(img.dataset.sdAttempts || 0);
        if (attempts >= VISIBILITY_RETRIES) return;
        img.dataset.sdAttempts = String(attempts + 1);
        delete img.dataset.sdQueued;
        setTimeout(() => this.enqueue(img), VISIBILITY_RETRY_MS);
        return;
      }
      if (!this.isLarge(img)) return;
      if (!this.claim(img, url)) return;
      if (this.matches(img, this.selectors.ignore)) { img.dataset.sdSkip = 'ignore'; return; }

      // Lazy loaders hand out private object URLs that cannot be fetched again; the element itself is then the source.
      const element = url.startsWith('blob:') ? img : null;
      if (element && !(img.complete && img.naturalWidth)) { img.dataset.sdSkip = 'not-loaded'; return; }

      const soft = this.matches(img, this.selectors.invert);
      // Faded out while the replacement is prepared, so a fast scroll never shows the light original.
      img.dataset.sdPending = '1';
      const key = `${url}|${soft ? 'soft' : 'auto'}`;
      let entry = this.cache.get(key);
      if (!entry) {
        entry = await this.build(url, soft, element);
        this.cache.set(key, entry);
      }
      if (!entry || !entry.url) {
        img.dataset.sdSkip = (entry && entry.reason) || 'unprocessed';
        return;
      }

      img.dataset.sdSource = url;
      img.dataset.sdLocked = '1';
      if (img.srcset) { img.dataset.sdSrcset = img.srcset; img.srcset = ''; }
      if (img.sizes) img.sizes = '';
      img.dataset.sdDone = entry.kind;
      img.dataset.sdInfo = `${entry.info.kind}/${entry.info.colors}/${entry.info.midShare.toFixed(2)}/${entry.info.opaque.toFixed(2)}`;
      img.style.setProperty('filter', 'none', 'important');
      img.src = entry.url;
    }

    async build(url, soft, element) {
      let bitmap;
      try {
        bitmap = element || await loadBitmap(url);
      } catch (err) {
        return { reason: 'cross-origin' };
      }
      const naturalW = bitmap.width || bitmap.naturalWidth;
      const naturalH = bitmap.height || bitmap.naturalHeight;
      if (!naturalW || !naturalH) return { reason: 'empty' };

      const info = classify(bitmap, naturalW, naturalH);
      const kind = soft ? 'icon' : info.kind;
      if (!soft) {
        const minLight = info.kind === 'icon' ? MIN_LIGHT_SHARE_ICON : MIN_LIGHT_SHARE;
        if (info.lightShare < minLight) return { kind: 'skip-dark', reason: 'already-dark' };
        if (info.kind === 'photo' && info.meanLum < SKIP_DARK_PHOTO_BELOW) return { kind: 'skip-dark', reason: 'already-dark' };
        if (info.kind !== 'photo' && info.meanLum < SKIP_DARK_GRAPHIC_BELOW) return { kind: 'skip-dark', reason: 'already-dark' };
      }

      const scale = Math.min(1, MAX_SIDE / Math.max(naturalW, naturalH));
      const w = Math.max(1, Math.round(naturalW * scale));
      const h = Math.max(1, Math.round(naturalH * scale));
      const canvas = toneMap(bitmap, naturalW, naturalH, kind);
      const out = scale < 1 ? this.downscale(canvas, w, h) : canvas;
      const objectURL = await toObjectURL(out);
      return { url: objectURL, kind, info };
    }

    downscale(canvas, w, h) {
      const target = canvasOf(w, h);
      const ctx = target.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, w, h);
      return target;
    }
  }

  function restore() {
    if (stopper) {
      stopper();
      stopper = null;
    }
    document.querySelectorAll('img[data-sd-source]').forEach((img) => {
      const source = img.dataset.sdSource;
      const srcset = img.dataset.sdSrcset;
      delete img.dataset.sdDone;
      delete img.dataset.sdInfo;
      delete img.dataset.sdSkip;
      delete img.dataset.sdQueued;
      delete img.dataset.sdTracked;
      delete img.dataset.sdLocked;
      delete img.dataset.sdSource;
      delete img.dataset.sdAttempts;
      delete img.dataset.sdPending;
      img.style.removeProperty('filter');
      if (srcset) {
        img.srcset = srcset;
        delete img.dataset.sdSrcset;
      }
      if (source) img.src = source;
    });
  }

  let stopper = null;

  /* Counters for diagnostics: marker attributes do not survive in-place image swaps, these do. They are mirrored into
     `data-sd-images` on <html> so the page and the tests can read them without touching the isolated world. */
  const ledger = { started: 0, converted: 0, skipped: 0, kinds: {}, reasons: {} };

  function publishLedger() {
    const target = document.documentElement;
    if (target) target.dataset.sdImages = `${ledger.started}/${ledger.converted}/${JSON.stringify(ledger.reasons)}`;
  }

  const PENDING_CSS = 'img[data-sd-pending]{opacity:.25!important;transition:opacity .12s linear}';

  function mountStyle() {
    if (document.getElementById('smart-dark-images')) return;
    const style = document.createElement('style');
    style.id = 'smart-dark-images';
    style.textContent = PENDING_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function unmountStyle() {
    const style = document.getElementById('smart-dark-images');
    if (style) style.remove();
  }

  function start(options) {
    if (stopper) return Promise.resolve();
    mountStyle();
    const processor = new Processor(options.selectors);
    let active = true;
    const seen = new WeakSet();

    const consider = (el) => {
      if (!active || seen.has(el)) return;
      seen.add(el);
      processor.enqueue(el);
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          consider(entry.target);
        }
      });
    }, { rootMargin: PREFETCH_MARGIN });

    const track = () => {
      document.querySelectorAll('img').forEach((img) => {
        if (!img.dataset.sdTracked) {
          img.dataset.sdTracked = '1';
          observer.observe(img);
        }
      });
    };

    // Lazy loaders swap src after insertion, so a processed image can need a second pass.
    const refresh = (img) => {
      const current = img.currentSrc || img.src;
      if (img.dataset.sdLocked || current.startsWith('blob:')) return;
      if (img.dataset.sdDone && (!img.dataset.sdSource || img.dataset.sdSource === current)) return;
      if (img.dataset.sdQueued && !img.dataset.sdDone) return;
      delete img.dataset.sdDone;
      delete img.dataset.sdInfo;
      delete img.dataset.sdSkip;
      delete img.dataset.sdQueued;
      img.dataset.sdTracked = '1';
      processor.enqueue(img);
    };
    const sourceWatcher = new MutationObserver((list) => {
      if (!active) return;
      list.forEach((mutation) => {
        const img = mutation.target;
        if (img.tagName === 'IMG') refresh(img);
      });
    });

    const mutations = new MutationObserver((list) => {
      if (!active) return;
      for (const mutation of list) {
        mutation.addedNodes && mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'IMG') {
            if (!node.dataset.sdTracked) {
              node.dataset.sdTracked = '1';
              sourceWatcher.observe(node, { attributes: true, attributeFilter: ['src', 'srcset'] });
              observer.observe(node);
            }
          } else if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach((img) => {
              if (!img.dataset.sdTracked) {
                img.dataset.sdTracked = '1';
                sourceWatcher.observe(img, { attributes: true, attributeFilter: ['src', 'srcset'] });
                observer.observe(img);
              }
            });
          }
        });
      }
    });

    const watchSource = (img) => {
      sourceWatcher.observe(img, { attributes: true, attributeFilter: ['src', 'srcset'] });
    };
    document.querySelectorAll('img').forEach(watchSource);

    track();
    mutations.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState !== 'complete') window.addEventListener('load', track, { once: true });

    stopper = () => {
      active = false;
      unmountStyle();
      observer.disconnect();
      mutations.disconnect();
      sourceWatcher.disconnect();
      processor.queue.length = 0;
    };
    return Promise.resolve();
  }

  window.WDImagery = { start, stop: restore, restore, classify, CURVES };
})();
