// Composition sheet: the real captures next to the sizes Windows will actually
// pick, on both a light and a dark surface. This is the one image that answers
// "does it read" without anyone having to reason about six separate PNGs.
//
//   node dev/icon/compose.mjs <out-dir>

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const HERE = "dev/icon";
const OUT = process.argv[2] ?? join(HERE, "shots");
mkdirSync(OUT, { recursive: true });

const CELL = 96;
const GAP = 20;
const PAD = 28;
const LABEL = 20;

const frames = [16, 24, 32, 48, 256];

/** SVG label, so the columns are self-describing in the sheet. */
const label = (text, w, ink) => Buffer.from(
  `<svg width="${w}" height="${LABEL}"><text x="${w / 2}" y="14" ` +
  `font-family="Segoe UI, sans-serif" font-size="13" fill="${ink}" ` +
  `text-anchor="middle">${text}</text></svg>`,
);

async function row(bg, ink) {
  const width = PAD * 2 + frames.length * (CELL + GAP);
  const height = PAD * 2 + CELL + LABEL;
  const comps = [];
  await Promise.all(
    frames.map(async (s, i) => {
    const x = PAD + i * (CELL + GAP);
    // 256 is bigger than a cell, so it is shown fitted rather than true size;
    // everything at or below 48 is drawn at its real pixel size, baseline-aligned,
    // because that is the part that has to be judged honestly.
    const draw = Math.min(s, CELL);
    const icon = await sharp(join(HERE, "frames", `frame-${s}.png`))
      .resize(draw, draw, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer();
    comps.push({ input: icon, left: x + ((CELL - draw) >> 1), top: PAD + CELL - draw });
    comps.push({ input: label(`${s}px`, CELL, ink), left: x, top: PAD + CELL });
    }),
  );
  return sharp({ create: { width, height, channels: 4, background: bg } })
    .composite(comps)
    .png()
    .toBuffer();
}

const light = await row("#eef0f3", "#3a4048");
const dark = await row("#171a1f", "#c9d1d9");
const m = await sharp(light).metadata();

await sharp({
  create: { width: m.width, height: m.height * 2 + 12, channels: 4, background: "#0c0e11" },
})
  .composite([
    { input: light, left: 0, top: 0 },
    { input: dark, left: 0, top: m.height + 12 },
  ])
  .png()
  .toFile(join(OUT, "sheet-frames.png"));
console.log("sheet-frames.png — icon.ico frames as Windows picks them, light + dark");