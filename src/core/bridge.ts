// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[piko] ${cmd} failed`, err);
    return null;
  }
}

/**
 * Whether a command that returns nothing actually succeeded.
 *
 * `call` cannot answer this itself: for a `void` command `invoke` resolves to
 * `undefined`, and `undefined == null` is true, so a caller checking
 * `result == null` sees a failure on every successful save. Anything with a
 * button behind it needs to know, so those calls report it here.
 */
async function ran(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    await invoke(cmd, args);
    return true;
  } catch (err) {
    console.error(`[piko] ${cmd} failed`, err);
    return false;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  /**
   * Persists preferences. Resolves true when Rust wrote the file, so a caller can
   * tell a saved choice from one that silently went nowhere.
   */
  saveSettings: (settings: Settings) => ran("save_settings", { settings }),

  /**
   * Resizes the island's window to match what it is doing: the open panel, the
   * collapsed bubble, or the hidden wake strip.
   *
   * The bubble has its own window rather than being drawn inside the panel's. A
   * 720-wide window cannot slide far enough for a 56 px bubble inside it to reach
   * either side of a 1280-wide screen, which is what made dragging feel like it
   * was hitting walls.
   */
  setIslandShape: (shape: "panel" | "bubble" | "strip") =>
    call<void>("set_island_shape", { shape }),

  // ── Moving the island ───────────────────────────────────────────────────────
  // The header is the handle. Positions are CSS pixels; Rust owns the arithmetic
  // in physical ones, because the display's scale is not visible from a webview.

  /** The island window's top-left, to turn a pointer delta into a target. */
  islandPosition: () => call<[number, number] | null>("island_position"),

  islandDragStart: () => call<void>("island_drag_start"),
  islandDragTo: (x: number, y: number) => call<void>("island_drag_to", { x, y }),
  /** Releases the mouse and writes the position to disk — once, not per move. */
  islandDragEnd: () => call<void>("island_drag_end"),
  islandRecenter: () => call<void>("island_recenter"),
  /**
   * Docks the bubble to a screen edge. `size` is the bubble's own diameter in
   * CSS pixels: with the compact window shrunk to the bubble's own box, Rust needs
   * nothing else to work out where the window goes.
   */
  islandDock: (dock: string, size: number) =>
    call<void>("island_dock", { dock, bubbleSize: size, islandX: 0, islandY: 0 }),

  /**
   * Where the window is and how big its display is, all in CSS pixels. Snapping
   * the bubble to the nearest edge needs both, and the webview can work out
   * neither: it has no window position and no idea what the display's scale is.
   */
  islandGeometry: () => call<IslandGeometry | null>("island_geometry"),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** The old single-target button. Kept for the finished/error cards. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * What this machine can open a folder in, right now.
   *
   * Asked for when the menu is built rather than cached at startup: a machine
   * gains VS Code or the OpenCode app by installing it, and a list captured at
   * launch would quietly lie about it afterwards.
   */
  openTargets: () => call<OpenTarget[]>("open_targets"),

  /**
   * Opens a folder in one of those. `path` may be null, in which case Rust uses
   * the last project a task ran in and refuses when there is none — there is no
   * hidden default directory to fall back on.
   */
  openIn: (target: string, path: string | null) => callOrThrow<string>("open_in", { target, path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),
  /** Hides the settings window — what its close button does, and what Escape now does. */
  closeSettingsWindow: () => call<void>("close_settings_window"),

  /** Writes to %LOCALAPPDATA%\Piko\piko.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),


  // ── OpenCode permission cards ─────────────────────────────────────────────
  approvalDecision: (requestId: string, decision: "allow" | "always" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "Nobody can act on this" — the question stays open inside OpenCode. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /**
   * Fires one chat turn and resolves as soon as OpenCode has accepted it.
   *
   * The answer is not in here: it arrives as `chat-text` events on the stream,
   * which is what lets the reply be read while it is still being written.
   */
  chatSend: (query: string, context: ChatContext | null, agent?: string | null) =>
    callOrThrow<void>("chat_send", { query, context, agent: agent ?? null }),
  chatReset: () => call<void>("chat_reset"),
  /**
   * Aborts the turn in flight.
   *
   * A turn can also be ended by events, but those stop arriving when the stream is
   * what broke — which is exactly when the person watching wants to stop it.
   */
  chatStop: () => callOrThrow<void>("chat_stop"),
opencodeTest: () => callOrThrow<string>("opencode_test"),
opencodeDetect: () => call<string | null>("opencode_detect"),

  // ── Connection ────────────────────────────────────────────────────────────────

  /**
   * One health check against the configured address.
   *
   * Answers even when nothing is running, which is what makes it usable as a
   * status line and as the Retry: `opencode_test` fails instead, so it can only
   * ever be the answer to "does it work" and never the answer to "why not".
   */
  opencodeHealth: () => callOrThrow<OpenCodeHealth>("opencode_health"),

  /**
   * Starts an OpenCode on the configured port, and waits for it to answer.
   *
   * A server already at that address is left alone rather than joined by a second
   * one, and only a server this started is stopped when Piko exits.
   */
  opencodeStart: () => callOrThrow<string>("opencode_start"),

  /**
   * Keeps (or stops) the background reconnect loop.
   *
   * Started while the chat room is open, because that is the only time a connection
   * the island cannot see is worth anything. One loop runs at a time however many
   * times this is called with `true`.
   */
  opencodeWatch: (on: boolean) => call<void>("opencode_watch", { on }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  /**
   * How many integration API keys are stored.
   *
   * A count, not the keys: the settings badge says "there are some" and nothing
   * more, so there is nothing here that could be logged or shown by accident. One
   * call rather than one per key.
   */
  secretStoredCount: () => call<number>("secret_stored_count"),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Tasks ──────────────────────────────────────────────────────────────────
  /** Fires the prompt and returns; progress arrives on the `tasks` stream. */
  taskStart: (directory: string, prompt: string, agent?: string | null, kind?: string) =>
    callOrThrow<TaskInfo>("task_start", { directory, prompt, agent: agent ?? null, kind: kind ?? null }),
  taskList: () => call<TaskInfo[]>("task_list"),
  /** The last folders a task ran in, most recent first. */
  taskFolders: () => call<string[]>("task_folders"),
  taskAbort: (id: string) => callOrThrow<void>("task_abort", { id }),
  /** Same session, so a finished task can be continued rather than restarted. */
  taskFollowup: (id: string, text: string) => callOrThrow<void>("task_followup", { id, text }),
  /** `GET /agent`, server default first. Never a provider list. */
  taskAgents: () => callOrThrow<AgentInfo[]>("task_agents"),
  /** "Open in OpenCode". Empty string = it worked; anything else = a reason. */
  taskOpen: (id: string) => call<string>("task_open", { id }),
  /** Native folder picker. */
  pickFolder: () => call<string | null>("pick_folder"),

  // ── MCP: screen control, gated in Rust ─────────────────────────────────────
  // Nothing here decides anything. `mcpAnswer` records a human's word and the
  // server's own gate decides whether that was enough.

  /** Drives the island's indicator: on/off, whether a card is up, and the chord. */
  mcpStatus: () => call<McpStatus>("mcp_status"),
  /** The master switch. Persisted by Rust, not by the webview. */
  mcpSetEnabled: (enabled: boolean) => call<McpStatus>("mcp_set_enabled", { enabled }),
  /** Allow / Deny on the card. `session` is the "for this session" tick. */
  mcpAnswer: (id: string, allow: boolean, session: boolean) =>
    call<boolean>("mcp_answer", { id, allow, session }),
  /** The kill switch, reachable from the island as well as the hotkey. */
  mcpKill: () => call<McpStatus>("mcp_kill"),
  /** False when another app already owns Ctrl+Alt+Shift+Esc. */
  mcpKillHotkeyAvailable: () => call<boolean>("mcp_kill_hotkey_available"),
  /** The exact change registration would make. Shown before anything is written. */
  mcpRegisterPlan: () => callOrThrow<McpRegisterPlan>("mcp_register_plan"),
  /** Only writes the change identified by `digest`; anything else is refused. */
  mcpRegisterApply: (digest: string) => callOrThrow<string>("mcp_register_apply", { digest }),
  mcpRegisterRemove: () => callOrThrow<string | null>("mcp_register_remove"),
};

/** The window's place and size on screen, plus its display's, in CSS pixels. */
export interface IslandGeometry {
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  monX: number;
  monY: number;
  monW: number;
  monH: number;
}

/** `lib.rs::OpenTarget` — one place this machine can open a project folder in. */
export interface OpenTarget {
  id: "vscode" | "opencode-app" | "opencode-cli";
  label: string;
}

/**
 * `opencode.rs::Health` — one health check's answer.
 *
 * `ok: false` is not an error here: "nothing is answering, and here is why" is the
 * thing the island needs to show, so it comes back as a value rather than a
 * rejection. `reason` is the short form; the full reqwest chain is in the log.
 */
export interface OpenCodeHealth {
  ok: boolean;
  url: string;
  version?: string;
  reason?: string;
  /** The `opencode` program is not installed at all. */
  cliMissing: boolean;
}

/** `mcpserver::Status`, serialised camelCase. */
export interface McpStatus {
  enabled: boolean;
  /** True when opencode.json carries our entry. */
  registered: boolean;
  /** True while a card is up. */
  awaiting: boolean;
  action: string | null;
  description: string | null;
  killHint: string;
  remainingThisSec: number;
}

/** What the card shows. `description` never contains typed text. */
export interface McpAsk {
  id: string;
  action: string;
  description: string;
}

export interface McpRegisterPlan {
  path: string;
  exists: boolean;
  alreadyRegistered: boolean;
  /** True while running from target\debug, i.e. a path that will not survive. */
  debugBuild: boolean;
  command: string[];
  timeoutMs: number;
  /** Unified diff. Empty when nothing would change. */
  diff: string;
  /** Identifies this exact diff; `mcpRegisterApply` will not write another one. */
  digest: string;
  backup: string;
  /** True when the rewrite also moves lines the user wrote. */
  reformats: boolean;
}

/** A task as Rust reports it — `TaskInfo`, serialised camelCase. */
export interface TaskInfo {
  id: string;
  session: string;
  directory: string;
  title: string;
  agent: string | null;
  /** "running" | "finished" | "error" | "aborted" */
  state: string;
  startedMs: number;
  endedMs: number | null;
  /** "tool · target" for the line under the title. */
  step: string | null;
  todos: Todo[];
  error: string | null;
}

export interface Todo {
  content: string;
  /** "pending" | "in_progress" | "completed" | "cancelled" — shown verbatim. */
  status: string;
  priority: string;
  /** Decided in Rust, where the "unknown status is not finished" rule lives. */
  done: boolean;
}

/** `tasks::AgentInfo`, serialised camelCase. */
export interface AgentInfo {
  name: string;
  description: string;
  /** "primary" | "subagent" | "all". Only a primary one can answer a chat turn. */
  mode: string;
  /** Run by OpenCode itself, not offered as a choice (compaction, summary, title). */
  hidden: boolean;
  isDefault: boolean;
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Piko");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "tasks"; payload: TaskInfo[] }
  | { name: "task"; payload: TaskInfo }
  /** Rust's own view of the switch. The island renders the indicator from this. */
  | { name: "mcp-status"; payload: McpStatus }
  /** A human is being asked. Carries no typed text, only a description. */
  | { name: "mcp-ask"; payload: McpAsk }
  /** false = the card was dismissed (killed, switched off, timed out). */
  | { name: "mcp-answer"; payload: boolean }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
