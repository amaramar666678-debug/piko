// The six characters. Every one is a stack of layers in the same 100×100
// viewBox so they can be swapped mid-animation without anything shifting.
//
//   behind — ears, antennae, hair: anything the body must cover
//   body   — the silhouette itself
//   front  — the face
//
// Eyes and mouths are shared builders below. A character only says which pair
// it wants; states override the pair when the mood changes it.

import type { Character, CharacterId, CharacterPalette } from "./types";

// ── Shared face parts ─────────────────────────────────────────────────────────

const INK = "#1a1412";

/** Two pill eyes. `look` shifts both pupils the way the canvas does. */
function pillEyes(y: number, look = 0): string {
  const w = 4.6;
  const h = 6;
  const px = 2 * look;
  const left = 38 + px - w / 2;
  const right = 62 + px - w / 2;
  return `
    <rect x="${left}" y="${y - h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="${INK}"/>
    <rect x="${right}" y="${y - h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="${INK}"/>`;
}

function wideEyes(y: number): string {
  return `
    <circle cx="38" cy="${y}" r="6.4" fill="#fff"/>
    <circle cx="62" cy="${y}" r="6.4" fill="#fff"/>
    <circle cx="38" cy="${y}" r="3" fill="${INK}"/>
    <circle cx="62" cy="${y}" r="3" fill="${INK}"/>`;
}

function happyEyes(y: number): string {
  const arc = (cx: number) =>
    `<path d="M ${cx - 5.5} ${y} Q ${cx} ${y - 6.5} ${cx + 5.5} ${y}" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>`;
  return arc(38) + arc(62);
}

function flatEyes(y: number): string {
  return `
    <rect x="32" y="${y - 1.4}" width="12" height="2.8" rx="1.4" fill="${INK}"/>
    <rect x="56" y="${y - 1.4}" width="12" height="2.8" rx="1.4" fill="${INK}"/>`;
}

function closedEyes(y: number): string {
  const arc = (cx: number) =>
    `<path d="M ${cx - 5} ${y} Q ${cx} ${y + 5} ${cx + 5} ${y}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
  return arc(38) + arc(62);
}

function tiredEyes(y: number): string {
  const arc = (cx: number) =>
    `<path d="M ${cx - 5} ${y - 1} Q ${cx} ${y + 4.5} ${cx + 5} ${y - 1}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
  return arc(38) + arc(62);
}

function heartEyes(y: number): string {
  const heart = (cx: number) => {
    const s = 0.62;
    return `<g transform="translate(${cx} ${y}) scale(${s})">
      <path d="M 0 6 C -9 -0.5 -7 -8 -2.6 -8 C -0.9 -8 0 -6.6 0 -5.6 C 0 -6.6 0.9 -8 2.6 -8 C 7 -8 9 -0.5 0 6 Z" fill="#f4505e"/>
    </g>`;
  };
  return heart(38) + heart(62);
}

function starEyes(y: number): string {
  const star = (cx: number) => {
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 6.2 : 2.7;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(y + r * Math.sin(a)).toFixed(2)}`);
    }
    return `<polygon points="${pts.join(" ")}" fill="#fbbf24"/>`;
  };
  return star(38) + star(62);
}

function winkEyes(y: number): string {
  return `
    <rect x="33" y="${y - 3}" width="9" height="6" rx="3" fill="${INK}"/>
    <path d="M 57 ${y} Q 62 ${y - 5} 67 ${y}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
}

function spiralEyes(y: number): string {
  const spiral = (cx: number) => {
    const d: string[] = [];
    for (let i = 0; i <= 44; i++) {
      const t = (i / 44) * Math.PI * 4.2;
      const r = 0.5 + t * 0.62;
      d.push(`${(cx + r * Math.cos(t)).toFixed(2)} ${(y + r * Math.sin(t)).toFixed(2)}`);
    }
    return `<path d="M ${d.join(" L ")}" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round"/>`;
  };
  return spiral(38) + spiral(62);
}

