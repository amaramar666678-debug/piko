// The one place Piko's icon comes from.
//
//   npm run icons
//
// `assets/brand/` is the brand and it is an *input*: `piko-icon.svg` (the mark on its
// tile) is what `tauri icon` gets, and `piko-mark.svg` (the bare mark) is what the
// hand-assembled ICO and the tray asset are cut from. Nothing in this script draws,
// redraws or regenerates the artwork — a build step that regenerates its own source
// is a second source of truth that can disagree with the first.
//
//   assets/brand/piko-icon.svg  ──> tauri icon ──> PNGs, icns, Square*, StoreLogo
//   assets/brand/piko-mark.svg  ──> icon.ico, 16/24/32/48/64/128/256
//                             └─> piko-tray.png, 32, alpha only
//
// Two reasons this is not just `tauri icon`:
//
//   * `tauri icon` writes six ICO frames and skips 128. Explorer's medium-size slot
//     and most "large icon" views ask for exactly that one, and an ICO without it
//     falls back to the 64 — so the ICO is assembled here, and `tauri icon`'s is
//     overwritten immediately after.
//
//   * The tray wants the bare mark, not the tile: a 16px notification-area slot with
//     a rounded dark square inside it is a smudge. `piko-tray.png` keeps only the
//     alpha — Windows draws a tray icon through that channel, so one white asset
//     follows the taskbar's own light or dark theme instead of needing two files
//     and a theme check.
//
// sharp rasterises the vector sources; it is a devDependency already used by the
// inspection tools in dev/icon, and nothing here runs at app start-up.

import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(ROOT, "assets", "brand");
const OUT = join(ROOT, "src-tauri", "icons");

const ICON_SOURCE = join(BRAND, "piko-icon.svg");
const MARK_SOURCE = join(BRAND, "piko-mark.svg");

// Every size Explorer, the taskbar, the shell and NSIS can ask for.
const ICO_FRAMES = [16, 24, 32, 48, 64, 128, 256];

// The notification-area slot is 16–24px; 32 is what Windows scales that up from and
// what a 200% display actually asks for.
const TRAY_SIZE = 32;

// ── PNG ───────────────────────────────────────────────────────────────────────

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO ───────────────────────────────────────────────────────────────────────

// PNG-in-ICO, which Windows has read since Vista.
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 0 means 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

// 1. Everything Windows and the app itself asks for, from the tiled icon. The CLI is
//    a node script, so it is run by the node that is running this file: `npx` is a
//    `.cmd`, and spawning one needs a shell.
execFileSync(
  process.execPath,
  [join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"), "icon", ICON_SOURCE],
  { cwd: ROOT, stdio: "inherit" },
);

// 2. The ICO, with a 128 frame that the generator above leaves out. Cut from the
//    *tiled* icon, like every PNG beside it: a shortcut and a taskbar button want
//    the tile, and only the notification area wants the bare mark (step 3).
const frames = [];
for (const size of ICO_FRAMES) {
  const rgba = await sharp(ICON_SOURCE, { density: 600 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer();
  frames.push({ size, png: encodePNG(size, rgba) });
}
const ico = encodeICO(frames);
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes — ${ICO_FRAMES.join("/")}`);

// 3. The tray asset: the mark's coverage and nothing else. Windows renders a tray
//    icon through the alpha channel, so the RGB underneath is never seen — which is
//    what lets one file work on a light taskbar and a dark one.
{
  const { data, info } = await sharp(MARK_SOURCE, { density: 600 })
    .resize(TRAY_SIZE, TRAY_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    mask[i * 4] = 255;
    mask[i * 4 + 1] = 255;
    mask[i * 4 + 2] = 255;
    mask[i * 4 + 3] = data[i * 4 + 3];
  }
  writeFileSync(join(OUT, "piko-tray.png"), encodePNG(info.width, mask));
  console.log(`piko-tray.png — ${TRAY_SIZE}x${TRAY_SIZE}, alpha only`);
}

// 4. The bare mark and its black twin, exported as PNGs for anything that cannot take
//    a vector (docs, the settings window, a README). Written beside the sources so
//    the brand folder stays the thing a person edits.
mkdirSync(join(BRAND, "png"), { recursive: true });
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  for (const [name, source] of [["piko-mark", MARK_SOURCE], ["piko-mark-dark", join(BRAND, "piko-mark-dark.svg")]]) {
    await sharp(source, { density: 600 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(join(BRAND, "png", `${name}-${size}.png`));
  }
}
console.log("assets/brand/png — mark and dark twin at 16…512");

console.log("done");