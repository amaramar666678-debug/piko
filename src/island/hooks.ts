// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent, type McpAsk, type McpStatus, type TaskInfo } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, agentName, type ApprovalInfo } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

/**
 * OpenCode gives Piko about 108 seconds to answer a permission before it takes
 * the question back itself. After that the card would be lying, so it comes down
 * and the queue moves on.
 */
const APPROVAL_TTL_MS = 110_000;

function clearApprovalTimer() {
  if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
  pendingTimeout = null;
}

/**
 * Called by the island after it promotes the next queued request, so the
 * promoted card gets the same 110 s a fresh one would have had.
 */
export function rearmApprovalTimer(island: Island) {
  armApprovalTimer(island);
}

/** Restarts the clock for whatever is on the card now. */
function armApprovalTimer(island: Island) {
  clearApprovalTimer();
  pendingTimeout = window.setTimeout(() => {
    pendingTimeout = null;
    const stuck = State.pendingApproval;
    if (!stuck) return;
    // Hand it back so OpenCode is not left waiting on a card nobody is looking
    // at. `decline` tells Rust to forget it without answering.
    void Bridge.approvalDecline(stuck.requestId);
    State.dropApproval(stuck.requestId);
    const next = State.advanceApproval();
    if (next) {
      armApprovalTimer(island);
      island.alert("approval");
      return;
    }
    State.isPinned = false;
    island.dropPin();
    State.updateTask(CLAUDE_ID, "working");
    State.setPillBadge(CLAUDE_ID, null);
    if (State.view === "approval") island.setView(State.defaultView());
    State.notify();
  }, APPROVAL_TTL_MS);
}

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  // OpenCode tool names are lowercase.
  bash: "Exécute",
  read: "Lit",
  write: "Écrit",
  edit: "Modifie",
  patch: "Modifie",
  glob: "Cherche",
  grep: "Recherche",
  list: "Liste",
  webfetch: "Récupère",
  websearch: "Recherche web",
  todowrite: "Tâches",
  task: "Agent",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path") ?? str("filePath");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "filePath", // OpenCode read / write / edit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = agentName(projectName);
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = agentName("VS Code");
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // Tasks are pushed, never polled: Rust owns the list and re-emits it whenever a
  // session starts, moves, finishes or is swept.
  void onEvent<TaskInfo[]>("tasks", (list) => State.setTasks(list));
  void onEvent<TaskInfo>("task", (task) => State.patchTask(task));
  registerMcpHandlers(island);
  // One shot at boot, so a reload lands on the tasks that are already running
  // instead of an island that has forgotten about them.
  void Bridge.taskList().then((list) => {
    if (list) State.setTasks(list);
  });
}

/**
 * The MCP indicator and its card.
 *
 * Every fact shown here comes from Rust: the island never infers whether input
 * is on, whether a card is real, or whether a chord still works. That is the
 * point — the webview is the least trustworthy part of this feature, so it is
 * given nothing to decide with.
 */
function registerMcpHandlers(island: Island) {
  void onEvent<McpStatus>("mcp-status", (status) => {
    const wasAwaiting = State.mcp.awaiting;
    State.setMcp(status);
    // The card came down for any reason — answered, timed out, killed, switched
    // off. Whatever the view was showing, the pin it needed is no longer needed.
    if (wasAwaiting && !status.awaiting) releaseMcpPin(island);
  });
  void onEvent<McpAsk>("mcp-ask", (ask) => {
    State.setMcpAsk(ask);
    State.isPinned = true;
    island.dropPin();
    Sound.play("approval");
    // The same amber state an OpenCode permission uses. Without it the card
    // arrives with the bot still looking idle, which reads as "nothing is
    // happening" at exactly the moment something is waiting on a person.
    State.updateTask(CLAUDE_ID, "approval");
    // An approval blocks the agent until somebody answers, so it takes the view
    // the way an OpenCode permission does.
    island.alert("approval");
  });
  void onEvent<boolean>("mcp-answer", () => {
    State.setMcpAsk(null);
    releaseMcpPin(island);
  });

  // One shot at boot: the switch may have been on before the webview reloaded.
  void Bridge.mcpStatus().then((status) => {
    if (status) State.setMcp(status);
  });
  void Bridge.mcpKillHotkeyAvailable().then((free) => {
    if (free != null) State.mcpHotkeyFree = free;
  });
}

