// Extracts the CSS rules the agent-picker harness needs out of the real
// stylesheet, so the harness cannot drift from what the app actually ships.
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync("src/style.css", "utf8");

const WANTED = [
  ".pills",
  ".pill-grid",
  ".pill.add",
  ".pill.add:hover",
  ".pill {",
  ".pill .lbl",
  ".agent-picker",
  ".agent-picker-empty",
  ".agent-row",
  ".agent-row:hover",
  ".agent-row i",
  ".agent-picker-done",
  ".agent-picker-done:hover",
];

const found = [];
for (const sel of WANTED) {
  // Match the selector at the start of a line, then its brace block.
  const re = new RegExp(
    "(?:^|\\n)" + sel.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(?:,[^{]*)?\\{[^}]*\\}",
    "g",
  );
  const m = css.match(re);
  if (m) found.push(m.join("\n"));
  else console.log("not found:", sel);
}

// The rules reference custom properties, so carry :root along.
const vars = css.match(/:root\s*\{[^}]*\}/);
if (vars) found.unshift(vars[0]);

writeFileSync("dist/picker-harness.css", found.join("\n\n"), "utf8");
console.log(`extracted ${found.length} blocks`);