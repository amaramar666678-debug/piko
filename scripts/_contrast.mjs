// Contrast of each --dim step against the two surfaces it is drawn on, so raising
// the greys is a measurement rather than a guess.
const lin = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// The card is `rgba(26,29,38,.78)` over the island's own #000 fill, which composites
// to roughly #14161e. The pill fill is `rgba(10,11,15,.45)` over the same.
const CARD = [0x14, 0x16, 0x1e];
const FLAT = [0x0a, 0x0b, 0x0f];

const current = {
  "--dim": "#9aa0ac",
  "--dim-2": "#848a96",
  "--dim-3": "#666c78",
  "--dim-4": "#4e545f",
  "--dim-5": "#3a3f49",
};

console.log("step       vs card    vs pill");
for (const [name, h] of Object.entries(current)) {
  const c = hex(h);
  const a = ratio(c, CARD);
  const b = ratio(c, FLAT);
  const flag = (r) => (r >= 4.5 ? "AA " : r >= 3 ? "AA-lg" : "FAIL");
  console.log(
    `${name.padEnd(10)} ${a.toFixed(2).padStart(5)} ${flag(a)}   ${b.toFixed(2).padStart(5)} ${flag(b)}   ${h}`,
  );
}

console.log("\ncandidates");
for (const [name, h] of Object.entries({
  "dim-3 up": "#7b8290",
  "dim-4 up": "#666d7a",
  "dim-5 up": "#565d6a",
})) {
  const c = hex(h);
  const a = ratio(c, CARD);
  const b = ratio(c, FLAT);
  const flag = (r) => (r >= 4.5 ? "AA " : r >= 3 ? "AA-lg" : "FAIL");
  console.log(`${name.padEnd(10)} ${a.toFixed(2).padStart(5)} ${flag(a)}   ${b.toFixed(2).padStart(5)} ${flag(b)}   ${h}`);
}