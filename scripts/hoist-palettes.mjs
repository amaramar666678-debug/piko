// One-off: hoist the six palettes into named constants so the SVG body layers
// and the canvas engine stop carrying their own copies of the same hex codes.
// Two lists of colours is how the Settings preview and the island drifted apart.
import { readFileSync, writeFileSync } from "node:fs";

const file = "src/characters/cast.ts";
let src = readFileSync(file, "utf8");

const INK = "#1a1412";
const palettes = {
  heart: { top: "#ffc4dc", bottom: "#f089b4", ink: INK, accent: "#f4505e" },
  cat: { top: "#ffd49b", bottom: "#e5a05c", ink: INK, accent: "#f47ba8" },
  bunny: { top: "#ffd7ec", bottom: "#e9a9d2", ink: INK, accent: "#f472b6" },
  robot: { top: "#c3d9f4", bottom: "#7593c2", ink: "#0f172a", accent: "#22d3ee" },
  glasses: { top: "#d6e0ff", bottom: "#94a9f2", ink: "#1e1b4b", accent: "#4f46e5" },
  bob: { top: "#ffe9bf", bottom: "#d3ab63", ink: INK, accent: "#f59e0b" },
};

// Insert the table just above the first character definition.
const anchor = "const heart: Character = {";
if (!src.includes(anchor)) {
  console.log("anchor not found");
  process.exit(1);
}
const block = `/**
 * The six palettes, in one place.
 *
 * These were written twice — once here for the SVG layers and once in the canvas
 * engine — and the two copies drifted, which is how the preview and the island
 * ended up showing different colours for the same character. Everything that
 * paints a body reads these now.
 */
const P = {
${Object.entries(palettes)
  .map(([k, v]) => `  ${k}: { top: "${v.top}", bottom: "${v.bottom}", ink: ${v.ink === INK ? "INK" : `"${v.ink}"`}, accent: "${v.accent}" },`)
  .join("\n")}
} satisfies Record<CharacterId, CharacterPalette>;

`;
src = src.replace(anchor, block + anchor);

// Point every character at the table.
for (const [id, p] of Object.entries(palettes)) {
  const from = `palette: { top: "${p.top}", bottom: "${p.bottom}", ink: ${p.ink === INK ? "INK" : `"${p.ink}"`}, accent: "${p.accent}" },`;
  if (!src.includes(from)) {
    console.log("palette line not found for", id);
    continue;
  }
  src = src.replace(from, `palette: P.${id},`);

  // And the SVG body layer at the same time.
  const bodyFrom = `bodyFill("${p.top}", "${p.bottom}")`;
  if (!src.includes(bodyFrom)) {
    console.log("bodyFill not found for", id);
    continue;
  }
  src = src.replace(bodyFrom, `bodyFill(P.${id})`);
}

// bodyFill now takes the palette itself.
src = src.replace(
  `function bodyFill(top: string, bottom: string, extra = ""): string {`,
  `function bodyFill(p: CharacterPalette): string {\n  const { top, bottom } = p;`,
);

writeFileSync(file, src, "utf8");
console.log("palettes hoisted");