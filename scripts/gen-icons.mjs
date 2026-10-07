// The one place Piko's app icon comes from.
//
//   npm run icons
//
// There is no "drawn in code" logo any more and no second script that can
// disagree with this one. Everything downstream — the tray, the window, the
// exe, the desktop shortcut, the NSIS installer and the Store tile — is derived
// from the two masters rendered here, and `tauri icon` fills in the sizes we do
// not hand-pick.
//
// Order matters:
//
//   robot.svg ──> master-b.png      (full detail, 1024, tiled)
//             └─> master-b-small.png (simplified, 1024, tiled)
//                        │
//                        ├─> npx tauri icon  ──> every PNG/icns/Square*/StoreLogo
//                        │
//                        └─> icon.ico, hand-assembled, mixed frames
//
// The ICO is assembled by hand because `tauri icon` gives every frame the same
// artwork, and one artwork cannot be right at both 16px and 256px. The mouth is
// the first casualty at 16px and its absence there reads as a neutral face
// rather than a mistake; the antenna is the opposite, it dissolves into the
// background unless the stroke is thicker than the drawing has any reason to
// draw it. So 16/24/32 come from the simplified master and 48+ from the full one.

import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.PIKO_ROBOT_SVG ?? "C:/Users/User/Desktop/character piko/robot.svg";
const WORK = join(ROOT, "dev", "icon");
const OUT = join(ROOT, "src-tauri", "icons");

const MASTER = 1024;
const MARGIN = 0.1; // 10% free space per side
const INNER = Math.round(MASTER * (1 - MARGIN * 2));
const TILE_PAD = Math.round(MASTER * 0.06); // room for the robot inside the tile
const TILE_RADIUS = 0.22; // fraction of the tile side

// Palette taken from robot.svg, so the tile belongs to the same drawing.
const VISOR = "#1f2a33";
const RULE = "#6fcfba";

// ICO frames, and which master each one is drawn from.
const ICO_FRAMES = [
  { size: 16, from: "small" },
  { size: 24, from: "small" },
  { size: 32, from: "small" },
  { size: 48, from: "full" },
  { size: 64, from: "full" },
  { size: 256, from: "full" },
];

// tauri icon writes the full-detail artwork at every PNG size. The two small
// ones are re-cut from the simplified master so the PNG grid and the ICO agree:
// bundle.icon hands 32x32.png to NSIS, and a shortcut that shows the full-detail
// 32 while the exe shows the simplified 32 is the kind of mismatch nobody
// notices until they do.
const SMALL_PNGS = new Set(["32x32.png", "64x64.png"]);

// ── source ────────────────────────────────────────────────────────────────────

function readSvg() {
  const raw = readFileSync(SRC, "utf8");
  // The file carries a ~7.8KB c2pa manifest. It says nothing about how to draw
  // the robot, it only survives in the original, and sharp would happily ignore
  // it — but it makes diffing the geometry unreadable.
  return raw.replace(/<metadata>[\s\S]*?<\/metadata>/, "");
}

/** Must actually replace, or the small master silently becomes a copy of the full one. */
function sub(svg, from, to, why) {
  if (!svg.includes(from)) {
    throw new Error(`robot.svg changed shape: cannot ${why}\n  looking for: ${from}`);
  }
  return svg.replace(from, to);
}

/**
 * Simplified artwork for the small frames only. Deliberately just two edits, so
 * the small icon stays recognisably the same robot at 48px when the two sit next
 * to each other in the ICO.
 */
function smallSvg(svg) {
  let out = sub(
    svg,
    `<path d="M90 134 Q100 141 110 134" fill="none" stroke="#7ff3ff" stroke-width="5" stroke-linecap="round"/>`,
    "",
    "drop the mouth",
  );
  // 6 -> 10 on the stalk, and a fatter ball to match: at 16px the original
  // leaves barely one device pixel of stalk and the head floats away from it.
  out = sub(
    out,
    `<path d="M100 52 L100 30" fill="none" stroke="#231f20" stroke-width="6"`,
    `<path d="M100 52 L100 30" fill="none" stroke="#231f20" stroke-width="10"`,
    "thicken the antenna stalk",
  );
  return sub(
    out,
    `<circle cx="100" cy="24" r="10" fill="#ff7a8a" stroke="#231f20" stroke-width="6"`,
    `<circle cx="100" cy="24" r="11" fill="#ff7a8a" stroke="#231f20" stroke-width="10"`,
    "thicken the antenna head",
  );
}

// ── render ────────────────────────────────────────────────────────────────────

