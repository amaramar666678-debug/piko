// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

/**
 * Which screen edge the collapsed bubble sits against.
 *
 * The island used to be pinned to the middle of the top edge with no way to move
 * it. A bubble that can be dragged but always springs back to the middle is worse
 * than one that cannot move, so it takes the edge it was dropped nearest.
 */
export type Dock = "top" | "left" | "right" | "bottom";

const DOCKS: readonly Dock[] = ["top", "left", "right", "bottom"];

/**
 * Any dock string, made into one of the four real edges.
 *
 * The value comes out of settings, which can predate the field, be hand-edited,
 * or come across a version boundary. An unrecognised edge has to land somewhere:
 * one that quietly meant "no offset at all" is how the bubble ended up drawn in a
 * corner nobody picked.
 */
export function normaliseDock(dock: unknown): Dock {
  const d = typeof dock === "string" ? dock.trim().toLowerCase() : "";
  return (DOCKS as readonly string[]).includes(d) ? (d as Dock) : "top";
}

/**
 * Where the island sits inside its window.
 *
 * Only the panel moves: it hangs off the top edge of a 720×320 window and is
 * centred in it. The bubble is also centred, but in a 104×104 window of its own,
 * so "which edge" is answered by moving the window rather than by placing the
 * circle inside it — which is the whole reason dragging reached the far side of
 * the screen in the first place.
 */
export function dockOffset(dock: Dock, w: number, h: number): { x: number; y: number } {
  const centredX = (PANEL_W - w) / 2;
  const centredY = (PANEL_H - h) / 2;
  switch (normaliseDock(dock)) {
    case "left":
      return { x: 0, y: centredY };
    case "right":
      return { x: PANEL_W - w, y: centredY };
    case "bottom":
      return { x: centredX, y: PANEL_H - h };
    default:
      return { x: centredX, y: 0 };
  }
}

/** The bubble's place inside the compact window, which is its own centre. */
export function bubbleOffset(): { x: number; y: number } {
  return { x: (COMPACT_W - BUBBLE) / 2, y: (COMPACT_H - BUBBLE) / 2 };
}

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "prompt"
  | "note"
  | "settings"
  | "newtask"
  | "greeting";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 720×320 (largest view) like the macOS panel; the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 720;
export const PANEL_H = 320;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const EXPANDED_W = 640;

/**
 * The collapsed island's window.
 *
 * It used to stay 720×320 with the bubble drawn inside it, which sounds harmless
 * and is not: a 720-wide window on a 1280-wide screen can only slide between
 * x=0 and x=560, so the bubble could never get within half its width of either
 * side. Dragging it felt like hitting invisible walls. The window is now the
 * bubble's own neighbourhood, so the bubble can go anywhere on the display.
 *
 * Wider than the bubble because the glow is `BUBBLE * 1.7` across and is drawn
 * inside this window — sized to the bubble it would be clipped at the edge of
 * every screen it touched.
 */
export const COMPACT_W = 104;
export const COMPACT_H = 104;

export const ROUNDED_CORNER = 14; // hidden
export const EXPANDED_CORNER = 22;
/** Sentinels for "round it fully": the island reads these, not the number. */
export const CIRCLE_RADIUS = -1;
export const COMPACT_RADIUS = CIRCLE_RADIUS;

/**
 * The collapsed island is a circle, not a bar.
 *
 * It used to be a 288×32 rectangle with 14 px corners holding a row of tiny
 * agents. That row is gone — the agents are only drawn while the panel is open —
 * so what was left was a wide empty box. `BUBBLE` is the diameter: equal width
 * and height is what makes `border-radius: 50%` a circle rather than a lozenge.
 */
export const BUBBLE = 56;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 54, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  // Agent list, the agent row itself and what can go into it, plus a three-way
  // choice of what the task should do. Tall enough that the whole screen is on
  // screen: with the rows wrapped at this width it needs the room, and the primary
  // action here — picking an agent — must not be below a fold.
  newtask: { height: 316, botX: 52, botY: null, botDiameter: 44, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Mochi included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/**
 * Chat view grows with the conversation — IslandContainer.chatPromptHeight.
 *
 * The 264 base is not the 240 it was: the room now carries a segmented mode
 * control, a row of agent cards and a taller composer above the log, and at 240
 * the first message arrived with the log clipped to a couple of lines.
 */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 264 + messageCount * 40);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
      case "compact":
        return { w: BUBBLE, h: BUBBLE };
    case "expanded": {
      const h = view === "prompt" ? chatPromptHeight(chatCount) : VIEW_LAYOUTS[view].height;
      return { w: EXPANDED_W, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
      case "compact":
        return { cx: BUBBLE / 2, cy: BUBBLE / 2, diameter: BUBBLE * 0.74, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
