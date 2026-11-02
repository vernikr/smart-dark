/* Factory dark theme detection: samples the background the user actually sees plus declared signals. */
(function () {
  'use strict';

  const DARK_LUMINANCE = 0.18;
  const LIGHT_LUMINANCE = 0.5;
  const DARK_SHARE = 0.5;
  const LIGHT_SHARE = 0.5;
  const LIGHT_TEXT_LUMINANCE = 0.6;
  const MAX_TEXT_SAMPLES = 40;
  const MID_LUMINANCE = 0.35;
  const DARK_THEME_HINTS = /(^|\s)(dark|dark-mode|darkmode|theme-dark|night)(\s|$)/i;

  function parseColor(value) {
    if (!value) return null;
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    const alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.05 ? parts.slice(0, 3) : null;
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Luminance of the first painted ancestor background at a point. */
  function backgroundAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const style = getComputedStyle(el);
      if (style.visibility !== 'hidden' && style.display !== 'none') {
        const rgb = parseColor(style.backgroundColor);
        if (rgb) return luminance(rgb);
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  function sampleViewport() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const values = [];
    for (let row = 1; row <= 3; row++) {
      for (let col = 1; col <= 4; col++) {
        const value = backgroundAt((width * col) / 5, (height * row) / 4);
        if (value !== null) values.push(value);
      }
    }
    if (!values.length) return null;
    const dark = values.filter((v) => v <= DARK_LUMINANCE).length / values.length;
    const light = values.filter((v) => v >= LIGHT_LUMINANCE).length / values.length;
    return { darkShare: dark, lightShare: light, mean: values.reduce((a, b) => a + b, 0) / values.length };
  }

  function bodyLuminance() {
    const body = document.body;
    const root = document.documentElement;
    const fromBody = parseColor(body && getComputedStyle(body).backgroundColor);
    if (fromBody) return luminance(fromBody);
    const fromRoot = parseColor(getComputedStyle(root).backgroundColor);
    return fromRoot ? luminance(fromRoot) : null;
  }

  function textLuminance() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const values = [];
    let node = walker.nextNode();
    while (node && values.length < MAX_TEXT_SAMPLES) {
      const text = node.textContent && node.textContent.trim();
      if (text && text.length > 2 && node.parentElement && node.parentElement.getClientRects().length) {
        const rgb = parseColor(getComputedStyle(node.parentElement).color);
        if (rgb) values.push(luminance(rgb));
      }
      node = walker.nextNode();
    }
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  function declaredDark() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta && /dark/.test(meta.content || '')) return true;
    const root = document.documentElement;
    if (getComputedStyle(root).colorScheme === 'dark') return true;
    const hints = [root.getAttribute('data-theme'), root.getAttribute('data-color-mode'), root.className,
      document.body && document.body.getAttribute('data-theme'), document.body && document.body.className];
    if (hints.some((hint) => typeof hint === 'string' && DARK_THEME_HINTS.test(hint))) {
      return (bodyLuminance() || 1) <= DARK_LUMINANCE;
    }
    return false;
  }

  function detect() {
    if (!document.body) return { dark: false, reason: 'no-body', ready: false };
    const bodyLum = bodyLuminance();
    if (bodyLum !== null && bodyLum <= DARK_LUMINANCE) return { dark: true, reason: 'body-background', ready: true };

    if (bodyLum !== null && bodyLum >= LIGHT_LUMINANCE) return { dark: false, reason: 'body-background', ready: true };

    const viewport = sampleViewport();
    if (viewport && viewport.darkShare >= DARK_SHARE) return { dark: true, reason: 'viewport-background', ready: true };
    if (viewport && viewport.lightShare >= LIGHT_SHARE) return { dark: false, reason: 'viewport-background', ready: true };
    if (bodyLum !== null && bodyLum >= MID_LUMINANCE) return { dark: false, reason: 'body-background', ready: true };

    const text = textLuminance();
    if (text !== null && text >= LIGHT_TEXT_LUMINANCE) return { dark: true, reason: 'light-text', ready: true };
    if (declaredDark()) return { dark: true, reason: 'declared-scheme', ready: true };
    return { dark: false, reason: 'inconclusive', ready: viewport !== null };
  }

  window.WDDetect = { detect };
})();
