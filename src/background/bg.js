/* Service worker: keeps the extension installed. Site settings live in storage.local and are read with defaults. */
(function () {
  'use strict';

  const API = typeof browser !== 'undefined' ? browser : chrome;

  API.runtime.onInstalled.addListener(() => {
    API.storage.local.get(null, () => {});
  });

  const MAX_FETCH_BYTES = 16 * 1024 * 1024;

  async function readLimitedBody(response) {
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          await reader.cancel();
          throw new Error('Resource exceeds the 16 MiB fetch limit');
        }
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch {}
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  API.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'wd-fetch-resource') return undefined;
    let resourceURL;
    try {
      resourceURL = new URL(message.url);
    } catch {
      sendResponse({ ok: false, error: 'Invalid resource URL' });
      return false;
    }
    if (sender.id !== API.runtime.id || !['http:', 'https:'].includes(resourceURL.protocol)) {
      sendResponse({ ok: false, error: 'Invalid resource request' });
      return false;
    }

    fetch(resourceURL.href, { credentials: 'omit', redirect: 'follow' })
      .then(async (response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + resourceURL.href);
        const bytes = await readLimitedBody(response);
        sendResponse({
          ok: true,
          body: toBase64(bytes),
          contentType: response.headers.get('content-type') || 'application/octet-stream',
        });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  });
})();
