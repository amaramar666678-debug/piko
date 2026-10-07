// Renders every character preview to one HTML page so the SVG layer stack can
// be eyeballed without opening the app.
import { writeFileSync } from "node:fs";
import { getCharacterSVG, CHARACTERS } from "../src/characters/index.ts";

const state = process.argv[2] || "idle";
const cards = CHARACTERS.map((c) => {
  return `<div style="text-align:center;border:2px solid #e5e7eb;border-radius:10px;padding:8px">
  ${getCharacterSVG(c.id, state, 90)}<div>${c.label}</div></div>`;
}).join("");

const html = `<!doctype html><html><body style="background:#f8fafc;font:12px system-ui;margin:0;padding:16px">
<div style="display:flex;gap:14px">${cards}</div></body></html>`;

writeFileSync(process.argv[3] || "C:/Users/User/AppData/Local/Temp/chars.html", html);
console.log(`wrote ${html.length} bytes for state=${state}`);