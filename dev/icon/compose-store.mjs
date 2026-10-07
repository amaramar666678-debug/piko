// Store tile sheet: the Square*Logo / StoreLogo set composited at the sizes a
// Store listing or Start menu uses, on the light and dark surfaces both get used
// against. Read-only over src-tauri/icons.
//
//   node dev/icon/compose-store.mjs <out-dir>

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ICONS = "src-tauri/icons";
const OUT = process.argv[2] ?? "dev/icon/shots";
mkdirSync(OUT, { recursive: true });

const TILES = [
  ["Square44x44Logo.png", 44, "44 Start menu"],
  ["Square71x71Logo.png", 71, "71 Start menu"],
  ["Square107x107Logo.png", 107, "107 Start menu"],
  ["Square142x142Logo.png", 142, "142 taskbar"],
  ["Square150x150Logo.png", 150, "150 Start tile"],
  ["Square284x284Logo.png", 284, "284 Start tile"],
  ["Square310x310Logo.png", 310, "310 Start tile"],
  ["StoreLogo.png", 50, "50 Store"],
];

const CELL = 330;
const GAP = 16;
const PAD = 26;
const LABEL = 20;

const label = (text, w, ink) => Buffer.from(
  `<svg width="${w}" height="${LABEL}"><text x="${w / 2}" y="14" ` +
  `font-family="Segoe UI, sans-serif" font-size="13" fill="${ink}" ` +
  `text-anchor="middle">${text}</text></svg>`,
);

async function band(bg, ink) {
  const width = PAD * 2 + TILES.length * (CELL + GAP);
  const height = PAD * 2 + CELL + LABEL;
  const comps = [];
  await Promise.all(
    TILES.map(async ([file, native, text], i) => {
      const x = PAD + i * (CELL + GAP);
      const draw = Math.min(native, CELL);
      const icon = await sharp(join(ICONS, file))
        .resize(draw, draw, { fit: "fill", kernel: "lanczos3" })
        .png()
        .toBuffer();
      comps.push({ input: icon, left: x + ((CELL - draw) >> 1), top: PAD + CELL - draw });
      comps.push({ input: label(text, CELL, ink), left: x, top: PAD + CELL });
    }),
  );
  return sharp({ create: { width, height, channels: 4, background: bg } })
    .composite(comps)
    .png()
    .toBuffer();
}

const light = await band("#eef0f3", "#3a4048");
const dark = await band("#171a1f", "#c9d1d9");
const m = await sharp(light).metadata();

await sharp({
  create: { width: m.width, height: m.height * 2 + 12, channels: 4, background: "#0c0e11" },
})
  .composite([
    { input: light, left: 0, top: 0 },
    { input: dark, left: 0, top: m.height + 12 },
  ])
  .png()
  .toFile(join(OUT, "sheet-store.png"));

console.log(`sheet-store.png — ${TILES.length} store assets, light + dark`);