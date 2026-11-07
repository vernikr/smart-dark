/* Orchestrates detection, the theme layer and image darkening for the current site. */
(function () {
  'use strict';

  const { API, FRAME_ID, getSettings, domainKey } = window.WD;
  const isTopFrame = window === window.top;
  const key = domainKey();

  const state = {
    factoryDark: null,
    reason: null,
    detected: false,
    darkApplied: false,
    images: false,
    fixes: { invert: [], ignore: [] },
    reviewCount: 0,
  };

  const THEME = {
    mode: 1,
    brightness: 100,
    contrast: 100,
    grayscale: 0,
    sepia: 0,
    useFont: false,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    textStroke: 0,
    darkSchemeBackgroundColor: '#181a1b',
    darkSchemeTextColor: '#e8e6e3',
    lightSchemeBackgroundColor: '#dcdad7',
    lightSchemeTextColor: '#181a1b',
    scrollbarColor: 'auto',
    selectionColor: 'auto',
    styleSystemControls: true,
    // Irreplaceable media: the theme must never paint over video, canvas or the player chrome.
    ignoreImageAnalysis: ['video', 'canvas', 'picture', 'iframe', '.html5-video-player'],
  };

  const MEDIA_SAFE = THEME.ignoreImageAnalysis;

  /* Fix lists are written for sites that ship no dark theme of their own; once a site declares dark, its own player
     and artwork are already correct, so those fixes are dropped instead of being layered on top. */
  function fixesFor(factoryDark) {
    if (factoryDark === true) return { invert: [], ignore: state.fixes.ignore };
    return state.fixes;
  }

  const MEDIA_CONTAINER = /(^|[\s.#_-])(video|player|media)([\s.#_:-]|$)/i;

  /* Inverting a player wrapper flips the clip with it, so those fixes are dropped once the page has a video. */
  function invertSelectors() {
    const hasVideo = !!document.querySelector('video');
    if (!hasVideo) return state.fixes.invert;
    return state.fixes.invert.filter((selector) => !MEDIA_CONTAINER.test(selector));
  }

  const SITE_COMPAT_STYLE_ID = 'smart-dark-site-compatibility';

  /* Gmail animates its search field between the light and focused backgrounds. During a theme switch that
     transition exposes a brief white flash. This narrow accessible-name selector is inert on pages without Gmail's
     search field, so the rule can be installed before the mail application finishes mounting its controls. */
  function updateSiteCompatibilityStyles(enabled) {
    const existing = document.getElementById(SITE_COMPAT_STYLE_ID);
    if (!enabled) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = SITE_COMPAT_STYLE_ID;
    style.textContent = 'input[aria-label="Search mail"] { transition: none !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  const INLINE_BG_COLOR = 'var(--darkreader-inline-bgcolor)';
  const inlineBackgroundOverrides = new Map();
  let inlineBackgroundObserver = null;

  function restoreInlineBackground(element, original) {
    const properties = [
      'background', 'background-color', 'background-image', 'background-position',
      'background-position-x', 'background-position-y', 'background-size', 'background-repeat',
      'background-attachment', 'background-origin', 'background-clip',
    ];
    properties.forEach((property) => element.style.removeProperty(property));
    original.declarations.forEach(({ property, value, priority }) => element.style.setProperty(property, value, priority));
  }

  function readInlineBackground(element) {
    const source = element.getAttribute('style') || '';
    const declarations = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    let escaped = false;
    const add = (end) => {
      const declaration = source.slice(start, end);
      const colon = declaration.indexOf(':');
      if (colon <= 0) return;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      if (property !== 'background' && !property.startsWith('background-')) return;
      let value = declaration.slice(colon + 1).trim();
      let priority = '';
      const important = value.toLowerCase().lastIndexOf('!important');
      if (important >= 0 && !value.slice(important + 10).trim()) {
        value = value.slice(0, important).trim();
        priority = 'important';
      }
      declarations.push({ property, value, priority });
    };
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
      else if (char === ';' && depth === 0) { add(i); start = i + 1; }
    }
    add(source.length);
    return { declarations, applied: '' };
  }

  function restoreInlineBackgroundOverrides() {
    for (const [element, original] of inlineBackgroundOverrides) restoreInlineBackground(element, original);
    inlineBackgroundOverrides.clear();
  }

  function updateInlineBackground(element) {
    if (!(element instanceof Element) || !element.style) return;
    const original = inlineBackgroundOverrides.get(element);
    const hasDarkReaderColor = element.hasAttribute('data-darkreader-inline-bgcolor');
    const value = element.style.getPropertyValue('background-color').trim();
    const priority = element.style.getPropertyPriority('background-color');
    if (!hasDarkReaderColor) {
      if (original) {
        if (value === original.applied && priority === 'important') restoreInlineBackground(element, original);
        inlineBackgroundOverrides.delete(element);
      }
      return;
    }
    if (original && value === original.applied && priority === 'important') return;
    const backgroundPriority = element.style.getPropertyPriority('background');
    if (!original && priority !== 'important' && backgroundPriority !== 'important') return;
    if (original && priority !== 'important' && backgroundPriority !== 'important') {
      inlineBackgroundOverrides.delete(element);
      return;
    }
    const saved = original || readInlineBackground(element);
    inlineBackgroundOverrides.set(element, saved);
    element.style.setProperty('background-color', INLINE_BG_COLOR, 'important');
    const converted = getComputedStyle(element).backgroundColor;
    if (!/^rgba?\(/.test(converted)) {
      restoreInlineBackground(element, saved);
      inlineBackgroundOverrides.delete(element);
      return;
    }
    saved.applied = converted;
    element.style.setProperty('background-color', converted, 'important');
  }

  function updateInlineBackgrounds(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('[data-darkreader-inline-bgcolor]')) updateInlineBackground(root);
    root.querySelectorAll('[data-darkreader-inline-bgcolor]').forEach(updateInlineBackground);
  }

  function cleanDetachedInlineBackgrounds(root) {
    if (!(root instanceof Element)) return;
    const elements = [root, ...root.querySelectorAll('*')];
    for (const element of elements) {
      if (element.isConnected) continue;
      const original = inlineBackgroundOverrides.get(element);
      if (!original) continue;
      restoreInlineBackground(element, original);
      inlineBackgroundOverrides.delete(element);
    }
  }

  function watchInlineImportantBackgrounds() {
    if (!inlineBackgroundObserver) {
      inlineBackgroundObserver = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') updateInlineBackground(record.target);
          else {
            record.removedNodes.forEach(cleanDetachedInlineBackgrounds);
            record.addedNodes.forEach(updateInlineBackgrounds);
          }
        }
      });
      inlineBackgroundObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-darkreader-inline-bgcolor'],
        childList: true,
        subtree: true,
      });
    }
    updateInlineBackgrounds(document.documentElement);
  }

  function stopWatchingInlineImportantBackgrounds() {
    if (!inlineBackgroundObserver) return;
    inlineBackgroundObserver.disconnect();
    inlineBackgroundObserver = null;
  }

  function applyTheme(on) {
    if (!window.DarkReader) return;
    updateSiteCompatibilityStyles(on);
    const fixes = fixesFor(state.factoryDark);
    const invert = invertSelectors();
    const key = `${state.factoryDark}|${invert.join('|')}`;
    // A video can arrive after the first paint and change which fixes are safe, so the key decides, not just the flag.
    if (state.darkApplied === on && state.styleKey === key) return;
    try {
      if (on) {
        const ignore = [...MEDIA_SAFE, ...fixes.ignore];
        window.DarkReader.enable(THEME, { invert, ignoreImageAnalysis: ignore });
        watchInlineImportantBackgrounds();
      } else {
        stopWatchingInlineImportantBackgrounds();
        try {
          window.DarkReader.disable();
        } finally {
          restoreInlineBackgroundOverrides();
        }
      }
      state.darkApplied = on;
      state.styleKey = key;
    } catch (err) { /* unsupported document */ }
  }

  function stopImages() {
    if (!state.images) return;
    state.images = false;
    if (window.WDImagery && window.WDImagery.stop) window.WDImagery.stop();
  }

  function startImages() {
    if (state.images) return;
    state.images = true;
    state.imageError = null;
    try {
      const started = window.WDImagery.start({ selectors: { invert: state.fixes.invert, ignore: state.fixes.ignore } });
      started.then(() => { if (state.images) return; }).catch((err) => {
        state.imageError = String(err && err.message ? err.message : err);
      });
    } catch (err) {
      state.imageError = String(err && err.message ? err.message : err);
    }
  }

  function mirror() {
    document.documentElement.dataset.sdState = JSON.stringify({
      factoryDark: state.factoryDark,
      detected: state.detected,
      dark: state.darkApplied,
      reason: state.reason,
      imageError: state.imageError || null,
      video: !!document.querySelector('video'),
      invertCount: invertSelectors().length,
      styleKey: state.styleKey || null,
      reviewCount: state.reviewCount,
    });
  }

  function snapshot() {
    return {
      type: 'wd-state',
      frame: FRAME_ID,
      key,
      isTopFrame,
      factoryDark: state.factoryDark,
      detected: state.detected,
      dark: state.darkApplied,
      images: state.images,
      hasImages: document.images.length > 0,
    };
  }

  /* Sites announce their theme late (YouTube sets <html dark> after its first paint), so declared signals always win
     over the measured ones. An unfinished page is not evidence at all: `not-ready` and `skeleton` never decide
     anything, they only say "ask again". A measured verdict can be revised while meaningful theme signals keep
     changing — Gmail is an application shell that lays out before its dark surface exists. Ordinary feed churn does
     not keep the verdict open indefinitely; after REVISION_QUIET_MS without a relevant theme change it is final. */
  const REVISION_QUIET_MS = 12000;
  let lastChangeAt = Date.now();
  let reviewTimer = null;
  let reviewFrame = 0;

  /* A page can produce thousands of mutations while rendering a feed. Theme detection is expensive, so only
     meaningful theme changes schedule it, and bursts are collapsed into one delayed render. */
  function scheduleThemeReview(delay = 160) {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      if (reviewFrame) return;
      const run = () => {
        reviewFrame = 0;
        render();
      };
      if (typeof requestAnimationFrame === 'function') reviewFrame = requestAnimationFrame(run);
      else run();
    }, delay);
  }

  function markThemeChanged(delay = 160) {
    lastChangeAt = Date.now();
    scheduleThemeReview(delay);
  }

  function isElement(node) {
    return !!node && node.nodeType === Node.ELEMENT_NODE;
  }

  function hasRelevantNode(node, selector) {
    if (!isElement(node)) return false;
    return node.matches(selector) || !!(node.querySelector && node.querySelector(selector));
  }

  function isOwnedStyle(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return false;
    const style = element.closest && element.closest('style.darkreader, #smart-dark-images, #smart-dark-site-compatibility');
    return !!style || !!(element.matches && element.matches('style.darkreader, #smart-dark-images, #smart-dark-site-compatibility'));
  }

  function detect() {
    state.reviewCount++;
    const result = window.WDDetect.detect();
    if (result.reason === 'no-body') return result.dark;
    const declared = result.reason.indexOf('declared-') === 0;
    if (result.reason === 'not-ready' || result.reason === 'skeleton') {
      // Nothing to learn from this pass. Whatever we knew before stands, and nothing is claimed.
      if (!state.detected) state.reason = result.reason;
      return result.dark;
    }
    if (declared) {
      state.factoryDark = result.dark;
      state.reason = result.reason;
      state.detected = true;
      return result.dark;
    }
    // A declared verdict is the site speaking for itself; only a measurement may be revised, and only while the page
    // is still being built.
    const declaredBefore = state.reason && state.reason.indexOf('declared-') === 0;
    const quietFor = Date.now() - lastChangeAt;
    const revisable = !state.detected || (!declaredBefore && quietFor < REVISION_QUIET_MS);
    if (revisable) {
      state.factoryDark = result.dark;
      state.reason = result.reason;
      state.detected = true;
    }
    return state.factoryDark;
  }

  function render() {
    return getSettings().then((settings) => {
      detect();
      const forced = window.WD.isDarkSite(settings, key);
      const factoryDark = state.factoryDark;

      const wantTheme = forced === true ? true : forced === false ? false : factoryDark !== true;
      // A site with its own dark theme keeps it: the forced layer only corrects that site's remaining light corners.
      applyTheme(wantTheme);
      if (window.WD.imagesEnabled(settings, key)) startImages();
      else stopImages();
      mirror();
      return snapshot();
    });
  }

  function loadFixes() {
    return fetch(API.runtime.getURL('data/fixes.json'))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;
        const host = location.hostname.replace(/^www\./, '');
        const matches = (pattern) => {
          const clean = pattern.replace(/^https?:\/\//, '').replace(/^www\./, '');
          const slash = clean.indexOf('/');
          const hostPart = (slash < 0 ? clean : clean.slice(0, slash)).replace(/^www\./, '');
          if (!hostPart) return false;
          if (hostPart === '*') return true;
          if (hostPart.startsWith('*.')) {
            const base = hostPart.slice(2);
            return host === base || host.endsWith('.' + base);
          }
          return host === hostPart || host.endsWith('.' + hostPart);
        };
        const invert = new Set();
        const ignore = new Set();
        Object.keys(data).forEach((pattern) => {
          if (!matches(pattern)) return;
          (data[pattern].invert || []).forEach((sel) => invert.add(sel));
          (data[pattern].ignore || []).forEach((sel) => ignore.add(sel));
        });
        state.fixes = { invert: [...invert], ignore: [...ignore] };
      })
      .catch(() => { /* fixes are optional */ });
  }

  API.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.type !== 'wd-command') return undefined;
    if (msg.action === 'get') {
      respond(snapshot());
      return true;
    }
    if (msg.action === 'redetect') {
      detect();
      render().then(respond);
      return true;
    }
    if (msg.action === 'set') {
      getSettings().then((settings) => {
        const patch = {};
        if (typeof msg.dark === 'boolean') {
          patch.darkSites = Object.assign({}, settings.darkSites, { [key]: msg.dark });
        }
        if (typeof msg.images === 'boolean') {
          patch.imageSites = Object.assign({}, settings.imageSites, { [key]: msg.images });
        }
        return window.WD.setSettings(patch);
      }).then(render).then(respond);
      return true;
    }
    return undefined;
  });

  API.storage.onChanged.addListener((changes) => {
    if (changes.darkSites || changes.imageSites) render();
  });

  function boot() {
    loadFixes().then(() => {
      render();
      const settle = () => render().then(() => {
        setTimeout(() => render(), 400);
        setTimeout(() => render(), 1500);
        setTimeout(() => render(), 3000);
      });
      const watchAnnouncements = () => {
        const attributes = [
          'class', 'style', 'dark', 'dark-mode', 'darkmode', 'dark-theme', 'data-dark', 'night', 'night-mode',
          'data-theme', 'theme', 'data-skin', 'data-style', 'data-mode', 'data-color-mode', 'data-scheme', 'color-scheme',
        ];
        const themeAttributes = new MutationObserver(() => markThemeChanged(80));
        [document.documentElement, document.body].forEach((element) => {
          if (element) themeAttributes.observe(element, { attributes: true, attributeFilter: attributes });
        });

        const styleChanged = (records) => {
          const relevant = records.some((record) => {
            if (record.type === 'attributes') {
              const target = record.target;
              const themeMeta = target.matches && target.matches('meta[name="color-scheme"]');
              return themeMeta || (
                hasRelevantNode(target, 'style, link[rel~="stylesheet"]') && !isOwnedStyle(target)
              );
            }
            const target = record.target;
            const element = isElement(target) ? target : target && target.parentElement;
            if (element && element.tagName === 'STYLE' && !isOwnedStyle(element)) return true;
            return [...record.addedNodes, ...record.removedNodes]
              .some((node) => (
                hasRelevantNode(node, 'style, link[rel~="stylesheet"], meta[name="color-scheme"]') &&
                !isOwnedStyle(node)
              ));
          });
          if (relevant) markThemeChanged(180);
        };

        if (document.head) {
          const headObserver = new MutationObserver(styleChanged);
          headObserver.observe(document.head, {
            attributes: true,
            attributeFilter: ['href', 'disabled', 'media', 'name', 'content'],
            childList: true,
            subtree: true,
            characterData: true,
          });
          document.head.addEventListener('load', (event) => {
            if (event.target && event.target.matches && event.target.matches('link[rel~="stylesheet"]')) {
              markThemeChanged(120);
            }
          }, true);
        }

        let hasVideo = !!document.querySelector('video');
        const darkFlags = new Set([
          'dark', 'dark-mode', 'darkmode', 'dark-theme', 'data-dark', 'night', 'night-mode',
        ]);
        const themeAttributeNames = new Set([
          'data-theme', 'theme', 'data-skin', 'data-style', 'data-mode', 'data-color-mode',
          'data-scheme', 'color-scheme',
        ]);
        const contentObserver = new MutationObserver((records) => {
          let videoChanged = false;
          let stylesheetChanged = false;
          let declaredThemeChanged = false;
          for (const record of records) {
            if (record.type === 'attributes') {
              const target = record.target;
              const value = record.attributeName === 'class'
                ? String(target.className || '')
                : target.getAttribute(record.attributeName) || '';
              if (record.attributeName === 'style') {
                if (/background|color-scheme/i.test(value)) declaredThemeChanged = true;
              } else if (record.attributeName === 'class') {
                if (/(^|[\s_-])(dark|darkmode|dark-mode|darktheme|dark-theme|night|nightmode|night-mode|theme-dark|theme-darkmode|light|lightmode|light-mode|lighttheme|light-theme|theme-light)([\s_-]|$)/i.test(value)) {
                  declaredThemeChanged = true;
                }
              } else if (darkFlags.has(record.attributeName)) {
                declaredThemeChanged = target.hasAttribute(record.attributeName) &&
                  (!value.trim() || /^(true|1|dark|night)$/i.test(value.trim()));
              } else if (themeAttributeNames.has(record.attributeName)) {
                declaredThemeChanged = /^(only\s+)?(dark|night|light)$/i.test(value.trim());
              }
              continue;
            }
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
              if (!isElement(node)) continue;
              if (!videoChanged && hasRelevantNode(node, 'video')) {
                const current = !!document.querySelector('video');
                if (current !== hasVideo) {
                  hasVideo = current;
                  videoChanged = true;
                }
              }
              if (!stylesheetChanged && hasRelevantNode(node, 'style, link[rel~="stylesheet"]') && !isOwnedStyle(node)) {
                stylesheetChanged = true;
              }
              if (videoChanged && stylesheetChanged) break;
            }
            if (videoChanged && stylesheetChanged) break;
          }
          if (videoChanged) scheduleThemeReview(80);
          if (stylesheetChanged) markThemeChanged(180);
          if (declaredThemeChanged) markThemeChanged(100);
        });
        if (document.body) {
          contentObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
              'class', 'style', 'dark', 'dark-mode', 'darkmode', 'dark-theme', 'data-dark', 'night', 'night-mode',
              'data-theme', 'theme', 'data-skin', 'data-style', 'data-mode', 'data-color-mode', 'data-scheme', 'color-scheme',
            ],
          });
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { settle(); watchAnnouncements(); }, { once: true });
      else { settle(); watchAnnouncements(); }
      window.addEventListener('load', () => {
        if (!state.detected) render();
      }, { once: true });
    });
  }

  boot();
})();
