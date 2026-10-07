// Renders the launch greeting once per character, so the greeting's own colour
// can be checked against the palette the character actually declares.
// Dev tool: `npm run greet`.
import { Greeting, setGreetingCharacter } from "../src/piko/greeting";
import { CHARACTERS } from "../src/characters";

// The greeting lays itself out in a fixed 640×150 reference space (see CARD in
// greeting.ts), so each cell has to scale that down rather than clip it.
const GW = 640;
const GH = 150;
const SCALE = 0.5;
const W = Math.round(GW * SCALE);
const H = Math.round(GH * SCALE);

const canvas = document.getElementById("c") as HTMLCanvasElement;
const dpr = 2;
canvas.width = W * CHARACTERS.length * dpr;
canvas.height = H * dpr;
canvas.style.width = `${W * CHARACTERS.length}px`;
canvas.style.height = `${H}px`;

const x = canvas.getContext("2d")!;
x.scale(dpr, dpr);
x.fillStyle = "#0b0c0e";
x.fillRect(0, 0, canvas.width, canvas.height);

for (const [i, c] of CHARACTERS.entries()) {
  try {
    setGreetingCharacter(c.id);

    const g = new Greeting();
    g.start();
    // The greeting reads `performance.now()`; re-stamp so every cell is the same
    // moment in the animation and the six are comparable.
    (g as unknown as { startMs: number }).startMs = performance.now() - 0.62 * 1000;

    x.save();
    x.translate(i * W, 0);
    x.scale(SCALE, SCALE);
    g.draw(x);
    x.restore();
    g.destroy();

    x.save();
    x.translate(i * W, H - 2);
    x.fillStyle = "#c8ccd4";
    x.font = "13px system-ui, sans-serif";
    x.textAlign = "center";
    x.fillText(`${c.label}  ${c.palette.top}`, W / 2, 0);
    x.restore();
  } catch (e) {
    x.save();
    x.translate(i * W, 10);
    x.fillStyle = "#f4505e";
    x.font = "11px system-ui, sans-serif";
    x.textAlign = "left";
    x.fillText(String((e as Error)?.message ?? e).slice(0, 40), 6, 0);
    x.restore();
  }
}

document.title = "ready";