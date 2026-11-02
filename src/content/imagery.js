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
  // A flip that leaves this much more of the frame light than before is not an improvement, it is a mess.
  const FLIP_LIGHT_WORSENS = 0.05;
  // A flip that keeps less than this share of the original edge contrast has destroyed the drawing.
  const FLIP_CONTRAST_FLOOR = 0.45;

  /* `dim` is not a class of picture, it is the verdict on one: the picture is dark enough or detailed enough that
     inverting it would make it worse, so it gets the photographic curve — darkened, never inverted. */
  const CURVES = {
    icon: { flip: false, floor: 0.300, ceil: 0.880, sat: 1.10 },
    graphic: { flip: true, floor: 0.135, ceil: 0.880, sat: 1.20 },
    photo: { flip: false, floor: 0.060, ceil: 0.640, sat: 1.06 },
    dim: { flip: false, floor: 0.060, ceil: 0.640, sat: 1.06 },
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
    // Flat art is posterised: a real photograph keeps hundreds of distinct colours at this grid, an illustration
    // of a few brand colours keeps tens, however bright its background is.
    else if (seen.size <= 64 || midShare < 0.18) kind = 'graphic';
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

  /* A CDN that answers `Access-Control-Allow-Origin: *` rejects any request carrying cookies, so the anonymous
     attempt comes first and credentials are only added for hosts that need a session. */
  async function fetchBody(url) {
    const attempts = [{ credentials: 'omit' }, { credentials: 'include' }];
    let last = 'fetch-failed';
    for (const options of attempts) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) { last = `http-${response.status}`; continue; }
        let blob;
        try { blob = await response.blob(); } catch (err) { last = 'empty-body'; continue; }
        if (blob && blob.size) return blob;
        last = 'empty-body';
      } catch (err) {
        last = 'cross-origin';
      }
    }
    throw new Error(last);
  }

  async function loadBitmap(url) {
    if (url.startsWith('data:')) return decodeBlob(await (await fetch(url)).blob());
    return decodeBlob(await fetchBody(url));
  }

  /* A picture whose own box never reported a size is judged by the frame it was drawn in. */
  function fallbackBox(img) {
    const frame = img.parentElement;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT ? rect : null;
  }

  /* Lazy loaders park a 1×1 transparent GIF in `src` and keep the real frame in a `<source srcset>`. Reading the
     element then means reading the placeholder: the picture came out as a one-pixel "graphic" and the article showed
     nothing. The frame that will actually be painted is resolved here instead. */
  const PLACEHOLDER_PX = 4;

  function srcsetFrames(value) {
    return String(value || '')
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function pictureFrames(img) {
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (!picture) return [];
    return [...picture.querySelectorAll('source')].flatMap((source) => srcsetFrames(source.getAttribute('srcset')));
  }

  /* Sources that were emptied by an earlier swap are still listed in the parked attribute. */
  function parkedFrames(img) {
    const parked = (() => {
      try { return JSON.parse(img.dataset[SD_PARKED] || 'null'); } catch (err) { return null; }
    })();
    if (!Array.isArray(parked)) return [];
    return parked.filter(Boolean).flatMap(srcsetFrames);
  }

  function isPlaceholder(bitmap) {
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    return w > 0 && h > 0 && w <= PLACEHOLDER_PX && h <= PLACEHOLDER_PX;
  }

  function absolute(url) {
    try { return new URL(url, location.href).href; } catch (err) { return url; }
  }

  /* Mean and vertical gradient of a thumbnail-sized copy: the cheapest way to ask "did this get lighter?" */
  function thumbnailStats(source) {
    const w = Math.min(160, source.width || 160);
    const h = Math.max(1, Math.round(w * (source.height || 1) / (source.width || 1)));
    const canvas = canvasOf(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const luma = new Float32Array(w * h);
    let sum = 0;
    let light = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const l = (LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]) / 255;
      luma[p] = l;
      sum += l;
      if (l > LIGHT_PIXEL_LUMA) light++;
    }
    let gradient = 0;
    let pairs = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 1; x < w; x++) {
        gradient += Math.abs(luma[row + x] - luma[row + x - 1]);
        pairs++;
      }
    }
    return { mean: sum / Math.max(1, w * h), light: light / Math.max(1, w * h), gradient: gradient / Math.max(1, pairs) };
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

    /* Faded-out candidates still count: reveal animations start at opacity 0, and waiting for them let the light
       original show first. A hidden or unlaid-out element is what must be postponed, not a transparent one. */
    isVisible(el) {
      if (!el.getClientRects().length && !fallbackBox(el)) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
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
        img.dataset.sdSkip = err && (err.message || err.name) ? String(err.message || err.name) : 'error';
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
      if (!url || url.startsWith('data:image/svg') || /\.svg(\?|#|$)/i.test(url)) { img.dataset.sdSkip = 'vector'; return; }
      // Images that fade in or mount late are retried shortly instead of being dropped.
      if (!this.isVisible(img)) {
        const attempts = Number(img.dataset.sdAttempts || 0);
        if (attempts >= VISIBILITY_RETRIES) { img.dataset.sdSkip = 'not-visible'; return; }
        img.dataset.sdAttempts = String(attempts + 1);
        delete img.dataset.sdQueued;
        setTimeout(() => this.enqueue(img), VISIBILITY_RETRY_MS);
        return;
      }
      if (!this.isLarge(img) && !fallbackBox(img)) { img.dataset.sdSkip = 'small'; return; }
      if (this.matches(img, this.selectors.ignore)) { img.dataset.sdSkip = 'ignore'; return; }

      // Lazy loaders hand out private object URLs that cannot be fetched again; the element itself is then the source.
      let element = url.startsWith('blob:') ? img : null;
      let frameUrl = url;
      if (!element && img.complete && img.naturalWidth && isPlaceholder(img)) {
        // The element holds the 1×1 stand-in, so the picture has to be read from the frame the browser will paint.
        const candidates = [...parkedFrames(img), ...pictureFrames(img), ...srcsetFrames(img.getAttribute('srcset'))]
          .map(absolute)
          .filter((candidate) => candidate && candidate !== url && !candidate.startsWith('data:'));
        if (!candidates.length) { img.dataset.sdSkip = 'placeholder'; return; }
        frameUrl = candidates[candidates.length - 1];
      } else if (element && isPlaceholder(img)) {
        return { reason: 'placeholder' };
      }
      if (!this.claim(img, frameUrl)) { if (!img.dataset.sdDone) img.dataset.sdSkip = 'claimed'; return; }

      const soft = this.matches(img, this.selectors.invert);
      // Faded out while the replacement is prepared, so a fast scroll never shows the light original.
      img.dataset.sdPending = '1';
      const key = `${frameUrl}|${soft ? 'soft' : 'auto'}`;
      let entry = this.cache.get(key);
      if (!entry) {
        entry = await this.build(frameUrl, soft, element);
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
      neutralizeSources(img);
      img.dataset.sdDone = entry.kind;
      img.dataset.sdInfo = `${entry.info.kind}/${entry.info.colors}/${entry.info.midShare.toFixed(2)}/${entry.info.opaque.toFixed(2)}`;
      img.style.setProperty('filter', 'none', 'important');
      img.dataset.sdBlob = entry.url;
      img.src = entry.url;
    }

    async build(url, soft, element) {
      let bitmap;
      try {
        bitmap = element || await loadBitmap(url);
      } catch (err) {
        // fetchBody names the cause (`http-403`, `empty-body`, `cross-origin`); a decode failure is its own reason.
        const message = err && err.message ? String(err.message) : '';
        const named = /^(cross-origin|empty-body|http-\d{3}|fetch-failed|decode-failed)$/.test(message);
        return { reason: named ? message : 'decode-failed' };
      }
      if (isPlaceholder(bitmap)) {
        // Deliberately unsupported: a real frame of this picture was tried and there is nothing to read.
        return { kind: 'skip-dark', reason: 'placeholder' };
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
      const before = soft ? null : thumbnailStats(bitmap);
      let finalKind = kind;
      let canvas = toneMap(bitmap, naturalW, naturalH, finalKind);
      let dimmed = null;
      if (!soft) {
        // A polarity flip turns dark art with bright lettering into a light page with dark lettering — the exact
        // result the user asked to avoid. A flattening flip (light ink on a dark plate) loses most of its edge
        // contrast and cannot be read at all. Such a picture is dimmed like a photograph instead.
        if (finalKind === 'graphic') {
          const flipped = thumbnailStats(canvas);
          const lighter = flipped.light - before.light >= FLIP_LIGHT_WORSENS;
          const flattened = flipped.gradient < before.gradient * FLIP_CONTRAST_FLOOR;
          if (lighter || flattened) {
            finalKind = 'dim';
            dimmed = thumbnailStats(toneMap(bitmap, naturalW, naturalH, 'photo'));
            if (dimmed.light > before.light + FLIP_LIGHT_WORSENS) {
              return { kind: 'skip-dark', reason: 'already-dark' };
            }
            canvas = toneMap(bitmap, naturalW, naturalH, 'photo');
          }
        }
        // A flip that keeps almost none of the original edge contrast (a small low-contrast illustration) reads as
        // a flat plate. Keep the dim instead when the flip destroys detail the eye needs.
        if (finalKind !== 'dim') {
          const result = thumbnailStats(canvas);
          if (result.gradient < before.gradient * FLIP_CONTRAST_FLOOR) {
            finalKind = 'dim';
            canvas = toneMap(bitmap, naturalW, naturalH, 'photo');
          }
        }
      }
      const out = scale < 1 ? this.downscale(canvas, w, h) : canvas;
      const objectURL = await toObjectURL(out);
      return { url: objectURL, kind: soft ? 'icon' : (finalKind === 'dim' ? 'dim' : finalKind), info };
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

  /* A responsive `<picture>` picks its source from the `<source srcset>` children, and that choice wins over `img.src`:
     after the swap the browser kept showing the bright original while our dark blob sat unused in `src`. The sources are
     parked in a data attribute (not deleted) so turning images off puts the page back exactly as it was. */
  const SD_PARKED = 'sdSources';

  function parkedOf(img) {
    try {
      const value = img.dataset[SD_PARKED];
      return value ? JSON.parse(value) : null;
    } catch (err) { return null; }
  }

  /* A site can put `srcset` back after the swap, so this runs on every failed re-assert and merges what it finds:
     the first value seen per <source> is what restore() has to return, later ones are just the site repeating itself. */
  function neutralizeSources(img) {
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (!picture) return;
    const sources = [...picture.querySelectorAll('source')];
    const live = sources.filter((source) => source.hasAttribute('srcset'));
    if (!live.length) return;
    const parked = parkedOf(img) || sources.map(() => null);
    sources.forEach((source, index) => {
      const value = source.getAttribute('srcset');
      if (!value) return;
      if (!parked[index]) parked[index] = value;
      source.removeAttribute('srcset');
    });
    img.dataset[SD_PARKED] = JSON.stringify(parked);
  }

  function restoreSources(img) {
    const parked = parkedOf(img);
    if (!parked) return;
    delete img.dataset[SD_PARKED];
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (!picture) return;
    [...picture.querySelectorAll('source')].forEach((source, index) => {
      const value = parked[index];
      if (typeof value === 'string' && value && !source.hasAttribute('srcset')) source.setAttribute('srcset', value);
    });
  }

  function restore() {
    if (stopper) {
      stopper();
      stopper = null;
    }
    document.querySelectorAll('img[data-sd-source]').forEach((img) => {
      const source = img.dataset.sdSource;
      const srcset = img.dataset.sdSrcset;
      restoreSources(img);
      delete img.dataset.sdDone;
      delete img.dataset.sdInfo;
      delete img.dataset.sdSkip;
      delete img.dataset.sdQueued;
      delete img.dataset.sdTracked;
      delete img.dataset.sdLocked;
      delete img.dataset.sdSource;
      delete img.dataset.sdBlob;
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

    /* Frameworks re-render an image after we swapped it, putting back `srcset` on the element or on its <source>
       children, and occasionally the original `src`. Both outrank our frame, so the picture went back to the light
       original on its own. A converted image is re-asserted instead of being handed back to the queue. */
    const hasLiveSources = (img) => {
      const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
      return !!(picture && picture.querySelector('source[srcset]'));
    };

    const holdOwn = (img) => {
      const blob = img.dataset.sdBlob;
      if (!blob) return;
      const attr = img.getAttribute('src') || '';
      if (attr !== blob && !attr.startsWith('blob:')) img.src = blob;
      if (img.srcset) {
        if (!img.dataset.sdSrcset) img.dataset.sdSrcset = img.getAttribute('srcset');
        img.srcset = '';
        if (img.sizes) img.sizes = '';
      }
      neutralizeSources(img);
    };

    // Lazy loaders swap src after insertion, so a processed image can need a second pass.
    const refresh = (img) => {
      const attr = img.getAttribute('src') || '';
      const current = img.currentSrc || img.src || attr;
      if (img.dataset.sdLocked) {
        // A re-render put a source back. A recycled card may legitimately hold a different picture, so only a new URL
        // without any returning <source> is handed to the queue; anything else is the old frame coming back.
        const source = img.dataset.sdSource || '';
        const fresh = attr && attr !== img.dataset.sdBlob && attr !== source && !attr.startsWith('blob:');
        if (fresh && !hasLiveSources(img)) {
          delete img.dataset.sdLocked;
          delete img.dataset.sdDone;
          delete img.dataset.sdInfo;
          delete img.dataset.sdBlob;
          delete img.dataset.sdTracked;
          restoreSources(img);
          processor.enqueue(img);
          return;
        }
        holdOwn(img);
        return;
      }
      if (current.startsWith('blob:')) return;
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
