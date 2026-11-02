/* Popup controller: per-site switches for the active tab. */
(function () {
  'use strict';

  const API = typeof browser !== 'undefined' ? browser : chrome;
  const DEFAULTS = { darkSites: {}, imageSites: {} };

  const ui = {
    site: document.getElementById('site'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    labelDark: document.getElementById('label-dark'),
    labelImages: document.getElementById('label-images'),
    toggleDark: document.getElementById('toggle-dark'),
    toggleImages: document.getElementById('toggle-images'),
    rowDark: document.getElementById('row-dark'),
    rowImages: document.getElementById('row-images'),
    note: document.getElementById('note'),
    nativeHint: document.getElementById('native-hint'),
    redetect: document.getElementById('redetect'),
  };

  let domain = '';
  let tabId = null;
  let frameId = 0;
  let snapshot = { factoryDark: false, detected: false, dark: false, images: false };

  function readSettings() {
    return new Promise((resolve) => API.storage.local.get(DEFAULTS, (s) => resolve({
      darkSites: s.darkSites || {},
      imageSites: s.imageSites || {},
    })));
  }

  function send(message) {
    return new Promise((resolve) => {
      if (tabId === null) return resolve(null);
      API.tabs.sendMessage(tabId, Object.assign({ type: 'wd-command' }, message), { frameId }, (response) => {
        resolve(API.runtime.lastError ? null : response || null);
      });
    });
  }

  function paint() {
    const { factoryDark, detected, dark, images } = snapshot;
    ui.toggleDark.checked = !!dark;
    ui.toggleImages.checked = !!images;
    ui.rowDark.classList.toggle('row--active', !!dark);
    ui.rowImages.classList.toggle('row--active', !!images);
    ui.labelDark.textContent = `Затемнять сайт ${domain}`;
    ui.labelImages.textContent = `Затемнять изображения на ${domain}`;

    if (!detected) ui.status.textContent = 'оформление сайта не распознано';
    else if (factoryDark && !dark) ui.status.textContent = 'у сайта своя тёмная тема';
    else if (dark) ui.status.textContent = 'тёмная тема включена';
    else ui.status.textContent = 'сайт в светлом оформлении';

    ui.nativeHint.hidden = !factoryDark;
    ui.redetect.hidden = !(factoryDark && dark);
    ui.rows.setAttribute('aria-busy', 'false');
  }

  async function save(patch) {
    const current = await readSettings();
    await new Promise((resolve) => API.storage.local.set(Object.assign({}, current, patch), resolve));
    const fresh = await send(patch.darkSites ? { action: 'set', dark: snapshot.dark } : { action: 'set', images: snapshot.images });
    if (fresh) {
      snapshot = fresh;
      paint();
    }
  }

  ui.toggleDark.addEventListener('change', () => {
    snapshot.dark = ui.toggleDark.checked;
    ui.rowDark.classList.toggle('row--active', snapshot.dark);
    ui.redetect.hidden = !(snapshot.factoryDark && snapshot.dark);
    paint();
    readSettings().then((s) => save({ darkSites: Object.assign({}, s.darkSites, { [domain]: snapshot.dark }) }));
  });

  ui.toggleImages.addEventListener('change', () => {
    snapshot.images = ui.toggleImages.checked;
    ui.rowImages.classList.toggle('row--active', snapshot.images);
    ui.note.hidden = !snapshot.images;
    ui.note.textContent = snapshot.images ? 'Вступит в силу после перезагрузки страницы' : '';
    readSettings().then((s) => save({ imageSites: Object.assign({}, s.imageSites, { [domain]: snapshot.images }) }));
  });

  ui.redetect.addEventListener('click', async () => {
    ui.redetect.disabled = true;
    const fresh = await send({ action: 'redetect' });
    ui.redetect.disabled = false;
    if (fresh) {
      snapshot = fresh;
      paint();
    }
  });

  async function init() {
    const [tab] = await new Promise((resolve) => API.tabs.query({ active: true, currentWindow: true }, resolve));
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
      ui.site.textContent = 'Страница недоступна';
      ui.status.textContent = 'Работает только на обычных сайтах';
      ui.rows.hidden = true;
      return;
    }
    tabId = tab.id;
    frameId = 0;
    domain = new URL(tab.url).hostname.replace(/^www\./, '');
    ui.site.textContent = domain;
    ui.note.hidden = true;

    const stored = await readSettings();
    snapshot = {
      factoryDark: false,
      detected: false,
      dark: typeof stored.darkSites[domain] === 'boolean' ? stored.darkSites[domain] : false,
      images: stored.imageSites[domain] === true,
    };
    paint();

    const fresh = await send({ action: 'get' });
    if (fresh) {
      snapshot = Object.assign({}, fresh);
      snapshot.images = fresh.images === true;
      frameId = fresh.frame || 0;
      paint();
    }
  }

  init();
})();
