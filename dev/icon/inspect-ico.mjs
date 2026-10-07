// Inspects an ICO and writes each frame out as a PNG, so the frames can be looked
// at rather than trusted. Read-only: touches nothing in the project.
//
//   node dev/icon/inspect-ico.mjs <file.ico> <out-dir>

import sharp from "sharp";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , icoPath, outDir = "dev/icon/frames"] = process.argv;

const buf = readFileSync(icoPath);
const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);

console.log(icoPath);
console.log(`  reserved=${reserved} type=${type} (1 = icon) frames=${count}`);
if (reserved !== 0 || type !== 1) throw new Error("not an ICO");

mkdirSync(outDir, { recursive: true });

// Average colour plus an alpha census: enough to tell "the robot is in here" from
// "blank tile" or "solid square" without eyeballing every frame.
function describe(size, rgba) {
  let sumR = 0, sumG = 0, sumB = 0;
  let opaque = 0, partial = 0, clear = 0;
  for (let i = 0; i < size * size; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) { clear++; continue; }
    if (a === 255) opaque++; else partial++;
    sumR += rgba[i * 4];
    sumG += rgba[i * 4 + 1];
    sumB += rgba[i * 4 + 2];
  }
  const lit = opaque + partial;
  return {
    avg: lit ? [sumR / lit, sumG / lit, sumB / lit].map((v) => Math.round(v)) : null,
    opaque, partial, clear,
  };
}

for (let i = 0; i < count; i++) {
  const o = 6 + 16 * i;
  const w = buf[o] || 256; // 0 in this field means 256
  const bytes = buf.readUInt32LE(o + 8);
  const ptr = buf.readUInt32LE(o + 12);
  const data = buf.slice(ptr, ptr + bytes);

  const storage = data.slice(0, 8).toString("hex") === "89504e470d0a1a0a" ? "PNG" : "BMP";
  const raw = await sharp(data).ensureAlpha().raw().toBuffer();
  const m = await sharp(data).metadata();
  const d = describe(m.width, raw);

  const file = join(outDir, `frame-${m.width}.png`);
  await sharp(data).png().toFile(file);

  console.log(
    `  ${`${m.width}x${m.height}`.padEnd(10)}${storage.padEnd(5)}${`${bytes}B`.padStart(8)}  ` +
      `avg=${d.avg ? "#" + d.avg.map((v) => v.toString(16).padStart(2, "0")).join("") : "n/a"}  ` +
      `opaque=${d.opaque} partial=${d.partial} clear=${d.clear}  -> ${file}`,
  );
}
console.log(`frames written to ${outDir}/`);