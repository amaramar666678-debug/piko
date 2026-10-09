// App state — mirror of AppState.swift (the parts the island needs).

import type { BotStateName, Dock, IslandMode, IslandViewName } from "./layout";
import { Bridge, type AgentInfo, type McpAsk, type McpStatus, type TaskInfo } from "./bridge";
import type { CharacterId } from "../characters";

/**
 * How many agent pills fit in the overview row.
 *
 * The row is a 2×2 grid, so four. Note that `integration_claude` (VS Code) is
 * not one of them: it is the default *focus*, and the focus is drawn in the left
 * card, while `otherTasks` — the pill row — is everything except the focus. So
 * this counts integrations directly, with no need to discount VS Code.
 */
export const MAX_ACTIVE_INTEGRATIONS = 4;

export type AgentSource = "claudeCode" | "n8n";

/**
 * What a task is for: look and report, look and act, or both.
 *
 * Kept as one type with a label and an instruction so the chooser, the composer
 * and the card cannot drift apart. The instruction travels as its own message
 * part, after the user's own words, so the task title stays the request.
 */
export type TaskKind = "propose" | "execute" | "both";

export const TASK_KINDS: Array<{ id: TaskKind; label: string; blurb: string }> = [
  { id: "propose", label: "Look", blurb: "Inspect and explain what is wrong. Change nothing." },
  { id: "execute", label: "Act", blurb: "Inspect what is needed, then carry the task out." },
  { id: "both", label: "Both", blurb: "Explain what you would do, then do it." },
];

export function taskKindInstruction(kind: TaskKind): string {
  switch (kind) {
    case "propose":
      return "Read and inspect first, then report what is wrong and what you would change. Do not modify anything yet.";
    case "execute":
      return "Read and inspect what is needed, then carry the task out.";
    case "both":
      return "Read and inspect, report what you would change and why, then carry it out.";
  }
}
export type PillBadge = "approval" | "finished" | "error";

/**
 * What the island knows about the OpenCode connection.
 *
 * `unknown` is deliberate and is not `failed`: the app has not asked yet, and a
 * status line that starts red would be reporting a problem nobody has hit.
 */
export type ConnectionState =
  | { kind: "unknown" }
  /** A check is in flight, or `opencode serve` is being started. */
  | { kind: "connecting"; what: string }
  | { kind: "connected"; version: string; url: string }
  | {
      kind: "failed";
      url: string;
      reason: string;
      /** No `opencode` anywhere — retrying cannot help. */
      cliMissing: boolean;
    };

/** The three places the island knows how to open a folder in. */
export type OpenInTarget = "vscode" | "opencode-app" | "opencode-cli";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** Folder the session runs in, when it is one of our tasks. */
  directory?: string | null;
  /** The task's own words — the best answer to "which task is this?". */
  taskTitle?: string | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

// Was `PromptContext`, with a `promptContext` field beside it: the room builds
// the file context from `droppedFile` when the first message goes out, so it was
// written in three places and read by nothing.

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

/**
 * What every agent's name starts with.
 *
 * Agent names arrive from everywhere — the integration list, a Claude session's
 * project folder, an OpenCode agent chip — so the prefix is applied where a name
 * enters the state rather than at each place one is printed. Idempotent, because
 * `upsert` renames the VS Code agent on every hook event and a name that already
 * carries the prefix must not collect a second one.
 */
export const AGENT_NAME_PREFIX = "piko agent";

export function agentName(name: string): string {
  const n = (name ?? "").trim();
  if (!n) return AGENT_NAME_PREFIX;
  return n.toLowerCase().startsWith(AGENT_NAME_PREFIX) ? n : `${AGENT_NAME_PREFIX} · ${n}`;
}

/**
 * The name with the prefix taken back off.
 *
 * The prefix marks a live agent for places that name the agent doing something. A
 * list of *integrations* is not that: "piko agent · Stripe" as a chip in the agent
 * row says the row belongs to one agent called Stripe.
 */
