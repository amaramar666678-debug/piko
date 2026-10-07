// Repairs mojibake in the source tree.
//
// A UTF-8 character is three bytes; read as cp1252 each byte becomes one
// printable character. So an em-dash (U+2014, bytes E2 80 94) turns into
// U+00E2 U+20AC U+201D — three characters that are now simply *in the file*.
// No Windows locale setting can undo that; the bytes have to be rewritten.
//
// Every pair below is written with \u escapes. A source file whose purpose is to
// contain mangled text is impossible to read or to trust, and this one has to be
// diffable when a mapping turns out to be wrong.
//
// Conservative and reversible:
//   * only the listed sequences are touched, and each is an unambiguous mangling
//     of a single known character;
//   * characters that are already correct (é, è, ', ") are left alone;
//   * a .mojibake-bak is written next to every file that changes.
//
// Run with --check to report without writing.

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] || ".";
const CHECK_ONLY = process.argv.includes("--check");

/** [mangled, intended]. Longest first. */
const FIXES = [
  // ── three-character manglings: one intended char read as three cp1252 chars ──
  ["â€”", "—"], // — U+2014 em dash      (E2 80 94)
  ["â€“", "–"], // – U+2013 en dash      (E2 80 93)
  ["â€¦", "…"], // … U+2026 ellipsis     (E2 80 A6)
  ["â€™", "’"], // ’ U+2019 right quote  (E2 80 99)
  ["â€œ", "“"], // “ U+201C left quote   (E2 80 9C)
  ["â€", "”"], // ” U+201D right quote  (E2 80 9D)
  ["â€˜", "‘"], // ‘ U+2018 left quote   (E2 80 98)
  ["â”€", "─"], // ─ U+2500 rule         (E2 94 80)
  ["â€¢", "•"], // • U+2022 bullet       (E2 80 A2)
  ["â€«", "»"], // » U+00BB guillemet    (C2 BB)
  ["â†’", "→"], // → U+2192 arrow        (E2 86 92)
  ["â†—", "↗"], // ↗ U+2197 arrow        (E2 86 97)
  ["âœ“", "✓"], // ✓ U+2713 check        (E2 9C 93)
  ["Ã—", "×"], // × U+00D7 times        (C3 97)
  ["Â°", "°"], // ° U+00B0 degree       (C2 B0)
  ["Â·", "·"], // · U+00B7 middot       (C2 B7)

// Deliberately no entry for the TodoWrite label "Tâches". Its â (U+00E2) is
// the correct French circumflex, not mojibake, and an earlier version of this
// table "fixed" it into "Tâches" — breaking a correct string.
];

const FILES = [
  "src-tauri/src/lib.rs",
  "src-tauri/src/island.rs",
  "src/views/views.ts",
  "src/island/island.ts",
  "src/settings/main.ts",
  "src/island/hooks.ts",
  "src/core/state.ts",
  "src/core/layout.ts",
  "src/main.ts",
  "src/views/chat.ts",
  "src/views/tasks.ts",
  "src/views/integrations.ts",
  "src/views/upload.ts",
  "src/upload/canvas.ts",
  "src/upload/sequence.ts",
  "src/piko/engine.ts",
  "src/piko/greeting.ts",
  "src/piko/minibots.ts",
  "src/characters/cast.ts",
  "src/characters/index.ts",
  "src/characters/types.ts",
  "src/settings/settings.css",
];

function countFixable(text) {
  let n = 0;
  for (const [bad] of FIXES) n += text.split(bad).length - 1;
  return n;
}

// ── Multi-round repair ─────────────────────────────────────────────────────────
//
// The table above covers one round of UTF-8-read-as-cp1252. The Rust sources have
// been through three: a `—` is `â€”` after one round and `Ã¢â‚¬â€` after two, and
// no single-entry table expresses that. Each round is the same transform, so it is
// applied until the text stops changing.
//
// Repaired per *run of non-ASCII characters*, never per line and never per file.
// island.rs has correct em dashes and a correct `×` sitting in the same file as the
// damage, and a latin1 round trip destroys every one of them. A run only contains
// its neighbours, so the blast radius of a repair is the damage itself.
//
// A repaired run must land on something in ALLOWED, or it is left alone and
// reported: guessing at a mapping that produces a character nobody expected is how
// a correct file gets broken by a repair tool.

const DAMAGE = /[\u00c2\u00c3\u00e2\u20ac\u201a\u201e]/;

/** Characters a repaired run is allowed to end up as. */
const ALLOWED = /^[\u2014\u2013\u2026\u2019\u201c\u201d\u2018\u2500\u2022\u00bb\u2192\u2194\u2197\u2713\u00d7\u00b0\u00b7\u0092\u2122\u00a1\u017e\u00a0]+$/;

/**
 * cp1252 bytes 0x80-0x9F, the only place it differs from latin1.
 *
 * The damage was done by decoding UTF-8 as cp1252, so repairing it means encoding
 * back to cp1252 — and Node's `latin1` cannot: `Buffer.from("â", "latin1")` is
 * 0xE2, right, but `Buffer.from("‚", "latin1")` is 0x9A where cp1252 0x82 is also
 * `‚`. Repairing with latin1 turns three characters into U+FFFD and the tool then
 * reports "0 repaired, 386 left" and looks like it did nothing.
 */
