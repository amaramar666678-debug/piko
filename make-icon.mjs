// The app icon, from the robot SVG, on a square transparent canvas.
//
//   npm i -D sharp && node make-icon.mjs
//
// The drawing is taller than it is wide — the antenna adds the height — so
// `fit: "contain"` inside a padded square is what keeps it centred and whole
// instead of stretched or cropped by whichever shape the icon slot wants next.
// The output is what `npx tauri icon` and the installer take.

import sharp from "sharp";

const src = "C:/Users/User/Desktop/character piko/robot.svg";
const size = 1024, pad = 110;

const inner = await sharp(src, { density: 600 })
  .resize(size - pad * 2, size - pad * 2, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await sharp({
  create: { width: size, height: size, channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile("piko-logo.png");