function releaseMcpPin(island: Island) {
  if (State.pendingApproval) return; // an OpenCode card still needs the pin
  // The amber state belongs to the card that just came down. Only clear it when
  // nothing else is waiting, or the bot goes idle with a queue still open.
  if (!State.approvalsWaiting) State.updateTask(CLAUDE_ID, "working");
  State.isPinned = false;
  island.dropPin();
  if (State.view === "approval") island.setView(State.defaultView());
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  if (payload.hook_event_name === "SessionEnd") {
    // The agent went away with cards still up. Hand every one of them back,
    // otherwise the badge would keep claiming work nobody can reach.
    for (const a of State.approvalQueue) void Bridge.approvalDecline(a.requestId);
    if (State.pendingApproval) void Bridge.approvalDecline(State.pendingApproval.requestId);
    State.approvalQueue = [];
    clearApprovalTimer();
    State.pendingApproval = null;
    State.isPinned = false;
    island.dropPin();
    State.setPillBadge(CLAUDE_ID, null);
    if (State.view === "approval") island.setView(State.defaultView());
    State.notify();
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const focused = State.focusId === CLAUDE_ID;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      upsert(projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(CLAUDE_ID, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(CLAUDE_ID, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(CLAUDE_ID, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(CLAUDE_ID, "working");
      State.appendStep(CLAUDE_ID, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(CLAUDE_ID, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(CLAUDE_ID, "finished");
      if (payload.message) State.appendStep(CLAUDE_ID, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(CLAUDE_ID, "finished");
      window.setTimeout(() => {
        State.updateTask(CLAUDE_ID, "idle");
        State.setPillBadge(CLAUDE_ID, null);
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(CLAUDE_ID, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(CLAUDE_ID, "error");
      break;

    case "SessionEnd":
      State.updateTask(CLAUDE_ID, "idle");
      clearSession();
      break;

    case "SubagentStart":
      State.appendStep(CLAUDE_ID, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(CLAUDE_ID, "• subagent done");
      break;

    case "PermissionReplied": {
      // Answered in OpenCode itself: take the card down.
      const rid = payload.request_id ?? "";
      if (!rid) break;
      const wasQueued = State.approvalQueue.some((q) => q.requestId === rid);
      if (!wasQueued && State.pendingApproval?.requestId !== rid) break;

      State.dropApproval(rid);
      if (wasQueued) break;

      clearApprovalTimer();
      // Something else was waiting behind this one: put it up rather than
      // closing the panel and hiding that a decision is still outstanding.
      const next = State.advanceApproval();
      if (next) {
        armApprovalTimer(island);
        State.updateTask(CLAUDE_ID, "approval");
        State.isPinned = true;
        island.dropPin();
        island.alert("approval");
        break;
      }
      State.isPinned = false;
      island.dropPin();
      State.updateTask(CLAUDE_ID, "working");
      State.setPillBadge(CLAUDE_ID, null);
      if (State.view === "approval") island.setView(State.defaultView());
      break;
    }

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      if (!requestId) break;
      upsert(projectName, cwd);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      // A card has to say *which* work is asking. OpenCode's permission event
      // carries no title, so the task behind the session id supplies it — without
      // this the user is looking at "bash" and has no idea which folder is about
      // to run it.
      const task = State.taskForSession(payload.session_id ?? "");
      const info: ApprovalInfo = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        directory: task?.directory ?? cwd ?? null,
        taskTitle: task?.title ?? null,
      };

      // Rust already raised the toast and set the tray count for this one. The
      // card is what it cannot do: a decision needs a human at the island.
      const onCard = State.pushApproval(info);

      if (!onCard) {
        // Waiting its turn. No view change, no extra sound: the badge already
        // counts it, and Rust already rang for it.
        break;
      }

      armApprovalTimer(island);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      break;
    }

    default:
      break;
  }
  State.notify();
}
