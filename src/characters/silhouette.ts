// The per-character silhouette drawn behind the body: ears, antennae, hair.
//
// The SVG layers in `cast.ts` are the same shapes for the DOM (Settings
// preview). These are the canvas versions, because the island draws to a canvas
// and cannot composite SVG into it.
//
// Lives in its own module so both draw sites — the island's engine and the
// launch greeting — use one implementation. When the greeting drew its own
// white blob, choosing a character looked like it had done nothing: the greeting
// is the first thing on screen after launch, so it is the first impression.

import { characterById, type CharacterId, type CharacterPalette } from "./index";

/** Canvas-native colours, so a palette can come from either side. */
export interface Rgb {
  top: string;
  bottom: string;
  ink: string;
  accent: string;
}

export function paletteOf(id: CharacterId | string): Rgb {
  const p: CharacterPalette = characterById(id).palette;
  return { top: p.top, bottom: p.bottom, ink: p.ink, accent: p.accent };
}

export function drawSilhouette(
  x: CanvasRenderingContext2D,
  id: CharacterId | string,
  R: number,
  rx: number,
  ry: number,
): void {
  const p = paletteOf(id);
  x.save();

  switch (id) {
    case "cat": {
      x.fillStyle = p.bottom;
      for (const sd of [-1, 1]) {
        const bx = sd * rx * 0.52;
        x.beginPath();
        x.moveTo(bx - R * 0.3, -ry * 0.55);
        x.lineTo(bx - R * 0.16, -ry * 1.42);
        x.lineTo(bx + R * 0.34, -ry * 0.66);
        x.closePath();
        x.fill();
      }
      break;
    }
    case "bunny": {
      x.fillStyle = p.top;
      for (const sd of [-1, 1]) {
        x.save();
        x.translate(sd * rx * 0.36, -ry * 0.95);
        x.rotate(sd * 0.16);
        x.beginPath();
        x.ellipse(0, -R * 0.42, R * 0.15, R * 0.52, 0, 0, Math.PI * 2);
        x.fill();
        x.restore();
      }
      break;
    }
    case "robot": {
      x.strokeStyle = "rgb(100,116,139)";
      x.lineWidth = Math.max(1, R * 0.055);
      x.beginPath();
      x.moveTo(0, -ry * 0.94);
      x.lineTo(0, -ry * 1.36);
      x.stroke();
      x.fillStyle = p.accent;
      x.beginPath();
      x.arc(0, -ry * 1.44, R * 0.09, 0, Math.PI * 2);
      x.fill();
      break;
    }
    case "bob": {
      x.fillStyle = "rgb(139,94,60)";
      x.beginPath();
      x.ellipse(0, -ry * 0.42, rx * 1.06, ry * 0.98, 0, Math.PI, Math.PI * 2);
      x.fill();
      break;
    }
    // "heart" and "glasses" read from the body gradient alone; a heart behind a
    // rounded body is mostly hidden and just muddies the edge.
    default:
      break;
  }

  x.restore();
}