/**
 * rasterise, trim to the painted pixels, then contain inside the free area.
 *
 * The trim is what makes the 10% margin real. robot.svg's viewBox is a square
 * 200x200 but the artwork inside it is neither square nor centred — the antenna
 * adds height at the top and the body sits low — so containing the raw viewBox
 * silently leaves a much larger margin than asked for.
 */
async function renderArtwork(svg) {
  // density 600 gives librsvg ~1600px of working room before any downscaling, so
  // the 6px strokes are several device pixels wide when they are rasterised.
  const painted = await sharp(Buffer.from(svg), { density: 600 })
    .trim({ threshold: 1 })
    .png()
    .toBuffer();
  const m = await sharp(painted).metadata();
  console.log(`  artwork ${m.width}x${m.height} (ratio ${(m.width / m.height).toFixed(3)})`);
  return sharp(painted)
    .resize(INNER, INNER, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .png()
    .toBuffer();
}

/**
 * The robot inset in a rounded square. The tile is the full 1024 with no margin:
 * the tile is the margin. A transparent ring on top of a solid tile would only
 * shrink the robot inside an already-small box, since taskbar and Explorer slots
 * crop to the tile edges.
 */
async function renderMaster(artwork) {
  const side = MASTER - TILE_PAD * 2;
  const r = Math.round(side * TILE_RADIUS);
  const rule = Math.round(MASTER * 0.008);
  const robot = await sharp(artwork)
    .resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const tile = Buffer.from(
    `<svg width="${MASTER}" height="${MASTER}">
       <rect width="${MASTER}" height="${MASTER}" rx="${r}" ry="${r}" fill="${VISOR}"/>
       <rect x="${TILE_PAD}" y="${TILE_PAD}" width="${side}" height="${side}"
             rx="${Math.round(r * 0.82)}" ry="${Math.round(r * 0.82)}"
             fill="none" stroke="${RULE}" stroke-opacity="0.28" stroke-width="${rule}"/>
     </svg>`,
  );
  return sharp(tile).composite([{ input: robot, gravity: "center" }]).png().toBuffer();
}

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

// PNG-in-ICO, which Windows has read since Vista. Small frames are still
// bit-transparent here, so a simplified 16px frame is not worse off than a
// full-detail one — it is only fewer things to fit.
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

async function downscale(master, size) {
  const rgba = await sharp(master)
    .ensureAlpha()
    .resize(size, size, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  return encodePNG(size, rgba);
}

// ── go ────────────────────────────────────────────────────────────────────────

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const svg = readSvg();
const fullArt = await renderArtwork(svg);
const smallArt = await renderArtwork(smallSvg(svg));
const masterFull = await renderMaster(fullArt);
const masterSmall = await renderMaster(smallArt);

const masters = { full: masterFull, small: masterSmall };
writeFileSync(join(WORK, "robot.svg"), readSvg());
writeFileSync(join(WORK, "robot-small.svg"), smallSvg(svg));
writeFileSync(join(WORK, "master-b.png"), masterFull);
writeFileSync(join(WORK, "master-b-small.png"), masterSmall);
console.log(`dev/icon: robot.svg, robot-small.svg, master-b.png, master-b-small.png`);

// The full-detail master is what everything standard-sized should look like.
// Spawn the local CLI's entry through node rather than going through npx: npx is
// npx.cmd on Windows, which spawnSync will not resolve, and going straight to the
// installed package also means a missing devDependency fails here instead of
// quietly downloading a different CLI version.
const tauriCli = join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
execFileSync(process.execPath, [tauriCli, "icon", join(WORK, "master-b.png")], {
  cwd: ROOT,
  stdio: "inherit",
});

for (const name of SMALL_PNGS) {
  const path = join(OUT, name);
  const size = Number(/^(\d+)x/.exec(name)[1]);
  writeFileSync(path, await downscale(masterSmall, size));
  console.log(`  re-cut ${name} from the simplified master`);
}

const frames = [];
for (const { size, from } of ICO_FRAMES) {
  frames.push({ size, png: await downscale(masters[from], size) });
}
const ico = encodeICO(frames);
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(
  `icon.ico — ${ico.length} bytes — ${ICO_FRAMES.map((f) => `${f.size}(${f.from})`).join(" ")}`,
);

// The tray has no icon file of its own: tray.rs hands the builder
// `app.default_window_icon()`, which Tauri fills from bundle.icon, and bundle.icon
// points at icons/icon.ico. Copying anything here would create a second icon that
// could drift. Say so instead of quietly doing nothing.
if (process.argv.includes("--tray")) {
  console.log("tray: no separate file — it reads default_window_icon() from bundle.icon");
}

console.log("done");