function smileMouth(y: number): string {
  return `<path d="M 43 ${y} Q 50 ${y + 7} 57 ${y}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
}

function openMouth(y: number): string {
  return `<ellipse cx="50" cy="${y}" rx="5.2" ry="6.4" fill="#7a2f3a"/>`;
}

function bigSmile(y: number): string {
  return `<path d="M 41 ${y - 2} Q 50 ${y + 10} 59 ${y - 2} Z" fill="#7a2f3a"/>`;
}

function frownMouth(y: number): string {
  return `<path d="M 43 ${y + 5} Q 50 ${y - 1} 57 ${y + 5}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
}

function oMouth(y: number): string {
  return `<ellipse cx="50" cy="${y}" rx="3.4" ry="4.6" fill="#7a2f3a"/>`;
}

// ── Body shapes ───────────────────────────────────────────────────────────────

/**
 * Mixes a hex colour toward white.
 *
 * Used for the body sheen, which used to be literal `#fff`. Because it sits where
 * a cheek highlight does, a fixed white there read as "the face never changes
 * colour" no matter which character was picked.
 */
function lighten(hex: string, t: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) =>
    Math.round(c + (255 - c) * t),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The body shape, as an SVG layer.
 *
 * Takes the palette rather than two colours so the preview cannot drift from the
 * canvas engine: they were two separate lists of hex codes, and only one of them
 * got updated when a colour changed.
 */
function bodyFill(p: CharacterPalette): string {
  const { top, bottom } = p;
  const id = `piko-body-${top.slice(1)}`;
  return `
    <defs>
      <linearGradient id="${id}" x1="0.7" y1="0.15" x2="0.3" y2="0.85">
        <stop offset="0" stop-color="${top}"/>
        <stop offset="1" stop-color="${bottom}"/>
      </linearGradient>
    </defs>
    <!-- A circle, not the old egg: the island draws an ellipse and the two
         shapes disagreed. -->
    <ellipse cx="50" cy="52" rx="40" ry="40" fill="url(#${id})" stroke="${bottom}" stroke-width="1"/>
    <ellipse cx="34" cy="34" rx="11" ry="7.5" fill="${lighten(top, 0.35)}" opacity="0.3" transform="rotate(-28 34 34)"/>`;
}

function blush(color = "#f4505e", opacity = 0.4): string {
  return `<ellipse cx="26" cy="63" rx="6.5" ry="3.8" fill="${color}" opacity="${opacity}"/>
          <ellipse cx="74" cy="63" rx="6.5" ry="3.8" fill="${color}" opacity="${opacity}"/>`;
}

// ── The characters ────────────────────────────────────────────────────────────

/**
 * The six palettes, in one place.
 *
 * These were written twice — once here for the SVG layers and once in the canvas
 * engine — and the two copies drifted, which is how the preview and the island
 * ended up showing different colours for the same character. Everything that
 * paints a body reads these now.
 */
const P = {
  heart: { top: "#ff9ec4", bottom: "#e0578f", ink: INK, accent: "#f4505e" },
  cat: { top: "#ffbe7a", bottom: "#d98535", ink: INK, accent: "#f47ba8" },
  bunny: { top: "#ffb3d9", bottom: "#dd7fb8", ink: INK, accent: "#f472b6" },
  robot: { top: "#a8c8ee", bottom: "#5f7fb5", ink: "#0f172a", accent: "#22d3ee" },
  glasses: { top: "#b9c8ff", bottom: "#7488e0", ink: "#1e1b4b", accent: "#4f46e5" },
  bob: { top: "#ffd894", bottom: "#c99a45", ink: INK, accent: "#f59e0b" },
} satisfies Record<CharacterId, CharacterPalette>;

