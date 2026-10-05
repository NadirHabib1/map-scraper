// generate-icons.js — Pure Node.js, zero npm dependencies
// Generates icons/icon16.png, icon48.png, icon128.png
// Run:  node generate-icons.js

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

// ── Minimal PNG encoder ─────────────────────────────────────────────────────
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function crc32(buf) {
  const table = crc32.table || (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    crc32.table = t;
    return t;
  })();

  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const dataB = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const crcB  = u32(crc32(Buffer.concat([typeB, dataB])));
  return Buffer.concat([u32(dataB.length), typeB, dataB, crcB]);
}

function encodePNG(width, height, rgba) {
  // rgba: Uint8Array of width*height*4 bytes (R,G,B,A)
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8;   // bit depth
  ihdrData[9]  = 6;   // colour type: RGBA
  ihdrData[10] = 0;   // compression
  ihdrData[11] = 0;   // filter
  ihdrData[12] = 0;   // interlace
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines with filter byte 0 at the start of each row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

// ── Draw a map-pin icon onto an RGBA pixel array ────────────────────────────
function drawPin(size) {
  const pixels = new Uint8Array(size * size * 4); // all transparent

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // Alpha-composite over transparent background
    const srcA = a / 255;
    const dstA = pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    pixels[i]     = Math.round((r * srcA + pixels[i]     * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  }

  // Anti-aliased circle fill
  function fillCircle(cx, cy, radius, r, g, b) {
    const x0 = Math.floor(cx - radius - 1);
    const x1 = Math.ceil(cx + radius + 1);
    const y0 = Math.floor(cy - radius - 1);
    const y1 = Math.ceil(cy + radius + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
        // Coverage via sub-pixel sampling (4 samples)
        let coverage = 0;
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const d = Math.sqrt((px + sx * 0.5 - 0.25 - cx) ** 2 + (py + sy * 0.5 - 0.25 - cy) ** 2);
            if (d <= radius) coverage += 0.25;
          }
        }
        if (coverage > 0) setPixel(px, py, r, g, b, Math.round(coverage * 255));
      }
    }
  }

  // Filled triangle (pin tail)
  function fillTriangle(x0, y0, x1, y1, x2, y2, r, g, b) {
    const minY = Math.floor(Math.min(y0, y1, y2));
    const maxY = Math.ceil(Math.max(y0, y1, y2));
    for (let py = minY; py <= maxY; py++) {
      // Find x-span of triangle at this scanline
      const edges = [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]];
      const xs = [];
      for (const [ax, ay, bx, by] of edges) {
        if ((ay <= py && by > py) || (by <= py && ay > py)) {
          xs.push(ax + (py - ay) / (by - ay) * (bx - ax));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let px = Math.floor(xs[0]); px <= Math.ceil(xs[1]); px++) {
        setPixel(px, py, r, g, b, 255);
      }
    }
  }

  const cx     = size / 2;
  const topCY  = size * 0.40;   // center of pin head circle
  const radius = size * 0.33;

  // Gradient: fake it with two concentric circles (dark border + light fill)
  fillCircle(cx, topCY, radius,        0,  90, 160, 255); // dark blue border
  fillCircle(cx, topCY, radius * 0.85, 0, 180, 230, 255); // mid blue
  fillCircle(cx, topCY, radius * 0.65, 0, 212, 255, 255); // accent highlight

  // Pin tail triangle
  const tailTop = topCY + radius * 0.55;
  const tailBot = size  * 0.91;
  fillTriangle(
    cx - radius * 0.28, tailTop,
    cx + radius * 0.28, tailTop,
    cx,                 tailBot,
    0, 90, 160, 255   // same dark blue
  );

  // Inner white dot
  fillCircle(cx, topCY, radius * 0.30, 255, 255, 255, 255);

  return pixels;
}

// ── Generate all three sizes ─────────────────────────────────────────────────
[16, 48, 128].forEach((size) => {
  const rgba = drawPin(size);
  const png  = encodePNG(size, size, rgba);
  const file = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ icons/icon${size}.png  (${png.length} bytes)`);
});

console.log('\nAll icons generated in ./icons/');
