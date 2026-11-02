/* Factory dark theme detection: declared signals first, then colours measured with our own theme switched off. */
(function () {
  'use strict';

  const DARK_LIGHTNESS = 0.6;
  const LIGHT_TEXT_LIGHTNESS = 0.4;
  const MIN_LIGHTNESS_FOR_TEXT_CHECK = 0.5;
  const SAMPLING_STEP = 256;
  const MAX_SAMPLES_PER_AXIS = 4;
  const OWN_BACKGROUNDS = new Set(['24,26,27', '33,36,38', '220,218,215']);
  const STRICTLY_DARK = /^(only\s+)?dark$/;
  const STRICTLY_LIGHT = /^(only\s+)?light$/;

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

  function declaredDark() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta && (meta.content || '').trim().toLowerCase();
    if (content && STRICTLY_DARK.test(content)) return true;

    const root = document.documentElement;
    const body = document.body;
    if (root.classList.contains('dark') || (body && body.classList.contains('dark'))) return true;
    const theme = (root.dataset.theme || (body && body.dataset.theme) || '').toLowerCase();
    if (theme === 'dark') return true;
    const mode = (root.dataset.colorMode || (body && body.dataset.colorMode) || '').toLowerCase();
    if (mode === 'dark') return true;
    return false;
  }

  function declaredLight() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta && (meta.content || '').trim().toLowerCase();
    return !!content && STRICTLY_LIGHT.test(content);
  }

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

  function measure() {
    const root = document.documentElement;
    const rootStyle = getComputedStyle(root);
    if (rootStyle.colorScheme === 'dark') return true;

    let sawOpaque = false;
    const visited = new Set();
    for (const [x, y] of samplePoints()) {
      const element = document.elementFromPoint(x, y);
      if (!element || element.tagName === 'IMG' || visited.has(element)) continue;
      visited.add(element);
      const style = element === root ? rootStyle : getComputedStyle(element);
      const background = parseColor(style.backgroundColor);

      if (background && background.a === 1) {
        if (isOwnColor(background)) return false;
        sawOpaque = true;
        if (lightness(background) > DARK_LIGHTNESS) return false;
        continue;
      }
      if (!background || background.a < 1) {
        const text = parseColor(style.color);
        if (!text) return false;
        if (lightness(text) < LIGHT_TEXT_LIGHTNESS) return false;
      }
    }

    const rootColor = parseColor(rootStyle.backgroundColor);
    const bodyColor = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
    if (!bodyColor) return false;
    if (rootColor && bodyColor && rootColor.a === 0 && bodyColor.a === 0) {
      const text = parseColor(rootStyle.color);
      return !!text && lightness(text) > MIN_LIGHTNESS_FOR_TEXT_CHECK;
    }
    if (rootColor && isOwnColor(rootColor)) return false;
    if (isOwnColor(bodyColor)) return false;

    const base = rootColor ? (1 - rootColor.a) + rootColor.a * lightness(rootColor) : 1;
    return (1 - bodyColor.a) * base + bodyColor.a * lightness(bodyColor) < 0.5;
  }

  function ready() {
    const body = document.body;
    if (!body) return false;
    if (body.childElementCount === 0 || body.clientHeight < 32) return false;
    for (const child of body.children) {
      const tag = child.tagName;
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'LINK') return true;
    }
    return false;
  }

  function detect() {
    if (!document.body) return { dark: false, reason: 'no-body', ready: false };
    if (declaredLight()) return { dark: false, reason: 'declared-light', ready: true };
    if (declaredDark()) return { dark: true, reason: 'declared-dark', ready: true };
    if (!ready()) return { dark: false, reason: 'not-ready', ready: false };

    const dark = withOwnThemeOff(measure);
    return { dark, reason: dark ? 'measured-dark' : 'measured-light', ready: true };
  }

  window.WDDetect = { detect };
})();
