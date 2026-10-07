// Renders every character's island face onto one canvas so the six can be
// compared side by side. Dev tool: `npm run faces`.
//
// The SVG preview in Settings shows the *character art*; this shows what the
// island actually paints, which is a different code path (Canvas 2D) and was the
// one that looked identical for every character.
import { BotEngine } from "../src/piko/engine";
import { CHARACTERS } from "../src/characters";

const SIZE = 120;
const canvas = document.getElementById("c") as HTMLCanvasElement;
const dpr = 2;
// Each character is drawn at three gaze extremes. The middle one is the case
// that used to break: looking far down drove the eyes past the mouth and the
// face overlapped itself.
const GAZE: Array<[label: string, yaw: number, pitch: number]> = [
  ["looking left", -0.85, 0.35],
  ["idle", 0, 0],
  ["down -0.6 (the collision case)", 0, -0.6],
];

canvas.width = SIZE * CHARACTERS.length * dpr;
canvas.height = SIZE * GAZE.length * dpr;
canvas.style.width = `${SIZE * CHARACTERS.length}px`;
canvas.style.height = `${SIZE * GAZE.length}px`;

const x = canvas.getContext("2d")!;
x.scale(dpr, dpr);
x.fillStyle = "#0b0c0e";
x.fillRect(0, 0, canvas.width, canvas.height);

GAZE.forEach(([, yaw, pitch], row) => {
  for (const [i, c] of CHARACTERS.entries()) {
    const e = new BotEngine();
    e.setCharacter(c.id);
    e.setState("idle");
    // Values the engine would hold mid-look; set directly so the harness is not
    // at the mercy of the spring animation timing.
    e.yaw = yaw;
    e.pitch = pitch;

    x.save();
    x.translate(i * SIZE, row * SIZE);
    e.draw(x, SIZE, SIZE);
    x.restore();
  }
});

x.fillStyle = "#c8ccd4";
x.font = "11px system-ui, sans-serif";
x.textAlign = "center";
for (const [i, c] of CHARACTERS.entries()) x.fillText(c.label, i * SIZE + SIZE / 2, SIZE - 6);
for (const [n, [label]] of GAZE.entries()) {
  if (n === 0) continue;
  x.fillText(label, SIZE * 0.5, SIZE * 1 + SIZE - 6);
}

document.title = "ready";