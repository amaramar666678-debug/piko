// Preview rig for the Piko robot app icon. Writes into dev/icon/ only: nothing
// here touches src-tauri/icons, the bundle config or the frontend.
//
//   node dev/icon/build-variants.mjs
//
// sharp is already a devDependency, and it rasterises the source SVG through
// librsvg, so the antenna and the 1px details survive the trip. The one thing
// that needs care is framing: the SVG's viewBox is a square 200x200 but the
// artwork is not centred inside it and is taller than it is wide (the antenna
// adds height at the top), so `fit: contain` on the raw viewBox leaves a much
// bigger margin than 10%. Trim to the painted pixels first, then contain.

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = "C:/Users/User/Desktop/character piko/robot.svg";

const MASTER = 1024;
const MARGIN = 0.1; // 10% free space per side
const INNER = Math.round(MASTER * (1 - MARGIN * 2));

// Palette lifted straight out of robot.svg. BG_INK is the robot's own visor
// colour, which keeps the tile in the same family as the island instead of
// borrowing a colour from elsewhere in the app.
const C = {
  mint: "#9fe3d0",
  teal: "#6fcfba",
  cyan: "#7ff3ff",
  visor: "#1f2a33",
  ink: "#231f20",
  pink: "#ff7a8a",
};

const SIZES = [16, 24, 32, 48, 256];

// ── master ────────────────────────────────────────────────────────────────────

async function masterPng() {
  // density 600 gives librsvg ~1600px of working room before any scaling, so
  // the 6px strokes and the rx=8 arm caps are still several device pixels wide
  // at the moment they get rasterised.
  const painted = await sharp(SRC, { density: 600 })
    .trim({ threshold: 1 })
    .png()
    .toBuffer();

  const m = await sharp(painted).metadata();
  console.log(
    `painted box: ${m.width}x${m.height} (ratio ${(m.width / m.height).toFixed(3)})`,
  );

  return sharp(painted)
    .resize(INNER, INNER, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
}

/** Transparent tile: the artwork alone, 10% margin all round. */
async function variantTransparent(inner) {
  return sharp({
    create: {
      width: MASTER,
      height: MASTER,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: inner, gravity: "center" }])
    .png()
    .toBuffer();
}

/**
 * Tiled variant: the artwork inset inside a rounded square of solid colour.
 * The tile is the full 1024 with no margin, because the tile itself *is* the
 * margin — a taskbar slot crops to the tile edges, so a transparent ring on top
 * of a solid tile would just shrink the robot inside an already-small box.
 */
async function variantTiled(inner) {
  const pad = Math.round(MASTER * 0.06);
  const side = MASTER - pad * 2;
  const r = Math.round(side * 0.22); // iOS-ish squircle feel
  const robot = await sharp(inner)
    .resize(side, side, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const tile = Buffer.from(
    `<svg width="${MASTER}" height="${MASTER}">
       <rect x="0" y="0" width="${MASTER}" height="${MASTER}" rx="${r}" ry="${r}" fill="${C.visor}"/>
       <rect x="${pad}" y="${pad}" width="${side}" height="${side}" rx="${Math.round(
         r * 0.82,
       )}" ry="${Math.round(r * 0.82)}" fill="none" stroke="${C.teal}" stroke-opacity="0.28" stroke-width="${Math.round(
         MASTER * 0.008,
       )}"/>
     </svg>`,
  );

  return sharp(tile)
    .composite([{ input: robot, gravity: "center" }])
    .png()
    .toBuffer();
}

// ── preview sheet ─────────────────────────────────────────────────────────────

const LIGHT = "#eef0f3";
const DARK = "#14171c";

// Each column gets a fixed 256px cell: the icon at its true pixel size sitting
// on the baseline, and the same pixels blown up with nearest-neighbour so what
// actually lands on a 16px taskbar slot can be judged by eye.
const CELL = 256;
const GAP = 16;
const PAD = 24;
const LABEL = 22;

/** native size + a nearest-neighbour blow-up, so pixel loss is actually visible */
async function swatches(master) {
  const out = [];
  for (const s of SIZES) {
    const at = await sharp(master)
      .resize(s, s, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer();
    const zoom = s <= 48 ? Math.min(8, Math.floor(256 / s)) : 1;
    const big =
      zoom > 1
        ? await sharp(at)
            .resize(s * zoom, s * zoom, { fit: "fill", kernel: "nearest" })
            .png()
            .toBuffer()
        : at;
    out.push({ s, zoom, at, big, bigSize: s * zoom });
  }
  return out;
}

async function panel(list, bg, ink) {
  const width = PAD * 2 + list.length * CELL + (list.length - 1) * GAP;
  const height = PAD * 2 + CELL + LABEL;

  const comps = [];
  list.forEach((item, i) => {
    const x = PAD + i * (CELL + GAP);
    comps.push({ input: item.big, left: x + ((CELL - item.bigSize) >> 1), top: PAD });
    // true size, baseline-aligned with the blow-up so the eye compares them
    comps.push({ input: item.at, left: x + ((CELL - item.s) >> 1), top: PAD + CELL - item.s });
    comps.push({
      input: Buffer.from(
        `<svg width="${CELL}" height="${LABEL}"><text x="${CELL / 2}" y="16" ` +
          `font-family="Segoe UI, sans-serif" font-size="14" fill="${ink}" ` +
          `text-anchor="middle">${item.s}px${item.zoom > 1 ? ` → ${item.zoom}×` : ""}</text></svg>`,
      ),
      left: x,
      top: PAD + CELL,
    });
  });

  return sharp({ create: { width, height, channels: 4, background: bg } })
    .composite(comps)
    .png()
    .toBuffer();
}

async function sheet(master, name) {
  const list = await swatches(master);
  const light = await panel(list, LIGHT, "#3a4048");
  const dark = await panel(list, DARK, "#c9d1d9");
  const gap = 16;
  const meta = await sharp(light).metadata();
  await sharp({
    create: {
      width: meta.width,
      height: meta.height * 2 + gap,
      channels: 4,
      background: "#00000000",
    },
  })
    .composite([
      { input: light, left: 0, top: 0 },
      { input: dark, left: 0, top: meta.height + gap },
    ])
    .png()
    .toFile(join(HERE, `preview-${name}.png`));
}

// ── go ─────────────────────────────────────────────────────────────────────────

mkdirSync(HERE, { recursive: true });

const inner = await masterPng();
const variants = [
  ["a", await variantTransparent(inner)],
  ["b", await variantTiled(inner)],
];

for (const [name, buf] of variants) {
  const file = join(HERE, `master-${name}.png`);
  await sharp(buf).png().toFile(file);
  console.log(`${file} — ${buf.length} bytes`);
  for (const s of SIZES) {
    const p = join(HERE, `${name}-${s}.png`);
    await sharp(buf)
      .resize(s, s, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toFile(p);
  }
  await sheet(buf, name);
  console.log(`preview-${name}.png written`);
}