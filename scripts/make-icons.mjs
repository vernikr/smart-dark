#!/usr/bin/env node
/** Renders the Lucide moon to PNG tiles through Chromium, so the icons match the source SVG exactly. */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'assets/icons/moon.svg');
const base = fs.readFileSync(svgPath, 'utf8')
  .replace('width="24" height="24"', 'width="512" height="512"');
const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">${base}</body></html>`;

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(html);
const shot = await page.locator('svg').screenshot({ omitBackground: true });
// Trim the stroke padding around the glyph so the moon fills the tile.
const ink = await page.evaluate(() => {
  const svg = document.querySelector('svg');
  const box = svg.getBoundingClientRect();
  const path = svg.querySelector('path');
  const b = path.getBBox();
  const scale = box.width / svg.viewBox.baseVal.width;
  return { left: b.x * scale, top: b.y * scale, width: b.width * scale, height: b.height * scale, box: box.width };
});
await browser.close();

const margin = Math.max(ink.width, ink.height) * 0.02;
const side = Math.max(ink.width, ink.height) + margin * 2;
const clip = {
  x: Math.round(ink.left - margin + (ink.width - side) / 2 - 0.5),
  y: Math.round(ink.top - margin + (ink.height - side) / 2 - 0.5),
  width: Math.round(side + 1),
  height: Math.round(side + 1),
};
console.log('glyph box', JSON.stringify(clip));

const { default: sharp } = await import('node:zlib').then(() => ({ default: null })).catch(() => ({ default: null }));
for (const size of [16, 32, 48, 128]) {
  if (sharp) {
    await sharp(shot).resize(size, size).png().toFile(path.join(root, `assets/icons/icon-${size}.png`));
  } else {
    fs.writeFileSync(path.join(root, 'tmp-icon-512.png'), shot);
    const { execFileSync } = await import('node:child_process');
    execFileSync('convert', ['-background', 'none', path.join(root, 'tmp-icon-512.png'),
      '-crop', `${clip.width}x${clip.height}+${clip.x}+${clip.y}`, '+repage',
      '-resize', `${size}x${size}`, path.join(root, `assets/icons/icon-${size}.png`)]);
    fs.rmSync(path.join(root, 'tmp-icon-512.png'), { force: true });
  }
  console.log(`icon-${size}.png written`);
}
