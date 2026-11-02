#!/usr/bin/env node
/** Rasterises the Lucide moon into PNG tiles inside Chromium, cropping to the pixels the stroke actually paints. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'assets/icons/moon.svg'), 'utf8');
const SIZES = [16, 32, 48, 128];
const SOURCE = 1024;
const PAD = 0.02;
const ALPHA = 8;

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();

const tiles = await page.evaluate(async ({ svg, SIZES, SOURCE, PAD, ALPHA }) => {
  const load = (markup, width, height) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('svg-load-failed'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup.replace('width="24" height="24"', `width="${width}" height="${height}"`))}`;
  });
  const source = document.createElement('canvas');
  source.width = source.height = SOURCE;
  const sourceCtx = source.getContext('2d');
  sourceCtx.drawImage(await load(svg, SOURCE, SOURCE), 0, 0);

  // The stroke is centred on the path, so its bounds are taken from the painted pixels, not from the geometry.
  const pixels = sourceCtx.getImageData(0, 0, SOURCE, SOURCE).data;
  let left = SOURCE, top = SOURCE, right = 0, bottom = 0;
  for (let y = 0; y < SOURCE; y++) {
    for (let x = 0; x < SOURCE; x++) {
      if (pixels[(y * SOURCE + x) * 4 + 3] <= ALPHA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const inkWidth = right - left + 1;
  const inkHeight = bottom - top + 1;
  const side = Math.max(inkWidth, inkHeight);
  const pad = side * PAD;
  const box = {
    x: left - pad - (side - inkWidth) / 2,
    y: top - pad - (side - inkHeight) / 2,
    side: side + pad * 2,
  };

  const out = [];
  for (const size of SIZES) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = size;
    const ctx = tile.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, box.x, box.y, box.side, box.side, 0, 0, size, size);
    out.push({ size, data: tile.toDataURL('image/png').split(',')[1] });
  }
  return { ink: { left, top, inkWidth, inkHeight, box }, out };
}, { svg, SIZES, SOURCE, PAD, ALPHA });

await browser.close();

for (const tile of tiles.out) {
  fs.writeFileSync(path.join(root, `assets/icons/icon-${tile.size}.png`), Buffer.from(tile.data, 'base64'));
}
console.log('ink', JSON.stringify(tiles.ink));
console.log(`icons written: ${SIZES.join(', ')}`);