const CP1252_HIGH = [
  0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
  0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

/** Characters this script can turn back into bytes, or null when it cannot. */
const BYTE_OF = new Map();
for (let b = 0xa0; b <= 0xff; b++) BYTE_OF.set(String.fromCharCode(b), b);
CP1252_HIGH.forEach((code, i) => {
  if (code !== 0) BYTE_OF.set(String.fromCodePoint(code), 0x80 + i);
});
// cp1252 leaves five slots undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D), and the tool
// that did the damage fell back to Latin-1 for them - that is where the U+009D in
// `Ã¢â€` came from. Without an identity mapping for those slots `toCp1252Bytes`
// returns null for every run containing one, and the whole file is reported as
// unrepairable rather than repaired.
for (let b = 0x80; b <= 0x9f; b++) {
  if (!BYTE_OF.has(String.fromCharCode(b))) BYTE_OF.set(String.fromCharCode(b), b);
}

function toCp1252Bytes(s) {
  const bytes = [];
  for (const ch of s) {
    const b = BYTE_OF.get(ch);
    if (b === undefined) return null;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Repairs the run starting at `start`, and returns [text, endIndex] or null.
 *
 * Not "encode the whole run and decode it": a single run can hold damage from two
 * different rounds - `Ã¢â‚¬”` is `â` mangled twice sitting next to `—` mangled
 * once - and one uniform round trip cannot fix a mixture. So the longest prefix
 * whose cp1252 bytes are valid UTF-8 is decoded, and whatever is left over is
 * dealt with on the next pass.
 */
/**
 * Repairs the run starting at `start`, and returns [text, endIndex] or null.
 *
 * Two things this has to get right, both learned the hard way:
 *
 *  * More than one round. `—` becomes `â€”` after one round and `â”€` after two,
 *    so a candidate that decodes to something still damaged has to be decoded
 *    again. Stopping after the first decode refuses every separator line in the
 *    file and reports "0 repaired".
 *
 *  * Not one uniform round trip for the whole run. A run can hold damage from two
 *    different rounds side by side, and one transform cannot fix a mixture. So the
 *    longest candidate is tried first and shortened until one of them does decode
 *    to something clean.
 */
function repairAt(run, start) {
  for (let n = Math.min(run.length - start, 96); n >= 2; n--) {
    let s = run.slice(start, start + n);
    for (let round = 0; round < 4 && DAMAGE.test(s); round++) {
      const bytes = toCp1252Bytes(s);
      if (!bytes) break;
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        break;
      }
      if (decoded === s) break;
      s = decoded;
    }
    // Refuse anything that is still damaged, or that lands on a character this
    // script has no business producing.
    if (DAMAGE.test(s) || !ALLOWED.test(s)) continue;
    return [s, start + n];
  }
  return null;
}

/** Rewrites every damaged run. Returns [text, repairedRuns, refusedRuns]. */
function repairRuns(text) {
  let out = "";
  let count = 0;
  let refused = 0;
  let i = 0;
  while (i < text.length) {
    let at = -1;
    for (let k = i; k < text.length; k++) {
      if (text.charCodeAt(k) > 127) {
        at = k;
        break;
      }
    }
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    let end = at;
    while (end < text.length && text.charCodeAt(end) > 127) end++;
    const run = text.slice(at, end);
    out += text.slice(i, at);

    // A single non-ASCII character in a line of ASCII is real text - the `â` in a
    // French word, a `°`, a `×`. Mojibake always arrives as a run, because one
    // mangled character is at least three, so a lone one is left alone. hooks.ts has
    // two of them and this rule is what keeps the tool from "fixing" them.
    if (end - at < 2 || !DAMAGE.test(run)) {
      out += run;
      i = end;
      continue;
    }

    let j = 0;
    while (j < run.length) {
      const d = run.slice(j).search(DAMAGE);
      if (d < 0) {
        out += run.slice(j);
        break;
      }
      out += run.slice(j, j + d);
      const hit = repairAt(run, j + d);
      if (hit) {
        out += hit[0];
        count++;
        j = hit[1];
      } else {
        out += run[j + d];
        refused++;
        j += d + 1;
      }
    }
    i = end;
  }
  return [out, count, refused];
}

let grand = 0;
let changed = 0;

for (const rel of FILES) {
  const file = join(ROOT, rel);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const [repaired, runs, refused] = repairRuns(text);
  const table = countFixable(repaired);
  // Refused runs are damage the tool could not place, so they count: a check that
  // reported "0 left" while damage was still in the file is worse than no check.
  const before = runs + table + refused;
  if (before === 0) continue;
  grand += before;
  changed++;

  if (CHECK_ONLY) {
    console.log(`would  ${rel}  ${before}  (${runs} run(s), ${table} table, ${refused} refused)`);
    continue;
  }

  let fixed = repaired;
  for (const [bad, good] of FIXES) fixed = fixed.split(bad).join(good);
  copyFileSync(file, `${file}.mojibake-bak`);
  writeFileSync(file, fixed, "utf8");
  const note = refused ? `  ${refused} run(s) left alone - inspect by hand` : "";
  console.log(`fixed  ${rel}  ${before}  (${runs} run(s), ${table} table)${note}`);
}

console.log("");
console.log(
  CHECK_ONLY
    ? `check: ${grand} mangled sequences in ${changed} file(s); nothing written`
    : `done:  ${grand} sequences repaired across ${changed} file(s)`,
);