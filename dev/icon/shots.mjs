// Screenshots of where the icon actually shows up, captured from the running app.
//
//   node dev/icon/shots.mjs <out-dir>
//
// The tray icon cannot be read back out of the shell, so the notification area
// is captured from the screen. That needs the overflow chevron open, because
// Windows parks a fresh tray icon behind it; hence a script rather than a
// one-liner. The island window is undecorated, always-on-top and transparent, so
// it is cropped from the same capture — a screenshot of the window alone would
// come out as a black rectangle.

import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "dev/icon/shots");
mkdirSync(OUT, { recursive: true });

function ps(script) {
  return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
}

const bounds = ps(`
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
"$($b.X),$($b.Y),$($b.Width),$($b.Height)"
`);
const [bx, by, bw, bh] = bounds.split(",").map(Number);
console.log(`screen ${bw}x${bh} at ${bx},${by}`);

const screenFile = join(OUT, "screen.png");
ps(`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save("${screenFile.replace(/\//g, "\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`);

const screen = sharp(screenFile);
const meta = await screen.metadata();
console.log(`captured ${meta.width}x${meta.height} -> ${screenFile}`);

// Open the notification-area overflow, because that is where a tray icon that
// has just been created actually lives. 1280x720 puts the chevron at the far
// right of the work area, 8px in from the edge and just above the taskbar.
const chevron = ps(`
Add-Type -AssemblyName System.Windows.Forms
$t = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
"$($t.Right - 10),$($t.Bottom - 10)"
`);
const [cx, cy] = chevron.split(",").map(Number);

function click(x, y) {
  ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
[M]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 120
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
`);
}

function capture(name, left, top, width, height) {
  return screen
    .clone()
    .extract({ left, top, width, height })
    .png()
    .toFile(join(OUT, `${name}.png`))
    .then(() => console.log(`  ${name}.png  ${width}x${height} @ ${left},${top}`));
}

// 1. Taskbar right-hand end, before opening the overflow: this is the tray as
//    the user sees it when the icon is not pinned to the visible area.
await capture("tray-visible", bw - 260, bh - 48, 260, 48);

// 2. Open the overflow flyout and grab that instead.
click(cx, cy);
await new Promise((r) => setTimeout(r, 1200));
await capture("tray-overflow", bw - 220, bh - 300, 220, 300);
click(cx, cy); // close it again
await new Promise((r) => setTimeout(r, 800));

// 3. The island: top-centre strip of the screen, which is where the undecorated
//    window lives.
await capture("island-top", Math.round(bw / 2) - 320, 0, 640, 120);

// 4. Start-menu style shortcut crop: pin the icon rectangle next to its real
//    self-extracted frames so the two can be compared by eye.
await sharp(readFileSync(join(OUT, "screen.png")))
  .extract({ left: 0, top: 0, width: Math.min(bw, 900), height: Math.min(bh, 600) })
  .png()
  .toFile(join(OUT, "screen-topleft.png"))
  .then(() => console.log("  screen-topleft.png"));

console.log(`done -> ${OUT}`);