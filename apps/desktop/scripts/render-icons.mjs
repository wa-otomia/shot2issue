#!/usr/bin/env node
// Render placeholder shot2issue app icons with pure Node (zlib only — no
// Pillow / sharp / native deps), so it runs anywhere CI does.
//
// Emits a simple mark: deep-navy rounded square + a cyan->blue C-curve arc
// with a white inner ring + dot (the brand family used by curvault). This is
// a STAND-IN.
//
// TODO: replace with a designed shot2issue logo before shipping.
//
// Usage: node scripts/render-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

const SIZES = {
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
};

// --- palette / geometry (viewBox 120 units) ---
const GRAD = [
  [0.0, [0x16, 0x26, 0x4f]],
  [0.48, [0x0b, 0x14, 0x30]],
  [1.0, [0x06, 0x0b, 0x1a]],
];
const ARC_G0 = [0x36, 0xc5, 0xff];
const ARC_G1 = [0x1b, 0x4f, 0xd6];
const VB = 120,
  CTR = 60,
  OUTER_R = 38,
  OUTER_HALF = 4.5,
  INNER_R = 24,
  INNER_HALF = 3,
  DOT_R = 6.5,
  GAP_DEG = 45;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function gradColor(t) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < GRAD.length - 1; i++) {
    const [t0, c0] = GRAD[i];
    const [t1, c1] = GRAD[i + 1];
    if (t <= t1) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    }
  }
  return GRAD[GRAD.length - 1][1];
}

function roundedMaskAlpha(x, y, size, r) {
  if (x < 0 || x >= size || y < 0 || y >= size) return 0;
  let cx = null,
    cy = null;
  if (x < r && y < r) [cx, cy] = [r, r];
  else if (x >= size - r && y < r) [cx, cy] = [size - r, r];
  else if (x < r && y >= size - r) [cx, cy] = [r, size - r];
  else if (x >= size - r && y >= size - r) [cx, cy] = [size - r, size - r];
  if (cx === null) return 1;
  const d = Math.hypot(x - cx, y - cy);
  const aa = 0.85;
  if (d <= r) return 1;
  if (d >= r + aa) return 0;
  return 1 - (d - r) / aa;
}

function render(size) {
  const cornerR = size * 0.225;
  const gradCx = size * 0.8,
    gradCy = size * 0.08,
    gradMax = size * 1.05;
  const logoFrac = 0.86,
    logoSize = size * logoFrac;
  const lx0 = (size - logoSize) / 2,
    ly0 = (size - logoSize) / 2;
  const aaSvg = 0.85 * (VB / logoSize);

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let py = 0; py < size; py++) {
    raw[p++] = 0; // PNG filter byte
    for (let px = 0; px < size; px++) {
      const mx = px + 0.5,
        my = py + 0.5;
      const mask = roundedMaskAlpha(mx, my, size, cornerR);
      if (mask <= 0) {
        raw[p++] = 0;
        raw[p++] = 0;
        raw[p++] = 0;
        raw[p++] = 0;
        continue;
      }
      const t = Math.hypot(mx - gradCx, my - gradCy) / gradMax;
      let [R, G, B] = gradColor(t);

      if (mx >= lx0 && mx <= lx0 + logoSize && my >= ly0 && my <= ly0 + logoSize) {
        const lx = ((mx - lx0) / logoSize) * VB;
        const ly = ((my - ly0) / logoSize) * VB;
        const dlx = lx - CTR,
          dly = ly - CTR;
        const rr = Math.hypot(dlx, dly);
        const angle = (Math.atan2(dly, dlx) * 180) / Math.PI;
        const inGap = angle > -GAP_DEG && angle < GAP_DEG;
        if (!inGap) {
          const dOut = Math.abs(rr - OUTER_R) - OUTER_HALF;
          if (dOut < aaSvg) {
            const a = clamp((aaSvg - dOut) / aaSvg, 0, 1);
            const kt = clamp((lx + ly) / (2 * VB), 0, 1);
            R = lerp(R, lerp(ARC_G0[0], ARC_G1[0], kt), a);
            G = lerp(G, lerp(ARC_G0[1], ARC_G1[1], kt), a);
            B = lerp(B, lerp(ARC_G0[2], ARC_G1[2], kt), a);
          }
          const dIn = Math.abs(rr - INNER_R) - INNER_HALF;
          if (dIn < aaSvg) {
            const a = clamp((aaSvg - dIn) / aaSvg, 0, 1) * 0.9;
            R = lerp(R, 255, a);
            G = lerp(G, 255, a);
            B = lerp(B, 255, a);
          }
        }
        const dDot = rr - DOT_R;
        if (dDot < aaSvg) {
          const a = clamp((aaSvg - dDot) / aaSvg, 0, 1);
          R = lerp(R, 255, a);
          G = lerp(G, 255, a);
          B = lerp(B, 255, a);
        }
      }

      raw[p++] = R;
      raw[p++] = G;
      raw[p++] = B;
      raw[p++] = Math.round(mask * 255);
    }
  }
  return raw;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// CRC-32 (zlib does not expose it directly across all Node versions).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size, raw) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(items) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(items.length, 4);
  let offset = 6 + items.length * 16;
  const entries = [];
  const blobs = [];
  for (const [size, blob] of items) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(blob.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(blob);
    offset += blob.length;
  }
  return Buffer.concat([head, ...entries, ...blobs]);
}

function icns(bySize) {
  const typeMap = { 32: "ic11", 64: "ic12", 128: "ic07", 256: "ic13", 512: "ic09" };
  const parts = [];
  for (const [s, t] of Object.entries(typeMap)) {
    const blob = bySize[Number(s)];
    if (!blob) continue;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(8 + blob.length, 0);
    parts.push(Buffer.concat([Buffer.from(t, "ascii"), len, blob]));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const bySize = {};
  for (const [name, size] of Object.entries(SIZES)) {
    const blob = png(size, render(size));
    bySize[size] = blob;
    writeFileSync(join(OUT_DIR, name), blob);
    console.log(`  wrote ${name} (${size}x${size}, ${blob.length} B)`);
  }
  const icoBuf = ico([
    [32, bySize[32]],
    [128, bySize[128]],
    [256, bySize[256]],
  ]);
  writeFileSync(join(OUT_DIR, "icon.ico"), icoBuf);
  console.log(`  wrote icon.ico (${icoBuf.length} B)`);

  const icnsBuf = icns({ 32: bySize[32], 128: bySize[128], 256: bySize[256], 512: bySize[512] });
  writeFileSync(join(OUT_DIR, "icon.icns"), icnsBuf);
  console.log(`  wrote icon.icns (${icnsBuf.length} B)`);
}

main();
