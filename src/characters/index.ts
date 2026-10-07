// Renders a character to a standalone SVG string. Used by the Settings preview
// and anywhere else that needs the character as markup rather than a canvas.

import { CHARACTERS, characterById } from "./cast";
import type { CharacterId, CharacterState } from "./types";

export type {
  Character, CharacterEye, CharacterFaceShape, CharacterId,
  CharacterMouth, CharacterPalette, CharacterState,
} from "./types";
export { CHARACTERS, CHARACTER_IDS, characterById, isCharacterId } from "./cast";

const VIEW_BOX = "0 0 100 100";

/**
 * @param id       which character
 * @param state    a BotStateName or BotEmoteName; anything unknown renders idle
 * @param size     pixel width/height; the SVG scales anyway
 */
export function getCharacterSVG(
  id: CharacterId | string,
  state: string = "idle",
  size = 120,
): string {
  const c = characterById(id);
  const key = (state in c.state ? state : "idle") as CharacterState;
  const ov = c.state[key];
  const dim = ov?.dim ?? 0;

  const behind = c.layers.find((l) => l.name === "behind")?.svg ?? "";
  const body = c.layers.find((l) => l.name === "body")?.svg ?? "";
  const frontDecor = c.layers.find((l) => l.name === "front")?.svg ?? "";

  // The face is composed, not patched. An earlier version swapped eyes and mouth
  // in with `front.replace(c.face.eyes, …)`, which silently did nothing whenever
  // the layer's own whitespace did not match the string being searched for — so
  // Robot and Glasses kept their neutral face inside a red error ring.
  const eyes = ov?.eyes ?? c.face.eyes;
  const mouth = ov?.mouth ?? c.face.mouth;

  const ring = ov?.ring ? ringMarkup(ov.ring) : "";
  const dimStyle = dim > 0 ? `opacity="${1 - dim}"` : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}"`,
    ` width="${size}" height="${size}" class="piko-character" data-character="${c.id}"`,
    ` data-state="${key}" role="img" aria-label="${c.label}">`,
    ring,
    `<g ${dimStyle}>`,
    behind,
    body,
    frontDecor,
    eyes,
    mouth,
    `</g>`,
    `</svg>`,
  ].join("");
}

function ringMarkup(color: string): string {
  return `<circle cx="50" cy="50" r="46" fill="none" stroke="${color}" stroke-width="2" opacity="0.55"/>`;
}

/** Renders a character at a size, for callers that want markup rather than DOM. */
export function characterSVGForState(
  id: CharacterId | string,
  state: string,
  size = 120,
): string {
  return getCharacterSVG(id, state, size);
}

/** Exposed for the Settings preview: every character in one state. */
export function allCharacterPreviews(state: string = "idle", size = 70): { id: CharacterId; label: string; svg: string }[] {
  return CHARACTERS.map((c) => ({ id: c.id, label: c.label, svg: getCharacterSVG(c.id, state, size) }));
}