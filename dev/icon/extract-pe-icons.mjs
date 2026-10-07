// Extracts the icon frames out of a PE into PNGs, decoding the ICO/DIB forms by
// hand. sharp will not take a bare BITMAPINFOHEADER DIB — which is exactly what
// NSIS and Windows shell resource entries use — so the palette, the doubled
// height (XOR + AND mask) and the row padding are all handled here.
//
//   node dev/icon/extract-pe-icons.mjs <file.exe> <out-dir>

import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , target, outDir = "dev/icon/pe-frames"] = process.argv;
const buf = readFileSync(target);
mkdirSync(outDir, { recursive: true });

const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const optOff = peOff + 24;
const ddOff = optOff + (buf.readUInt16LE(optOff) === 0x20b ? 112 : 96);
const rsrcRva = buf.readUInt32LE(ddOff + 16);

const sections = [];
for (let i = 0; i < numSections; i++) {
  const o = peOff + 24 + optSize + i * 40;
  sections.push({
    vaddr: buf.readUInt32LE(o + 12),
    vsize: buf.readUInt32LE(o + 8),
    raw: buf.readUInt32LE(o + 20),
    rawSize: buf.readUInt32LE(o + 16),
  });
}
const toOffset = (rva) => {
  const s = sections.find((s) => rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize));
  return s.raw + (rva - s.vaddr);
};

const base = toOffset(rsrcRva);
function dir(relative) {
  const o = base + relative;
  const n = buf.readUInt16LE(o + 12) + buf.readUInt16LE(o + 14);
  return Array.from({ length: n }, (_, i) => {
    const e = o + 16 + i * 8;
    const name = buf.readUInt32LE(e);
    const child = buf.readUInt32LE(e + 4);
    return { id: name & 0x7fffffff, isDir: (child & 0x80000000) !== 0, off: child & 0x7fffffff };
  });
}
const leaf = (relative) => {
  const o = base + relative;
  const size = buf.readUInt32LE(o + 4);
  const start = toOffset(buf.readUInt32LE(o));
  return buf.slice(start, start + size);
};

const icons = new Map();
for (const t of dir(0)) {
  if (t.id !== 3 || !t.isDir) continue;
  for (const n of dir(t.off)) {
    if (!n.isDir) continue;
    for (const l of dir(n.off)) {
      if (!l.isDir) icons.set(n.id, leaf(l.off));
    }
  }
}

/** Decode a bare DIB (40-byte BITMAPINFOHEADER + palette + XOR + AND) to RGBA. */
function dib(blob) {
  const headerSize = blob.readUInt32LE(0);
  const width = blob.readInt32LE(4);
  const height = blob.readInt32LE(8); // doubled
  const planes = blob.readUInt16LE(12);
  const bpp = blob.readUInt16LE(14);
  const compression = blob.readUInt32LE(16);
  const clrUsed = blob.readUInt32LE(32);
  if (planes !== 1) throw new Error(`planes=${planes}`);
  if (compression !== 0) throw new Error(`compression=${compression}`);
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new Error(`bpp=${bpp}`);

  const h = Math.abs(height) / 2;
  const paletteCount = clrUsed || (bpp <= 8 ? 1 << bpp : 0);
  const palette = [];
  for (let i = 0; i < paletteCount; i++) {
    const o = headerSize + i * 4; // BGRA
    palette.push([blob[o + 2], blob[o + 1], blob[o], 255]);
  }

  const rowSize = Math.floor(((bpp * width + 31) / 32) * 4);
  const xorStart = headerSize + paletteCount * 4;
  const out = Buffer.alloc(width * h * 4);

  for (let y = 0; y < h; y++) {
    // DIB rows are bottom-up
    const row = xorStart + (h - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      let r, g, b, a = 255;
      if (bpp === 32) {
        const o = row + x * 4;
        b = blob[o]; g = blob[o + 1]; r = blob[o + 2]; a = blob[o + 3];
      } else if (bpp === 24) {
        const o = row + x * 3;
        b = blob[o]; g = blob[o + 1]; r = blob[o + 2];
      } else {
        let idx;
        if (bpp === 8) idx = blob[row + x];
        else if (bpp === 4) {
          const byte = blob[row + (x >> 1)];
          idx = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
        } else {
          const byte = blob[row + (x >> 3)];
          idx = (byte >> (7 - (x % 8))) & 1;
        }
        [r, g, b] = palette[idx] ?? [0, 0, 0];
      }
      const d = (y * width + x) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }

  // The AND mask (1bpp, bottom-up, row-padded) carries the real alpha for
  // bpp<=24; honour it where the pixels do not already say.
  const andStart = xorStart + rowSize * h;
  const andRowSize = Math.floor(((width + 31) / 32) * 4);
  if (bpp !== 32 && andStart + andRowSize * h <= blob.length) {
    for (let y = 0; y < h; y++) {
      const row = andStart + (h - 1 - y) * andRowSize;
      for (let x = 0; x < width; x++) {
        const bit = (blob[row + (x >> 3)] >> (7 - (x % 8))) & 1;
        if (bit === 0) out[(y * width + x) * 4 + 3] = 0;
      }
    }
  }

  return { width, height: h, rgba: out, bpp };
}

let group = null;
for (const t of dir(0)) {
  if (t.id !== 14 || !t.isDir) continue;
  for (const n of dir(t.off)) {
    if (!n.isDir) continue;
    for (const l of dir(n.off)) if (!l.isDir) group = leaf(l.off);
  }
}
if (!group) {
  console.log(`${target}: no icon`);
  process.exit(0);
}

const frames = group.readUInt16LE(4);
console.log(`${target} — ${frames} group frames, ${icons.size} RT_ICON blobs`);

for (let i = 0; i < frames; i++) {
  const o = 6 + 14 * i;
  const w = group[o] || 256;
  const id = group.readUInt16LE(o + 12);
  const blob = icons.get(id);
  if (!blob) {
    console.log(`  ${w}x${group[o + 1] || 256}  id=${id} MISSING`);
    continue;
  }
  if (blob.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
    const m = await sharp(blob).metadata();
    const f = join(outDir, `${String(i).padStart(2, "0")}-${m.width}.png`);
    await sharp(blob).png().toFile(f);
    console.log(`  [${i}] ${m.width}x${m.height} PNG -> ${f}`);
    continue;
  }
  try {
    const d = dib(blob);
    const f = join(outDir, `${String(i).padStart(2, "0")}-${d.width}.png`);
    await sharp(d.rgba, { raw: { width: d.width, height: d.height, channels: 4 } })
      .png()
      .toFile(f);
    console.log(`  [${i}] ${d.width}x${d.height} DIB bpp=${d.bpp} -> ${f}`);
  } catch (err) {
    console.log(`  [${i}] ${w}x${group[o + 1] || 256} DIB failed: ${err.message}`);
  }
}