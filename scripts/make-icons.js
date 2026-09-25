// Balimda — © 2026 Bandar. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar" credit; no rebranding.

// Draws the Balimda icon (chat bubble with a diamond on an indigo gradient) and
// writes the desktop icon plus Android launcher icons and splash screens.
// Pure Node, no image libraries needed.
//
//   node scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const INDIGO = [91, 91, 214];
const VIOLET = [124, 80, 240];

// ---- shapes in a 512×512 design space ----------------------------------------

function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const inBubble = (x, y) =>
  inRounded(x, y, 104, 120, 408, 352, 60) ||
  (y >= 340 && y <= 420 && x >= 150 && x - 150 <= 420 - y);
const inDiamond = (x, y) => Math.abs(x - 256) + Math.abs(y - 236) <= 70;

function gradient(t) {
  return INDIGO.map((c, i) => c + (VIOLET[i] - c) * t);
}

/**
 * Render an image.
 * @param {number} w, h        output size in pixels
 * @param {object} o
 *   o.iconSize   pixel size of the 512-unit design space (centred)
 *   o.background 'rounded' | 'circle' | 'fill' | 'none'
 */
function render(w, h, o) {
  const px = Buffer.alloc(w * h * 4);
  const SS = 3;
  const scale = 512 / o.iconSize;
  const ox = (w - o.iconSize) / 2;
  const oy = (h - o.iconSize) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let bg = 0;
      let bubble = 0;
      let dia = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS - ox) * scale;
          const v = (y + (sy + 0.5) / SS - oy) * scale;
          if (o.background === 'fill') bg++;
          else if (o.background === 'rounded' && inRounded(u, v, 16, 16, 496, 496, 110)) bg++;
          else if (o.background === 'circle' && (u - 256) ** 2 + (v - 256) ** 2 <= 250 ** 2) bg++;
          if (inBubble(u, v)) bubble++;
          if (inDiamond(u, v)) dia++;
        }
      }
      const n = SS * SS;
      const [a, b, d] = [bg / n, bubble / n, dia / n];
      let [r, g, bl] = gradient(o.background === 'fill' ? 0 : y / h);
      let alpha = a;
      // white bubble, then indigo diamond on top
      r = r * (1 - b) + 255 * b;
      g = g * (1 - b) + 255 * b;
      bl = bl * (1 - b) + 255 * b;
      alpha = alpha + b * (1 - alpha);
      r = r * (1 - d) + INDIGO[0] * d;
      g = g * (1 - d) + INDIGO[1] * d;
      bl = bl * (1 - d) + INDIGO[2] * d;
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = bl;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(w, h, px);
}

// ---- minimal PNG encoder / size reader --------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

function encodePng(w, h, px) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log('wrote', path.relative(root, file));
}

// ---- outputs ---------------------------------------------------------------

write(path.join(root, 'build/icon.png'), render(512, 512, { iconSize: 512, background: 'rounded' }));

const res = path.join(root, 'android/app/src/main/res');
if (fs.existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    const legacy = Math.round(48 * k);
    write(`${res}/mipmap-${d}/ic_launcher.png`, render(legacy, legacy, { iconSize: legacy, background: 'rounded' }));
    write(`${res}/mipmap-${d}/ic_launcher_round.png`, render(legacy, legacy, { iconSize: legacy, background: 'circle' }));
    // Adaptive icon foreground: 108dp canvas, artwork inside the 66dp safe zone.
    const fg = Math.round(108 * k);
    write(`${res}/mipmap-${d}/ic_launcher_foreground.png`, render(fg, fg, { iconSize: Math.round(80 * k), background: 'none' }));
  }
  // Splash screens: indigo background with the bubble in the middle.
  for (const dir of fs.readdirSync(res)) {
    const file = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const [w, h] = pngSize(file);
    write(file, render(w, h, { iconSize: Math.round(Math.min(w, h) * 0.45), background: 'fill' }));
  }
  write(`${res}/values/ic_launcher_background.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#5B5BD6</color>\n</resources>\n');
}
