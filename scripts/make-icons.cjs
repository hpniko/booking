/**
 * scripts/make-icons.cjs — generates the PWA icons with zero dependencies.
 *
 * Pure Node: rasterises at 3× and box-averages down, then writes a real PNG
 * (IHDR / IDAT / IEND) with zlib. Run:  node scripts/make-icons.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG encoding ──────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the drawing ───────────────────────────────────────────────────────────────
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BRAND_A = hex('#ff6b4a');
const BRAND_B = hex('#ff8f6b');
const WHITE = [255, 255, 255];
const INK = hex('#5a1a08');       // dark ring detail, reads against the brand fill

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Signed-distance test for a rounded rectangle, in 0..1 space. */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
    if (dx * dx + dy * dy <= r * r) return true;
    // inside the straight edges
    if ((x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r)) return true;
  }
  return false;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** A ring (annulus) — the wheel. */
function inRing(x, y, cx, cy, rOut, rIn) {
  const dx = x - cx;
  const dy = y - cy;
  const d = dx * dx + dy * dy;
  return d <= rOut * rOut && d >= rIn * rIn;
}

// A delivery motorcycle, in 0..1 glyph space. Chosen for legibility at 48px on
// a home screen: two ring wheels read as "wheels" even at that size, where the
// previous cake's candle and tiers turned to mush.
const WHEEL_Y = 0.755;
const REAR_X = 0.275;
const FRONT_X = 0.755;
const R_OUT = 0.135;
const R_IN = 0.082;

/** Draws the motorcycle into an existing 0..1 colour sample. */
function drawBike(gx, gy, colour) {
  const ink = (c) => { colour = c; };

  // wheels: white tyre with a dark hub, so the ring is visible at small sizes
  for (const cx of [REAR_X, FRONT_X]) {
    if (inRing(gx, gy, cx, WHEEL_Y, R_OUT, R_IN)) ink(WHITE);
    if (inCircle(gx, gy, cx, WHEEL_Y, R_IN * 0.52)) ink(INK);
  }

  // frame: a single swept body from the rear wheel up to the steering head
  if (inRoundRect(gx, gy, 0.20, 0.60, 0.63, 0.695, 0.045)) ink(WHITE);   // seat / engine block
  if (inRoundRect(gx, gy, 0.55, 0.50, 0.80, 0.64, 0.06)) ink(WHITE);      // leg shield
  if (inRoundRect(gx, gy, 0.60, 0.63, 0.70, 0.74, 0.03)) ink(WHITE);      // swing arm

  // steering column + handlebars
  if (inRoundRect(gx, gy, 0.675, 0.40, 0.735, 0.58, 0.025)) ink(WHITE);
  if (inRoundRect(gx, gy, 0.615, 0.385, 0.845, 0.445, 0.028)) ink(WHITE);

  // rider: helmet plus a shoulder, leaning into the bars
  if (inCircle(gx, gy, 0.455, 0.395, 0.088)) ink(WHITE);
  if (inRoundRect(gx, gy, 0.325, 0.455, 0.585, 0.60, 0.06)) ink(WHITE);

  return colour;
}

/** One sample in normalised 0..1 coordinates → [r,g,b,a]. */
function sample(x, y, opts) {
  const s = opts.scale;                 // glyph scale (1 = normal, 0.72 = maskable safe zone)
  const off = (1 - s) / 2;
  const gx = (x - off) / s;             // glyph-space coordinate
  const gy = (y - off) / s;

  // background
  let colour = null;
  if (opts.maskable) {
    colour = mix(BRAND_A, BRAND_B, Math.min(1, Math.max(0, (x + y) / 2)));
  } else if (inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) {
    colour = mix(BRAND_A, BRAND_B, Math.min(1, Math.max(0, (x + y) / 2)));
  } else {
    return [0, 0, 0, 0];
  }

  // the motorcycle
  colour = drawBike(gx, gy, colour);

  // soften the outer edge of the rounded square
  let alpha = 255;
  if (!opts.maskable) {
    const near = 0.012;
    if (!inRoundRect(x, y, 0.04 - near, 0.04 - near, 0.96 + near, 0.96 + near, 0.22 + near)) alpha = 140;
  }
  return [colour[0], colour[1], colour[2], alpha];
}

function render(size, opts) {
  const ss = 3;                     // supersampling factor
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const c = sample(x, y, opts);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a === 0) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  { file: 'icon-192.png', size: 192, opts: { scale: 1, maskable: false } },
  { file: 'icon-512.png', size: 512, opts: { scale: 1, maskable: false } },
  { file: 'icon-maskable-512.png', size: 512, opts: { scale: 0.72, maskable: true } },
];

for (const job of jobs) {
  const png = encodePng(job.size, job.size, render(job.size, job.opts));
  fs.writeFileSync(path.join(outDir, job.file), png);
  console.log(`wrote public/icons/${job.file} (${png.length} bytes)`);
}
