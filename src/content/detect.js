/* Factory dark theme detection: declared signals first, then the page colours measured with our own theme switched off. */
(function () {
  'use strict';

  const DARK_LIGHTNESS = 0.6;
  const LIGHT_TEXT_LIGHTNESS = 0.4;
  const MIN_LIGHTNESS_FOR_TEXT_CHECK = 0.5;
  const SAMPLING_STEP = 256;
  const MAX_SAMPLES_PER_AXIS = 4;
  const MAX_ELEMENT_SAMPLES = 48;
  // A page that is lighter than this before any content exists is a skeleton, not a finished layout.
  const SKELETON_MAX_ELEMENTS = 16;
  // Below this many samples the page has hardly anything painted yet, so the measurement is not evidence.
  const MIN_SAMPLES_FOR_VERDICT = 6;
  const SKELETON_LIGHTNESS = 0.8;
  const OWN_BACKGROUNDS = new Set(['24,26,27', '33,36,38', '220,218,215']);
  const STRICTLY_DARK = /^(only\s+)?dark$/;
  const STRICTLY_LIGHT = /^(only\s+)?light$/;
  const DECLARED_DARK_CLASS = /(^|[\s_-])(dark|darkmode|dark-mode|darktheme|dark-theme|night|nightmode|night-mode|theme-dark|theme-darkmode)([\s_-]|$)/i;
  const DECLARED_LIGHT_CLASS = /(^|[\s_-])(light|lightmode|light-mode|lighttheme|light-theme|theme-light)([\s_-]|$)/i;
  const DARK_ATTRIBUTES = ['dark', 'dark-mode', 'darkmode', 'dark-theme', 'data-dark', 'night', 'night-mode', 'data-mode', 'data-color-mode', 'data-scheme', 'color-scheme'];
  const THEME_ATTRIBUTES = ['data-theme', 'theme', 'data-skin', 'data-style'];

  function parseColor(value) {
    if (!value) return null;
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function lightness(color) {
    const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function ownStyleSheets() {
    const fromNodes = Array.from(document.styleSheets).filter((sheet) => {
      const owner = sheet.ownerNode;
      return owner && owner.classList && owner.classList.contains('darkreader');
    });
    const adopted = Array.isArray(document.adoptedStyleSheets) ? Array.from(document.adoptedStyleSheets) : [];
    const fromAdopted = adopted.filter((sheet) => {
      const first = sheet.cssRules && sheet.cssRules[0];
      return first && first.selectorText && first.selectorText.startsWith('#__darkreader');
    });
    return fromNodes.concat(fromAdopted);
  }

  /** Measurements taken while our own theme is active would describe our repaint, not the site. */
  function withOwnThemeOff(measure) {
    const sheets = ownStyleSheets().filter((sheet) => !sheet.disabled);
    sheets.forEach((sheet) => { sheet.disabled = true; });
    try {
      return measure();
    } finally {
      sheets.forEach((sheet) => { sheet.disabled = false; });
    }
  }

  /* ---- declared signals: what the site says about itself ---- */

  function schemeOf(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (/^(only\s+)?(dark|night)$/.test(text)) return 'dark';
    if (/^(only\s+)?light$/.test(text)) return 'light';
    return null;
  }

  function classScheme(element) {
    if (!element || !element.classList) return null;
    if (element.classList.contains('dark') || element.classList.contains('night')) return 'dark';
    const name = element.getAttribute('class') || '';
    if (DECLARED_DARK_CLASS.test(name)) return 'dark';
    if (DECLARED_LIGHT_CLASS.test(name)) return 'light';
    return null;
  }

  function attributeScheme(element) {
    if (!element) return null;
    for (const name of DARK_ATTRIBUTES) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name);
      if (value === '' || value === 'true' || value === '1' || schemeOf(value) === 'dark') return 'dark';
    }
    for (const name of THEME_ATTRIBUTES) {
      const scheme = schemeOf(element.getAttribute(name));
      if (scheme) return scheme;
    }
    return null;
  }

  function declaredScheme() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta && (meta.content || '').trim().toLowerCase();
    if (content && STRICTLY_DARK.test(content)) return 'dark';
    if (content && STRICTLY_LIGHT.test(content)) return 'light';
    for (const element of [document.documentElement, document.body]) {
      if (!element) continue;
      const scheme = attributeScheme(element) || classScheme(element);
      if (scheme) return scheme;
    }
    return null;
  }

  /* ---- measured signals: what the page actually paints ---- */

  function samplePoints() {
    const width = innerWidth || document.documentElement.clientWidth;
    const height = innerHeight || document.documentElement.clientHeight;
    const stepX = Math.floor(width / Math.min(MAX_SAMPLES_PER_AXIS, Math.ceil(width / SAMPLING_STEP)) || width);
    const stepY = Math.floor(height / Math.min(MAX_SAMPLES_PER_AXIS, Math.ceil(height / SAMPLING_STEP)) || height);
    const points = [];
    for (let y = Math.floor(stepY / 2); y < height; y += stepY) {
      for (let x = Math.floor(stepX / 2); x < width; x += stepX) points.push([x, y]);
    }
    return points;
  }

  function isOwnColor(color) {
    return OWN_BACKGROUNDS.has(`${color.r},${color.g},${color.b}`);
  }

  /** True when the element paints something (colour or gradient) on its own background. */
  function paintsBackground(style) {
    const background = parseColor(style.backgroundColor);
    if (background && background.a === 1) {
      if (isOwnColor(background)) return false;
      return { color: background };
    }
    const image = style.backgroundImage;
    if (image && image !== 'none' && /gradient|url\(/.test(image)) return { image };
    return null;
  }

  /** Average colour of the nearest ancestor that actually paints, background images included. */
  function paintedBackdrop(element) {
    let node = element;
    let depth = 0;
    while (node && depth < 8) {
      if (node === document.documentElement || node === document.body) break;
      const style = getComputedStyle(node);
      const paint = paintsBackground(style);
      if (paint && paint.color) return paint.color;
      if (paint && paint.image) {
        const middle = paint.image.match(/rgb\(([^)]+)\)/g);
        if (middle && middle.length) {
          const colors = middle.map(parseColor).filter(Boolean);
          if (colors.length) {
            return {
              r: colors.reduce((sum, c) => sum + c.r, 0) / colors.length,
              g: colors.reduce((sum, c) => sum + c.g, 0) / colors.length,
              b: colors.reduce((sum, c) => sum + c.b, 0) / colors.length,
              a: 1,
            };
          }
        }
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /** Decisions are collected for the whole page, then combined — one odd spot must not decide the verdict. */
  function survey() {
    const root = document.documentElement;
    const rootStyle = getComputedStyle(root);
    const votes = [];
    const visited = new Set();

    for (const [x, y] of samplePoints()) {
      const element = document.elementFromPoint(x, y);
      if (!element || element.tagName === 'IMG' || visited.has(element)) continue;
      visited.add(element);
      const style = element === root ? rootStyle : getComputedStyle(element);
      const paint = paintsBackground(style);
      if (paint && paint.color) {
        votes.push(lightness(paint.color) > DARK_LIGHTNESS ? 'light' : 'dark');
        continue;
      }
      if (paint && paint.image) {
        const color = paintedBackdrop(element);
        if (color) {
          votes.push(lightness(color) > DARK_LIGHTNESS ? 'light' : 'dark');
          continue;
        }
      }
      const text = parseColor(style.color);
      if (!text) continue;
      votes.push(lightness(text) < LIGHT_TEXT_LIGHTNESS ? 'light' : 'dark');
    }

    // Text elements carry the site palette even when their boxes stay transparent.
    const pool = Array.from(document.querySelectorAll('h1,h2,p,li,span,a,button'))
      .filter((el) => (el.textContent || '').trim().length > 1 && el.getClientRects().length)
      .slice(0, MAX_ELEMENT_SAMPLES);
    for (const element of pool) {
      const backdrop = paintedBackdrop(element) || parseColor(getComputedStyle(element).backgroundColor);
      if (backdrop && !isOwnColor(backdrop) && backdrop.a === 1) {
        votes.push(lightness(backdrop) > DARK_LIGHTNESS ? 'light' : 'dark');
        continue;
      }
      const text = parseColor(getComputedStyle(element).color);
      if (!text) continue;
      votes.push(lightness(text) < LIGHT_TEXT_LIGHTNESS ? 'light' : 'dark');
    }

    // A web app paints its rows as divs with no text of their own; without this the pool is empty and a dark inbox
    // measures as if nothing were painted.
    if (votes.length < MIN_SAMPLES_FOR_VERDICT) {
      const containers = Array.from(document.querySelectorAll('div,td,section,article,aside,nav'))
        .filter((el) => el.getClientRects().length)
        .slice(0, MAX_ELEMENT_SAMPLES);
      for (const element of containers) {
        const style = getComputedStyle(element);
        const paint = paintsBackground(style);
        if (!paint) continue;
        if (paint.color) { votes.push(lightness(paint.color) > DARK_LIGHTNESS ? 'light' : 'dark'); continue; }
        const color = paintedBackdrop(element);
        if (color) votes.push(lightness(color) > DARK_LIGHTNESS ? 'light' : 'dark');
      }
    }

    const dark = votes.filter((vote) => vote === 'dark').length;
    return { dark, light: votes.length - dark, total: votes.length };
  }

  /** The page canvas (html/body paint) is the strongest single hint about the intended theme. */
  function canvasVote() {
    for (const element of [document.body, document.documentElement]) {
      if (!element) continue;
      const style = getComputedStyle(element);
      const paint = paintsBackground(style);
      if (!paint) continue;
      if (paint.color) return lightness(paint.color) > DARK_LIGHTNESS ? 'light' : 'dark';
      const color = paintedBackdrop(element);
      if (color) return lightness(color) > DARK_LIGHTNESS ? 'light' : 'dark';
    }
    return null;
  }

  function rootFallsBackToLight() {
    const root = document.documentElement;
    const rootColor = parseColor(getComputedStyle(root).backgroundColor);
    const bodyColor = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
    if (!bodyColor) return true;
    if (rootColor && bodyColor && rootColor.a === 0 && bodyColor.a === 0) {
      const text = parseColor(getComputedStyle(root).color);
      return !!text && lightness(text) > MIN_LIGHTNESS_FOR_TEXT_CHECK;
    }
    if (rootColor && isOwnColor(rootColor)) return true;
    if (isOwnColor(bodyColor)) return true;
    const base = rootColor ? (1 - rootColor.a) + rootColor.a * lightness(rootColor) : 1;
    return (1 - bodyColor.a) * base + bodyColor.a * lightness(bodyColor) >= 0.5;
  }

  /* A compact document can be complete even when its box is shorter than the viewport heuristics expect. */
  function hasSubstantiveContent() {
    const body = document.body;
    if (!body) return false;
    const isPlaceholder = (text) => /^(loading(?:\b|[.…]*)|please wait\b|initializing\b|skeleton\b)/i.test(text);
    const semanticBlocks = body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd');
    for (const element of semanticBlocks) {
      if (!element.getClientRects().length) continue;
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 12 && !isPlaceholder(text)) return true;
    }
    const lines = Array.from(new Set((body.innerText || '').split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !isPlaceholder(line))));
    return lines.join(' ').length >= 24;
  }

  /* An application shell lays out a few empty boxes before the real surface exists: a light body with no content yet is
     not evidence that the site is light, and such a verdict used to stick for the whole session (Gmail). */
  function looksLikeSkeleton() {
    const body = document.body;
    if (!body || hasSubstantiveContent()) return false;
    const elements = body.querySelectorAll('*');
    if (elements.length > SKELETON_MAX_ELEMENTS) return false;
    const canvas = canvasVote();
    if (canvas !== 'light') return false;
    const color = parseColor(getComputedStyle(body).backgroundColor);
    return !color || lightness(color) > SKELETON_LIGHTNESS;
  }

  /* The operating system preference is a hint, never a veto: it only decides a page that has nothing to measure. */
  function systemPrefersDark() {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (err) {
      return false;
    }
  }

  function measure() {
    if (getComputedStyle(document.documentElement).colorScheme === 'dark') return true;
    const result = survey();
    if (!result.total) return !rootFallsBackToLight();
    const share = result.dark / result.total;
    const canvas = canvasVote();
    // A light canvas needs a near-unanimous dark page to flip the verdict; a dark canvas needs only a clear majority.
    if (canvas === 'light') return share >= 0.75;
    if (canvas === 'dark') return share >= 0.34;
    return share >= 0.55;
  }

  function ready() {
    const body = document.body;
    if (!body) return false;
    if (body.childElementCount === 0) return false;
    if (body.clientHeight < 32 && !hasSubstantiveContent()) return false;
    for (const child of body.children) {
      const tag = child.tagName;
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'LINK') return true;
    }
    return false;
  }

  function detect() {
    if (!document.body) return { dark: false, reason: 'no-body', ready: false };
    if (looksLikeSkeleton()) {
      return { dark: systemPrefersDark(), reason: 'skeleton', ready: false };
    }
    const declared = declaredScheme();
    if (declared === 'light') return { dark: false, reason: 'declared-light', ready: true };
    if (declared === 'dark') return { dark: true, reason: 'declared-dark', ready: true };
    if (!ready()) return { dark: false, reason: 'not-ready', ready: false };

    const dark = withOwnThemeOff(measure);
    // A verdict taken from a near-empty page is weak evidence: `samples` lets the caller ask for a second look.
    const samples = withOwnThemeOff(() => survey().total);
    return { dark, reason: dark ? 'measured-dark' : 'measured-light', ready: true, samples };
  }

  window.WDDetect = { detect };
})();