const heart: Character = {
  id: "heart",
  label: "Heart",
  palette: P.heart,
  layers: [
    {
      name: "behind",
      svg: `<path d="M 50 88 C 22 66 14 46 22 32 C 29 20 44 22 50 32 C 56 22 71 20 78 32 C 86 46 78 66 50 88 Z"
                  fill="#f7a8c4" opacity="0.85"/>`,
    },
    { name: "body", svg: bodyFill(P.heart) },
    { name: "front", svg: blush("#f4505e", 0.34) },
  ],
  face: { eyes: pillEyes(50), mouth: smileMouth(66) },
  state: {
    finished: { eyes: happyEyes(50), mouth: bigSmile(66), ring: "#34d399" },
    error: { eyes: flatEyes(50), mouth: frownMouth(66), ring: "#f4505e" },
    sleeping: { eyes: closedEyes(50), dim: 0.55 },
    approval: { eyes: wideEyes(50), mouth: bigSmile(66), ring: "#f5a524" },
    question: { mouth: oMouth(66), ring: "#22d3ee" },
    dizzy: { eyes: spiralEyes(50), mouth: oMouth(66), ring: "#f472b6" },
    love: { eyes: heartEyes(50) },
    surprised: { eyes: wideEyes(50), mouth: oMouth(66) },
    proud: { eyes: starEyes(50), mouth: bigSmile(66) },
    wink: { eyes: winkEyes(50), mouth: bigSmile(66) },
    happy: { eyes: happyEyes(50), mouth: bigSmile(66) },
    yawn: { eyes: tiredEyes(50), mouth: openMouth(66) },
    annoyed: { eyes: flatEyes(50), mouth: frownMouth(66) },
  },
  shapes: { idle: { eye: "pill", mouth: "smile" }, working: { eye: "pill", mouth: "smile" } },
};

const cat: Character = {
  id: "cat",
  label: "Cat",
  palette: P.cat,
  layers: [
    {
      name: "behind",
      svg: `<path d="M 22 38 L 26 12 L 44 26 Z" fill="#f0b980" stroke="#d99b5f" stroke-width="1"/>
            <path d="M 78 38 L 74 12 L 56 26 Z" fill="#f0b980" stroke="#d99b5f" stroke-width="1"/>
            <path d="M 27 34 L 29 21 L 39 28 Z" fill="#f7a8c4"/>
            <path d="M 73 34 L 71 21 L 61 28 Z" fill="#f7a8c4"/>`,
    },
    { name: "body", svg: bodyFill(P.cat) },
    {
      name: "front",
      // Whiskers and nose only: the eyes and mouth come from `face`.
      svg: `<path d="M 50 63 L 46.5 61 M 50 63 L 53.5 61 M 50 63 L 50 60.5"
                  stroke="${INK}" stroke-width="1.8" stroke-linecap="round" fill="none"/>
            <path d="M 14 60 L 30 62 M 14 66 L 30 66 M 86 60 L 70 62 M 86 66 L 70 66"
                  stroke="${INK}" stroke-width="1.3" stroke-linecap="round" opacity="0.55"/>`,
    },
  ],
  face: { eyes: pillEyes(52), mouth: smileMouth(68) },
  state: {
    finished: { eyes: happyEyes(52), mouth: bigSmile(68), ring: "#34d399" },
    error: { eyes: flatEyes(52), mouth: frownMouth(68), ring: "#f4505e" },
    sleeping: { eyes: closedEyes(52), dim: 0.55 },
    approval: { eyes: wideEyes(52), ring: "#f5a524" },
    question: { mouth: oMouth(68), ring: "#22d3ee" },
    dizzy: { eyes: spiralEyes(52), mouth: oMouth(68), ring: "#f472b6" },
    love: { eyes: heartEyes(52) },
    surprised: { eyes: wideEyes(52), mouth: oMouth(68) },
    proud: { eyes: starEyes(52), mouth: bigSmile(68) },
    wink: { eyes: winkEyes(52), mouth: bigSmile(68) },
    happy: { eyes: happyEyes(52), mouth: bigSmile(68) },
    yawn: { eyes: tiredEyes(52), mouth: openMouth(68) },
    annoyed: { eyes: flatEyes(52), mouth: frownMouth(68) },
  },
  shapes: { idle: { eye: "pill", mouth: "cat" }, working: { eye: "pill", mouth: "cat" } },
};

