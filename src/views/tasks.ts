// Task cards — the live view of every OpenCode session Piko started.
//
// Each card is one *real* session on the server, so what is shown here is the
// server's own state: the current step, the agent's todo list, and whether it is
// still running. Nothing here polls — Rust pushes a `task`/`tasks` event whenever
// anything changes, so a card is redrawn only when it would actually look
// different.

import { h, clear, dot, svg } from "./dom";
import { ICONS } from "./icons";
import { State, agentName } from "../core/state";
import { Bridge, type TaskInfo } from "../core/bridge";
import type { ViewHost } from "./views";

export interface TaskHooks {
  abort(id: string): void;
  open(id: string): void;
  followup(id: string, text: string): void;
  /** Where a human-readable problem goes; defaults to the island's notice view. */
  complain?(message: string): void;
}

const STATE_COLORS: Record<string, string> = {
  running: "#6366F1",
  finished: "#22C55E",
  error: "#F4505E",
  aborted: "#8C8C8C",
};

const STATE_LABEL: Record<string, string> = {
  running: "working",
  finished: "done",
  error: "failed",
  aborted: "stopped",
};

/** `C:\Users\me\work\api` → `api`, with the parent kept for the tooltip. */
function folderName(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

function todoLine(t: TaskInfo): HTMLElement | null {
  if (!t.todos.length) return null;
  const done = t.todos.filter((x) => x.status === "completed" || x.status === "cancelled").length;
  // Only the newest two items, so the card cannot grow with the todo list.
  const open = t.todos.filter((x) => x.status !== "completed" && x.status !== "cancelled");
  const items = (open.length ? open : t.todos).slice(0, 2);
  return h(
    "div",
    { class: "task-todos" },
    h("span", { class: "task-todo-count", text: `${done}/${t.todos.length}` }),
    h("span", { class: "task-todo-text", text: items.map((x) => x.content).join(" · ") }),
  );
}

function taskCard(t: TaskInfo, hooks: TaskHooks, key: string): HTMLElement {
  const color = STATE_COLORS[t.state] ?? "#8C8C8C";
  const running = t.state === "running";

  const stop = h(
    "button",
    { class: "task-btn", title: "Stop this task", onclick: () => hooks.abort(t.id) },
    svg(ICONS.xmark, 9, { stroke: 2.4 }),
  );
  const open = h(
    "button",
    {
      class: "task-btn",
      title: "Open in OpenCode",
      onclick: async () => {
        // Rust answers with "" on success and a reason on failure, so there is
        // nothing to guess at here.
        const problem = await Bridge.taskOpen(t.id);
        if (problem) hooks.complain?.(problem);
      },
    },
    svg(ICONS.arrowUpRight, 9, { stroke: 2.4 }),
  );
  const buttons = running ? h("div", { class: "task-btns" }, stop, open) : h("div");

  const follow = h("input", {
    class: "task-followup-input",
    type: "text",
    placeholder: "Reply…",
    spellcheck: "false",
  }) as HTMLInputElement;
  follow.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      const text = follow.value.trim();
      if (text) {
        follow.value = "";
        hooks.followup(t.id, text);
      }
    }
    ke.stopPropagation();
  });
  const followBtn = h(
    "button",
    {
      class: "task-btn",
      title: "Send — continues the same session",
      onclick: () => {
        const text = follow.value.trim();
        if (text) {
          follow.value = "";
          hooks.followup(t.id, text);
        }
      },
    },
    svg(ICONS.arrowUp, 9, { stroke: 2.4 }),
  );
  const composer = running ? null : h("div", { class: "task-followup" }, follow, followBtn);

  const step = running && t.step ? h("div", { class: "task-step", text: t.step }) : null;
  const error = t.error ? h("div", { class: "task-error", text: t.error }) : null;
  const agent = t.agent ? h("span", { class: "task-agent", text: agentName(t.agent) }) : null;

  const dir = h("span", { class: "task-dir", text: folderName(t.directory), title: t.directory });

  return h(
    "div",
    { class: "task-card", "data-key": key },
    h(
      "div",
      { class: "task-head" },
      dot(color, 6),
      h("span", { class: "task-title", text: t.title, title: t.title }),
      h("span", { class: "task-state", text: STATE_LABEL[t.state] ?? t.state, style: `color:${color}` }),
    ),
    h("div", { class: "task-meta" }, dir, agent),
    step,
    todoLine(t),
    error,
    composer,
    buttons,
  );
}

/** Everything Piko has started, running first. Empty string when there is
 *  nothing to show, so the caller can skip the section entirely. */
export function buildTaskList(hooks: TaskHooks, onHeightChange: () => void): ViewHost {
  const el = h("div", { class: "task-list" });
  let renderedKey = "";
  let lastBusy = "";

  return {
    el,
    sync() {
      const tasks = State.sortedTasks;
      const key = tasks
        .map((t) => `${t.id}:${t.state}:${t.step ?? ""}:${t.todos.length}:${t.error ?? ""}`)
        .join("|");
      // Anything the user can act on (a typed reply, a press) may need the layout
      // remeasured, and those moments are exactly when nothing was pushed.
      const busy = `${tasks.some((t) => t.state !== "running")}:${tasks.length}`;
      if (key === renderedKey && busy === lastBusy) return;
      renderedKey = key;
      lastBusy = busy;

      clear(el);
      for (const t of tasks) el.append(taskCard(t, hooks, t.id));
      if (el.childElementCount > 0) onHeightChange();
    },
  };
}