// Verifies the icon actually inside a PE file — not the source PNG, not a cache.
// Reads the RT_GROUP_ICON / RT_ICON resource directory straight out of the file
// and hashes every embedded frame, so "the exe has the new icon" is a fact
// rather than an assumption about the build order.
//
//   node dev/icon/inspect-pe.mjs <file.exe>

import sharp from "sharp";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , target] = process.argv;
const buf = readFileSync(target);
const hash = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

// ── PE walk ───────────────────────────────────────────────────────────────────

if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${target}: not a PE (no MZ)`);
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error("bad PE signature");

const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const optOff = peOff + 24;
const magic = buf.readUInt16LE(optOff);
const ddOff = optOff + (magic === 0x20b ? 112 : 96);

// Data directory entry 2 is the resource table.
const rsrcRva = buf.readUInt32LE(ddOff + 2 * 8);
const rsrcSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);

const sections = [];
for (let i = 0; i < numSections; i++) {
  const o = peOff + 24 + optSize + i * 40;
  sections.push({
    name: buf.slice(o, o + 8).toString("ascii").replace(/\0+$/, ""),
    vaddr: buf.readUInt32LE(o + 12),
    vsize: buf.readUInt32LE(o + 8),
    raw: buf.readUInt32LE(o + 20),
    rawSize: buf.readUInt32LE(o + 16),
  });
}

function toOffset(rva) {
  const s = sections.find((s) => rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize));
  if (!s) throw new Error(`no section holds RVA ${rva.toString(16)}`);
  return s.raw + (rva - s.vaddr);
}

// ── resource tree ─────────────────────────────────────────────────────────────

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

const base = toOffset(rsrcRva);

// Every directory offset in the resource tree is relative to the start of the
// resource section, not to the file, so `base` is added here rather than at each
// call site.
function dirEntries(relativeOff) {
  const levelOff = base + relativeOff;
  const named = buf.readUInt16LE(levelOff + 12);
  const idEntries = buf.readUInt16LE(levelOff + 14);
  const out = [];
  for (let i = 0; i < named + idEntries; i++) {
    const o = levelOff + 16 + i * 8;
    const name = buf.readUInt32LE(o);
    const child = buf.readUInt32LE(o + 4);
    out.push({
      id: name & 0x80000000 ? name & 0x7fffffff : name,
      isDir: (child & 0x80000000) !== 0,
      off: child & 0x7fffffff,
    });
  }
  return out;
}

function leaf(entryOff) {
  const o = base + entryOff;
  const rva = buf.readUInt32LE(o);
  const size = buf.readUInt32LE(o + 4);
  const start = toOffset(rva);
  return buf.slice(start, start + size);
}

/** All RT_ICON blobs, keyed by resource id. */
const iconResources = new Map();
for (const type of dirEntries(0)) {
  if (type.id !== RT_ICON || !type.isDir) continue;
  for (const name of dirEntries(type.off)) {
    if (!name.isDir) continue;
    for (const lang of dirEntries(name.off)) {
      if (lang.isDir) continue;
      iconResources.set(name.id, leaf(lang.off));
    }
  }
}

let group = null;
for (const type of dirEntries(0)) {
  if (type.id !== RT_GROUP_ICON || !type.isDir) continue;
  for (const name of dirEntries(type.off)) {
    if (!name.isDir) continue;
    for (const lang of dirEntries(name.off)) {
      if (lang.isDir) continue;
      group = leaf(lang.off);
    }
  }
}

console.log(target);
console.log(`  sections: ${sections.map((s) => s.name).join(" ")}`);
console.log(`  RT_ICON blobs: ${iconResources.size}`);
if (!group) {
  console.log("  no RT_GROUP_ICON — this PE carries no icon at all");
  process.exit(0);
}

const frames = group.readUInt16LE(4);
console.log(`  RT_GROUP_ICON frames: ${frames}`);

for (let i = 0; i < frames; i++) {
  const o = 6 + 14 * i;
  const w = group[o] || 256;
  const h = group[o + 1] || 256;
  const planes = group.readUInt16LE(o + 4);
  const bpp = group.readUInt16LE(o + 6);
  const bytes = group.readUInt32LE(o + 8);
  const resId = group.readUInt16LE(o + 12);

  const blob = iconResources.get(resId);
  if (!blob) {
    console.log(`  ${`${w}x${h}`.padEnd(10)} id=${resId}  MISSING blob`);
    continue;
  }
  const isPng = blob.slice(0, 8).toString("hex") === "89504e470d0a1a0a";
  const storage = isPng ? "PNG" : "BMP";

  // NSIS and some linkers emit ICOs in forms sharp will not take — a bare DIB
  // with no BITMAPFILEHEADER, or a 1/4/8-bit paletted bitmap. Report the header
  // instead of throwing, because the frame still exists and still counts.
  let detail;
  try {
    const m = await sharp(blob).metadata();
    const raw = await sharp(blob).ensureAlpha().raw().toBuffer();
    let lit = 0;
    const sum = [0, 0, 0];
    for (let k = 0; k < m.width * m.height; k++) {
      if (raw[k * 4 + 3] === 0) continue;
      lit++;
      sum[0] += raw[k * 4];
      sum[1] += raw[k * 4 + 1];
      sum[2] += raw[k * 4 + 2];
    }
    const avg = lit
      ? "#" + sum.map((v) => Math.round(v / lit).toString(16).padStart(2, "0")).join("")
      : "n/a";
    detail = `${m.width}x${m.height}  avg=${avg}  lit=${lit}`;
  } catch {
    const dibHeader = blob.length >= 40 ? blob.readUInt32LE(0) : 0;
    const dibW = blob.length >= 8 ? blob.readInt32LE(4) : 0;
    const dibH = blob.length >= 12 ? blob.readInt32LE(8) : 0;
    const dibBpp = blob.length >= 16 ? blob.readUInt16LE(14) : 0;
    detail = `undecodable by sharp; dibHeaderSize=${dibHeader} dib=${dibW}x${dibH} bpp=${dibBpp} head=${blob
      .slice(0, 12)
      .toString("hex")}`;
  }

  console.log(
    `  ${`${w}x${h}`.padEnd(10)}${storage.padEnd(5)}${`${bytes}B`.padStart(8)}  ` +
      `planes=${planes} bpp=${bpp}  ${detail}  sha=${hash(blob)}`,
  );
}