const bunny: Character = {
  id: "bunny",
  label: "Bunny",
  palette: P.bunny,
  layers: [
    {
      name: "behind",
      svg: `<ellipse cx="36" cy="18" rx="7.5" ry="18" fill="#fdf2f8" stroke="#d9bcd4" stroke-width="1" transform="rotate(-9 36 18)"/>
            <ellipse cx="64" cy="18" rx="7.5" ry="18" fill="#fdf2f8" stroke="#d9bcd4" stroke-width="1" transform="rotate(9 64 18)"/>
            <ellipse cx="36" cy="19" rx="3.4" ry="12" fill="#f7a8c4" transform="rotate(-9 36 19)"/>
            <ellipse cx="64" cy="19" rx="3.4" ry="12" fill="#f7a8c4" transform="rotate(9 64 19)"/>`,
    },
    { name: "body", svg: bodyFill(P.bunny) },
    {
      name: "front",
      // Blush and the nose triangle; the mouth strokes are part of `face`.
      svg: `${blush("#f472b6", 0.3)}
            <path d="M 46.5 63 L 53.5 63 L 50 67 Z" fill="#f472b6"/>`,
    },
  ],
  face: {
    eyes: pillEyes(52),
    mouth: `<path d="M 50 67 Q 45 70 42.5 67.5 M 50 67 Q 55 70 57.5 67.5"
                  stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  },
  state: {
    finished: { eyes: happyEyes(52), mouth: bigSmile(70), ring: "#34d399" },
    error: { eyes: flatEyes(52), mouth: frownMouth(70), ring: "#f4505e" },
    sleeping: { eyes: closedEyes(52), dim: 0.55 },
    approval: { eyes: wideEyes(52), ring: "#f5a524" },
    question: { mouth: oMouth(70), ring: "#22d3ee" },
    dizzy: { eyes: spiralEyes(52), mouth: oMouth(70), ring: "#f472b6" },
    love: { eyes: heartEyes(52) },
    surprised: { eyes: wideEyes(52), mouth: oMouth(70) },
    proud: { eyes: starEyes(52), mouth: bigSmile(70) },
    wink: { eyes: winkEyes(52), mouth: bigSmile(70) },
    happy: { eyes: happyEyes(52), mouth: bigSmile(70) },
    yawn: { eyes: tiredEyes(52), mouth: openMouth(70) },
    annoyed: { eyes: flatEyes(52), mouth: frownMouth(70) },
  },
  shapes: { idle: { eye: "pill", mouth: "flat" }, working: { eye: "pill", mouth: "flat" } },
};

const robot: Character = {
  id: "robot",
  label: "Robot",
  palette: P.robot,
  layers: [
    {
      name: "behind",
      svg: `<path d="M 50 14 L 50 4" stroke="#64748b" stroke-width="2.4" stroke-linecap="round"/>
            <circle cx="50" cy="4" r="3.4" fill="#22d3ee"/>`,
    },
    { name: "body", svg: bodyFill(P.robot) },
    {
      name: "front",
      // The visor frame. The two lamps in it are the eyes, and the grille is the
      // mouth, so both live in `face` and are swapped with the state.
      svg: `<rect x="22" y="40" width="56" height="24" rx="10" fill="#0f172a"/>`,
    },
  ],
  face: {
    eyes: `<circle cx="38" cy="50" r="4.6" fill="#22d3ee"/><circle cx="62" cy="50" r="4.6" fill="#22d3ee"/>`,
    mouth: `<rect x="36" y="69" width="28" height="6" rx="3" fill="#0f172a"/>
           <circle cx="50" cy="72" r="2.4" fill="#22d3ee"/>`,
  },
  state: {
    finished: { eyes: `<path d="M 33 52 Q 38 46 43 52" stroke="#34d399" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 57 52 Q 62 46 67 52" stroke="#34d399" stroke-width="3" fill="none" stroke-linecap="round"/>`, ring: "#34d399" },
    error: { eyes: `<path d="M 34 47 L 42 53 M 42 47 L 34 53 M 58 47 L 66 53 M 66 47 L 58 53" stroke="#f4505e" stroke-width="2.6" stroke-linecap="round"/>`, ring: "#f4505e" },
    sleeping: { eyes: `<path d="M 33 52 Q 38 56 43 52" stroke="#94a3b8" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 57 52 Q 62 56 67 52" stroke="#94a3b8" stroke-width="3" fill="none" stroke-linecap="round"/>`, dim: 0.55 },
    approval: { eyes: `<circle cx="38" cy="50" r="5.6" fill="#f5a524"/><circle cx="62" cy="50" r="5.6" fill="#f5a524"/>`, ring: "#f5a524" },
    question: { mouth: `<circle cx="50" cy="72" r="3.6" fill="#22d3ee"/>`, ring: "#22d3ee" },
    dizzy: { eyes: `<path d="M 34 50 h 8 M 58 50 h 8" stroke="#f472b6" stroke-width="3" stroke-linecap="round"/>`, ring: "#f472b6" },
    surprised: { eyes: `<circle cx="38" cy="50" r="5.6" fill="#22d3ee"/><circle cx="62" cy="50" r="5.6" fill="#22d3ee"/>`, mouth: `<circle cx="50" cy="72" r="3.6" fill="#22d3ee"/>` },
    happy: { ring: "#22d3ee" },
  },
  shapes: { idle: { eye: "dot", mouth: "flat" }, working: { eye: "dot", mouth: "flat" } },
};

