/* Service worker: keeps the extension installed. Site settings live in storage.local and are read with defaults. */
(function () {
  'use strict';

  const API = typeof browser !== 'undefined' ? browser : chrome;

  API.runtime.onInstalled.addListener(() => {
    API.storage.local.get(null, () => {});
  });
})();