export function plainName(name: string): string {
  const n = (name ?? "").trim();
  if (!n.toLowerCase().startsWith(AGENT_NAME_PREFIX)) return n;
  return n.slice(AGENT_NAME_PREFIX.length).replace(/^\s*·\s*/, "") || n;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name: agentName(name), color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
    autostart: boolean;
    hooksInstalled: boolean;
    /**
     * Which model the chat should use. Empty means "whatever OpenCode has
     * configured", which is the only correct default now that Piko talks to the
     * server rather than to a Claude endpoint of its own.
     */
    model: string;
  /** Master switch for the MCP input tools. Off unless a person turned it on. */
  inputControlEnabled: boolean;
  /**
   * The 2×2 row of 13px characters in the island's far corner.
   *
   * Off by default. The overview card already carries every one of those agents as
   * a labelled, clickable pill at 24px, so this repeated the same information at a
   * size nobody can read and could not be acted on. See `settings::Settings`.
   */
  miniGrid: boolean;
  /** Empty means "the server's default agent". */
  taskAgent: string;
  /**
   * The agent Ask mode answers with. Separate from `taskAgent` on purpose: a
   * chat is a conversation and a task is work in a folder, and picking one
   * should not silently change the other.
   */
  chatAgent: string;
  /**
   * What the island's "Open in…" button opens. Empty means "whichever of the
   * available targets comes first", which is the only safe default: the list
   * depends on what is installed, and this file cannot know that.
   */
  openInDefault: OpenInTarget | "";
  /** Selected character */
  characterId: CharacterId;
  /** Which screen edge the collapsed bubble docks to. */
  dock: Dock;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
    model: "",
    inputControlEnabled: false,
    miniGrid: false,
  taskAgent: "",
  chatAgent: "",
  openInDefault: "",
  characterId: "heart",
  dock: "top",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  /**
   * A chat turn is in flight. This used to be a variable inside the prompt view,
   * which meant nothing outside that closure could know an answer was on its way
   * — and the island kept collapsing out from under a reply that was still being
   * fetched.
   */
  chatBusy = false;
  /**
   * The turn has been accepted and the agent is still writing, so the last
   * assistant message is being filled in from the stream.
   *
   * `chatBusy` only covers the request itself, which is quick; this one covers the
   * answer, which is not. Holding the input for both is what made the room feel
   * slow — the box stayed locked for the whole turn with nothing to read.
   */
  chatPending = false;
  /**
   * A finished answer is waiting behind another view.
   *
   * Only ever set from `false` to `true`: the reply lands on the chat stream, and
   * if the island is not showing the room at that moment nothing on screen says
   * the agent has spoken. The header's chat button carries a dot for it, and
   * opening the room clears it.
   */
  chatUnread = false;
  /**
   * The card on screen. Everything else an agent asked for waits in
   * `approvalQueue` rather than being refused: two commands in a row is normal,
   * and a human can only answer one at a time anyway.
   */
  pendingApproval: ApprovalInfo | null = null;
  /** OpenCode permissions waiting behind the card. Oldest first. */
  approvalQueue: ApprovalInfo[] = [];

  // ── Tasks ──────────────────────────────────────────────────────────────────
  /** Real OpenCode sessions started from the island, newest first. */
  openTasks: TaskInfo[] = [];
  /** Folder the task composer will use. Null means "not chosen yet". */
  taskFolder: string | null = null;
  /** Last few folders, for the picker's shortcut row. */
  taskFolders: string[] = [];
  /** `GET /agent`. Empty until the server answers. */
  taskAgents: AgentInfo[] = [];
  /**
   * Why the agent list could not be filled, or null.
   *
   * The list used to fail in silence: a failed fetch left `taskAgents` empty, and
   * an empty list made the picker hide itself, so a person asking a question could
   * not tell "OpenCode is not answering" from "there is nothing to choose".
   */
  taskAgentsError: string | null = null;
  /** True once a fetch has come back, so the room can tell loading from empty. */
  taskAgentsLoaded = false;

  /**
   * What is known about the connection to OpenCode.
   *
   * Kept apart from `taskAgentsError` because they are different questions: that
   * one is "can I list agents", this is "is there a server there at all". A Retry
   * that only re-listed agents was the reported bug — it re-asked a question the
   * failure was not about, and did nothing about the answer.
   *
   * `unknown` is the honest starting point: nothing has been asked yet, which is
   * not the same as failed and must not be drawn as though it were.
   */
  connection: ConnectionState = { kind: "unknown" };

  /** "ask" is the normal chat; "task" starts a real session in a folder. */
  chatMode: "ask" | "task" = "ask";
  /**
   * What a task should actually do, chosen on the new-task screen.
   *
   * This is instruction framing, not enforcement: the three kinds differ in what
   * the agent is told, not in what it is able to do. A real read-only mode would
   * have to live in OpenCode's permission layer, which Piko only ever answers
   * per request.
   */
  taskKind: TaskKind = "propose";
  /** Which screen edge the collapsed bubble docks to. */
  dock: Dock = "top";
  /** Set when a task call fails, so the composer can say why. */
  taskError: string | null = null;

  // ── MCP (screen control) ────────────────────────────────────────────────────
  /** Rust's own status. The indicator is a view of this and nothing else. */
  mcp: McpStatus = {
    enabled: false,
    registered: false,
    awaiting: false,
    action: null,
    description: null,
    killHint: "Ctrl+Alt+Shift+Esc",
    remainingThisSec: 5,
  };
  /** The card being asked right now, or null. Never carries typed text. */
  mcpAsk: McpAsk | null = null;
  /**
   * The island is asking the person whether to switch screen control on.
   *
   * A local question with no `id` and nothing waiting on the other side: it is
   * the answer that opens the gate, not a request that came through it. The
   * island could only ever switch control *off* before, because switching it on
   * needs a person to say so and the settings window was the only place that
   * could ask.
   */
  mcpConfirmEnable = false;
  /** False when another app already owns the kill chord. */
  mcpHotkeyFree = true;

  /** True when the indicator should be shown at all: switched on, or a card up. */
  get mcpVisible(): boolean {
    return this.mcp.enabled || this.mcp.awaiting;
  }

  setMcp(status: McpStatus) {
    this.mcp = status;
    // A card that is gone from Rust's side must not linger here either.
    if (!status.awaiting) this.mcpAsk = null;
    this.notify();
  }

  setMcpAsk(ask: McpAsk | null) {
    this.mcpAsk = ask;
    this.notify();
  }

  /** Tasks started by Piko, as opposed to the integration placeholders. */
  get liveTasks(): TaskInfo[] {
    return this.openTasks;
  }

  /** Running first, then most recent — the order the overview lists them in. */
  get sortedTasks(): TaskInfo[] {
    return [...this.openTasks].sort((a, b) => {
      const running = (t: TaskInfo) => (t.state === "running" ? 0 : 1);
      return running(a) - running(b) || b.startedMs - a.startedMs;
    });
  }

  setTasks(list: TaskInfo[]) {
    this.openTasks = list;
    // A task needs its folder remembered even if the user started it here, so the
    // composer opens on the same place next time.
    if (!this.taskFolder) this.taskFolder = list[0]?.directory ?? null;
    this.notify();
  }

  patchTask(task: TaskInfo) {
    const i = this.openTasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.openTasks[i] = task;
    else this.openTasks.unshift(task);
    this.notify();
  }

  /** Task behind an OpenCode session id, for putting a folder on a permission card. */
  taskForSession(sessionId: string): TaskInfo | null {
    if (!sessionId) return null;
    return this.openTasks.find((t) => t.session === sessionId) ?? null;
  }

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** How many approvals are unanswered in total, card included. */
  get approvalsWaiting(): number {
    return (this.pendingApproval ? 1 : 0) + this.approvalQueue.length;
  }

  /**
   * Puts a permission on the card, or behind it if one is already up. Returns
   * true when it went on screen, so the caller knows whether to steal the view.
   */
  pushApproval(a: ApprovalInfo): boolean {
    if (this.pendingApproval && this.pendingApproval.requestId !== a.requestId) {
      // The same request twice is a retry, not a second request to answer.
      if (!this.approvalQueue.some((q) => q.requestId === a.requestId)) {
        this.approvalQueue.push(a);
      }
      this.notify();
      return false;
    }
    this.pendingApproval = a;
    this.notify();
    return true;
  }

  /** The card is gone: promotes the next queued request, if any. */
  advanceApproval(): ApprovalInfo | null {
    this.approvalQueue.shift();
    const next = this.approvalQueue[0] ?? null;
    this.pendingApproval = next;
    if (next) this.notify();
    return next;
  }

  /** Drops a request wherever it is — answered elsewhere, or expired. */
  dropApproval(requestId: string): void {
    if (this.pendingApproval?.requestId === requestId) this.pendingApproval = null;
    this.approvalQueue = this.approvalQueue.filter((q) => q.requestId !== requestId);
    this.notify();
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so pills never shuffle.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // Focus starts on something a person can actually act on. `integration_claude`
    // is still loaded — it carries activity in sessions Piko did not start — but it
    // is no longer a row in the overview, so opening the panel on it would show a
    // card about a thing with no button on it.
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId && t.id !== "integration_claude")) {
      this.focusId = this.tasks.find((t) => t.id !== "integration_claude")?.id ?? "integration_claude";
    }
    this.notify();
  }

  /**
   * Adds or removes one of the optional integrations.
   *
   * Returns true when something changed, and false when the row is already full
   * — the caller turns that into a visible "no room" note rather than pretending
   * the tap did nothing. It also saves, because a pill that reappears on the next
   * launch is worse than one that never appeared at all.
   */
  async toggleIntegration(id: string): Promise<boolean> {
    if (id === "integration_claude") return false;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      // Focus cannot stay on a pill that is no longer there.
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= MAX_ACTIVE_INTEGRATIONS) return false;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
    await Bridge.saveSettings(this.settings);
    return true;
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