const glasses: Character = {
  id: "glasses",
  label: "Glasses",
  palette: P.glasses,
  layers: [
    { name: "behind", svg: `<ellipse cx="50" cy="94" rx="26" ry="7" fill="#1e1b4b" opacity="0.12"/>` },
    { name: "body", svg: bodyFill(P.glasses) },
    {
      name: "front",
      // The spectacles themselves: lenses, bridge and arms. They are the eyes,
      // so the pupils move to `face.eyes` where a state can replace them.
      svg: `${blush("#4f46e5", 0.22)}
            <circle cx="38" cy="51" r="10.5" fill="#fff" opacity="0.55" stroke="#1e1b4b" stroke-width="2.6"/>
            <circle cx="62" cy="51" r="10.5" fill="#fff" opacity="0.55" stroke="#1e1b4b" stroke-width="2.6"/>
            <path d="M 48.5 51 L 51.5 51" stroke="#1e1b4b" stroke-width="2.6"/>
            <path d="M 27.5 51 L 14 47 M 72.5 51 L 86 47" stroke="#1e1b4b" stroke-width="2.6" stroke-linecap="round"/>`,
    },
  ],
  face: {
    eyes: `<circle cx="37" cy="50" r="3" fill="#1e1b4b"/><circle cx="63" cy="50" r="3" fill="#1e1b4b"/>`,
    mouth: `<path d="M 45 70 Q 50 74 55 70" fill="none" stroke="#1e1b4b" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  state: {
    finished: { eyes: `<path d="M 30 52 Q 38 44 46 52" fill="none" stroke="#1e1b4b" stroke-width="2.8" stroke-linecap="round"/><path d="M 54 52 Q 62 44 70 52" fill="none" stroke="#1e1b4b" stroke-width="2.8" stroke-linecap="round"/>`, mouth: bigSmile(70), ring: "#34d399" },
    // A frown, not the idle smile: a smiling face inside a red ring reads as fine.
    error: { eyes: `<path d="M 34 47 L 42 55 M 42 47 L 34 55 M 58 47 L 66 55 M 66 47 L 58 55" stroke="#1e1b4b" stroke-width="2.4" stroke-linecap="round"/>`, mouth: frownMouth(70), ring: "#f4505e" },
    sleeping: { eyes: `<path d="M 32 49 Q 38 55 44 49" fill="none" stroke="#1e1b4b" stroke-width="2.4" stroke-linecap="round"/><path d="M 56 49 Q 62 55 68 49" fill="none" stroke="#1e1b4b" stroke-width="2.4" stroke-linecap="round"/>`, dim: 0.55 },
    approval: { ring: "#f5a524" },
    question: { mouth: oMouth(70), ring: "#22d3ee" },
    love: { eyes: heartEyes(51), mouth: bigSmile(70) },
    surprised: { mouth: oMouth(70) },
    proud: { mouth: bigSmile(70) },
    happy: { mouth: bigSmile(70) },
    yawn: { mouth: openMouth(70) },
    annoyed: { mouth: frownMouth(70) },
  },
  shapes: { idle: { eye: "wide", mouth: "smile" }, working: { eye: "wide", mouth: "smile" } },
};

const bob: Character = {
  id: "bob",
  label: "Bob",
  palette: P.bob,
  layers: [
    {
      name: "behind",
      svg: `<path d="M 50 10 C 74 10 88 26 88 46 C 88 60 84 66 84 66 L 16 66 C 16 66 12 60 12 46 C 12 26 26 10 50 10 Z"
                  fill="#8b5e3c"/>`,
    },
    { name: "body", svg: bodyFill(P.bob) },
    {
      name: "front",
      // Bangs and sideburns. The face itself is appended after this.
      svg: `${blush("#f59e0b", 0.3)}
            <path d="M 50 12 C 70 12 82 24 84 40 C 76 30 66 26 50 26 C 34 26 24 30 16 40 C 18 24 30 12 50 12 Z"
                  fill="#8b5e3c"/>
            <path d="M 22 52 C 22 40 30 32 40 32 L 34 46 Z" fill="#8b5e3c"/>
            <path d="M 78 52 C 78 40 70 32 60 32 L 66 46 Z" fill="#8b5e3c"/>`,
    },
  ],
  face: { eyes: pillEyes(56), mouth: smileMouth(72) },
  state: {
    finished: { eyes: happyEyes(56), mouth: bigSmile(72), ring: "#34d399" },
    error: { eyes: flatEyes(56), mouth: frownMouth(72), ring: "#f4505e" },
    sleeping: { eyes: closedEyes(56), dim: 0.55 },
    approval: { eyes: wideEyes(56), ring: "#f5a524" },
    question: { mouth: oMouth(72), ring: "#22d3ee" },
    dizzy: { eyes: spiralEyes(56), mouth: oMouth(72), ring: "#f472b6" },
    love: { eyes: heartEyes(56) },
    surprised: { eyes: wideEyes(56), mouth: oMouth(72) },
    proud: { eyes: starEyes(56), mouth: bigSmile(72) },
    wink: { eyes: winkEyes(56), mouth: bigSmile(72) },
    happy: { eyes: happyEyes(56), mouth: bigSmile(72) },
    yawn: { eyes: tiredEyes(56), mouth: openMouth(72) },
    annoyed: { eyes: flatEyes(56), mouth: frownMouth(72) },
  },
  shapes: { idle: { eye: "pill", mouth: "tongue" }, working: { eye: "pill", mouth: "tongue" } },
};

export const CHARACTERS: readonly Character[] = [heart, cat, bunny, robot, glasses, bob];

export const CHARACTER_IDS = CHARACTERS.map((c) => c.id);

const BY_ID = new Map<CharacterId, Character>(CHARACTERS.map((c) => [c.id, c]));

export function characterById(id: CharacterId | string | null | undefined): Character {
  return (id && BY_ID.get(id as CharacterId)) || heart;
}

export function isCharacterId(id: unknown): id is CharacterId {
  return typeof id === "string" && BY_ID.has(id as CharacterId);
}