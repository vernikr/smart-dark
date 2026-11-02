/* Shared settings model: storage access, domain keys, popup<->content messaging. */
(function () {
  'use strict';

  const DEFAULTS = { darkSites: {}, imageSites: {} };
  const API = typeof browser !== 'undefined' ? browser : chrome;
  const FRAME_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  function getSettings() {
    return new Promise((resolve) => {
      API.storage.local.get(DEFAULTS, (s) => resolve({
        darkSites: s.darkSites || {},
        imageSites: s.imageSites || {},
      }));
    });
  }

  function setSettings(patch) {
    return new Promise((resolve) => API.storage.local.set(patch, resolve));
  }

  function domainKey() {
    const h = location.hostname;
    return /^www\./.test(h) ? h.slice(4) : h;
  }

  function isDarkSite(settings, key) {
    const v = settings.darkSites[key];
    return typeof v === 'boolean' ? v : null;
  }

  function imagesEnabled(settings, key) {
    return settings.imageSites[key] !== false;
  }

  function darkChoice(settings, key) {
    const value = settings.darkSites[key];
    return typeof value === 'boolean' ? value : null;
  }

  window.WD = { DEFAULTS, API, FRAME_ID, getSettings, setSettings, domainKey, isDarkSite, imagesEnabled, darkChoice };
})();
