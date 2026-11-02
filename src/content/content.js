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
    useFont: true,
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

  function applyTheme(on) {
    if (!window.DarkReader || state.darkApplied === on) return;
    try {
      if (on) {
        const fixes = fixesFor(state.factoryDark);
        const ignore = [...MEDIA_SAFE, ...fixes.ignore];
        window.DarkReader.enable(THEME, { invert: invertSelectors(), ignoreImageAnalysis: ignore });
      } else {
        window.DarkReader.disable();
      }
      state.darkApplied = on;
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

  /* Sites announce their theme late (YouTube sets <html dark> after its first paint), so declared signals always
     win over the measured ones, and a measured verdict is only trusted until the page says something itself. */
  function detect() {
    const result = window.WDDetect.detect();
    if (result.reason === 'no-body') return result.dark;
    const declared = result.reason.indexOf('declared-') === 0;
    if (!state.detected || declared) {
      state.factoryDark = result.dark;
      state.reason = result.reason;
      state.detected = true;
    }
    return result.dark;
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
        const seen = { scheme: state.reason, video: !!document.querySelector('video') };
        const review = () => {
          const scheme = window.WDDetect.detect().reason;
          const video = !!document.querySelector('video');
          if (scheme === seen.scheme && video === seen.video) return;
          seen.scheme = scheme;
          seen.video = video;
          render();
        };
        const observer = new MutationObserver(review);
        const options = { attributes: true, attributeFilter: ['class', 'dark', 'data-theme', 'data-mode', 'data-color-mode', 'data-scheme'] };
        [document.documentElement, document.body].forEach((element) => element && observer.observe(element, options));
        observer.observe(document.documentElement, { childList: true, subtree: true });
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
