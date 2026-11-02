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
  };

  const THEME = {
    mode: 1,
    brightness: 100,
    contrast: 100,
    grayscale: 0,
    sepia: 0,
    useFont: false,
    textStroke: 0,
    darkSchemeBackgroundColor: '#181a1b',
    darkSchemeTextColor: '#e8e6e3',
    lightSchemeBackgroundColor: '#dcdad7',
    lightSchemeTextColor: '#181a1b',
    scrollbarColor: 'auto',
    selectionColor: 'auto',
    styleSystemControls: false,
  };

  function applyTheme(on) {
    if (!window.DarkReader || state.darkApplied === on) return;
    try {
      if (on) {
        window.DarkReader.enable(THEME, { invert: state.fixes.invert, ignoreImageAnalysis: state.fixes.ignore });
      } else {
        window.DarkReader.disable();
      }
      state.darkApplied = on;
    } catch (err) { /* unsupported document */ }
  }

  function startImages() {
    if (state.images) return;
    state.images = true;
    state.imageError = null;
    try {
      window.WDImagery.start({ selectors: { invert: state.fixes.invert, ignore: state.fixes.ignore } });
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

  function detect() {
    const result = window.WDDetect.detect();
    if (result.reason !== 'no-body') {
      state.factoryDark = result.dark;
      state.reason = result.reason;
      state.detected = true;
    }
    return result.dark;
  }

  function render() {
    const trace = window.__sdTrace = window.__sdTrace || [];
    return getSettings().then((settings) => {
      trace.push(`render images=${window.WD.isImageSite(settings, key) ? 1 : 0} keys=${Object.keys(settings.imageSites).join(',')}`);
      const forced = window.WD.isDarkSite(settings, key);
      let factoryDark = state.factoryDark;
      if (factoryDark === null) factoryDark = detect();

      const wantTheme = forced === true ? true : forced === false ? false : factoryDark !== true;
      applyTheme(wantTheme);
      if (window.WD.isImageSite(settings, key)) startImages();
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
      });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', settle, { once: true });
      else settle();
      window.addEventListener('load', () => {
        if (!state.detected) render();
      }, { once: true });
    });
  }

  boot();
})();
