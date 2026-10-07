// The Piko character system. A character is a stack of SVG layers plus the
// palette the canvas renderer uses, so the settings preview and the island draw
// the same creature instead of two different ones.

import type { BotEmoteName, BotStateName } from "../core/layout";

export type CharacterId = "heart" | "cat" | "bunny" | "robot" | "glasses" | "bob";

/** A character answers to every bot state and every emote the island can ask for. */
export type CharacterState = BotStateName | BotEmoteName;

/** Colours shared by the SVG preview and the canvas engine. */
export interface CharacterPalette {
  /** Top of the body gradient. */
  top: string;
  /** Bottom of the body gradient. */
  bottom: string;
  /** Face ink: eyes, mouth, whiskers. */
  ink: string;
  /** Small details: nose, blush, inner ear. */
  accent: string;
}

export type CharacterLayerName = "behind" | "body" | "front";

/** One drawable slice of a character. `svg` is raw markup, no <svg> wrapper. */
export interface CharacterLayer {
  name: CharacterLayerName;
  svg: string;
}

/** Per-state overrides. Anything missing falls back to the default layers. */
export interface CharacterStateOverride {
  /** Replaces the `front` layer's eyes. */
  eyes?: string;
  /** Replaces the `front` layer's mouth. */
  mouth?: string;
  /** Adds a ring in this colour — the state colour, so approval reads orange. */
  ring?: string;
  /** Dims the whole character, for sleeping. */
  dim?: number;
}

/**
 * Canvas eye shapes, matching the engine's `EyeShape` names so the two can be
 * used interchangeably.
 */
export type CharacterEye =
  | "pill" | "wide" | "dot" | "line" | "flat"
  | "happy" | "closed" | "spiral" | "heart" | "star" | "tired" | "wink";

/**
 * Canvas mouth shapes.
 *
 * `cat` is the ω a cat actually has; it is here because at island size the mouth
 * is the clearest thing that tells two characters apart, and without it every
 * character would be the same pill-eyed blob in a different colour.
 */
export type CharacterMouth = "smile" | "open" | "flat" | "frown" | "cat" | "tongue" | "none";

export interface CharacterFaceShape {
  eye: CharacterEye;
  mouth: CharacterMouth;
}

export interface Character {
  id: CharacterId;
  /** Label shown under the preview in Settings. */
  label: string;
  /**
   * Layers, painted back to front. The `front` layer holds decoration only —
   * whiskers, a visor frame, hair. The eyes and mouth are *not* in it: the
   * renderer appends `face` after it, so a state can swap either without the
   * two colliding. See index.ts.
   */
  layers: CharacterLayer[];
  palette: CharacterPalette;
  /** The character's own eyes and mouth, used when a state has no override. */
  face: { eyes: string; mouth: string };
  state: Partial<Record<CharacterState, CharacterStateOverride>>;
  /**
   * How the island draws this character, per bot state.
   *
   * The SVG layers above only reach the Settings preview; the island is a canvas
   * and needs its own shapes. `idle` and `working` are the two states a character
   * spends nearly all its time in, and are the ones that decide whether the
   * character reads as itself rather than as a recoloured default.
   */
  shapes: Partial<Record<"idle" | "working", CharacterFaceShape>>;
}