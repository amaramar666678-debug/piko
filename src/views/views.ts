// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import {
  INTEGRATION_AGENTS, MAX_ACTIVE_INTEGRATIONS,
  State, TASK_KINDS, plainName, type AgentTask,
} from "../core/state";
import { Bridge, type OpenTarget } from "../core/bridge";
import * as Connection from "../core/connection";
import { Sound } from "../core/sound";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../piko/minibots";
import { buildPrompt } from "./chat";
import { buildTaskList } from "./tasks";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** Open on `v` and pin the panel, for an alert that must not auto-close. */
  alert(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** The MCP card's buttons. `session` is the "for this session" tick. */
  mcpAnswer(allow: boolean, session: boolean): void;
  /** The island's own "may I switch screen control on?" card, answered. */
  setScreenControl(on: boolean): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** The header is the drag handle; the island owns the arithmetic. */
  startDrag(e: PointerEvent): void;
  /** Double-clicking the header puts the island back in the middle. */
  recenter(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /**
   * Called when the island switches away from this view.
   *
   * `sync` only runs for the view that is on screen, so a view cannot see itself
   * being hidden. The agent picker needs to: without this it is still open the
   * next time the overview appears.
   */
  onLeave?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  // Sizes are named rather than inline literals so the header's proportions can be
  // adjusted in one place. The tabs were 13 and the gear 14, which at the island's
  // real height read as specks; both are a touch larger now, and the chat mark is
  // larger again because it is the one tab a person comes back to.
const TAB_ICON = 19;
const CHAT_ICON = 21;
const ACTION_ICON = 20;

const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, TAB_ICON));
  // The badge is inside the button rather than beside it so the hit area stays one
  // 36px circle; it is `display: none` until a reply actually arrives behind
  // another view, so it costs nothing the rest of the time.
  const chatBadge = h("i", { class: "tab-badge" });
  const tabChat = h(
    "button",
    { class: "tab chat-tab", title: "Ask", onclick: () => go("prompt") },
    svg(ICONS.chatLines, CHAT_ICON, { evenodd: true }),
    chatBadge,
  );
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, TAB_ICON));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.sliders, ACTION_ICON));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, ACTION_ICON));
  // The island no longer hides itself, so the tray is no longer the only way out.
  const quitBtn = h(
    "button",
    { class: "quit", title: "Quit Piko", onclick: () => void Bridge.quit() },
    svg(ICONS.xmark, ACTION_ICON),
  );

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    // Left group: the two things a person sets once and forgets.
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
    // Right group: where the island goes, and then the way out. Quit is last and
    // alone on the edge rather than sitting among the settings, because it is the
    // one destructive mark on the bar.
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, quitBtn),
  );

  // The header moves the island. Buttons keep their own clicks: the handle is the
  // blank part of the bar, not everything inside it.
  //
  // The collapsed bubble has no header — it is a circle with a face in it — so it
  // cannot be the handle there, and dragging it is the only way to move it. The
  // whole body is the handle in compact, which is why the listener is on the
  // island root rather than on the header.
  el.addEventListener("pointerdown", (e) => {
    if ((e.target as Element | null)?.closest("button")) return;
    actions.startDrag(e as PointerEvent);
  });
  el.addEventListener("dblclick", (e) => {
    if ((e.target as Element | null)?.closest("button")) return;
    actions.recenter();
  });

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      // Cleared here rather than on the button, because the room is also reached by
      // dropping a file on the island — a dot that survived that route would point
      // at an answer already on screen.
      if (v === "prompt" && State.chatUnread) State.chatUnread = false;
      tabChat.classList.toggle("unread", State.chatUnread);
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.slidersFill : ICONS.sliders, ACTION_ICON));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, ACTION_ICON));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * "Open in…" — one button for the default, a caret for the rest.
 *
 * What is in the menu is asked of the machine rather than assumed: a target that
 * is not installed is not offered, and a machine with neither editor says so
 * instead of presenting two buttons that cannot work. The folder is the one the
 * task composer is holding, and when there is not one Rust falls back to the last
 * project a task ran in — and refuses rather than opening somewhere hidden, in
 * which case we ask.
 */
function buildOpenIn(onHeightChange: () => void): { el: HTMLElement; sync(): void } {
  const label = h("span", { class: "open-in-label", text: "Open in…" });
  const main = h(
    "button",
    { class: "btn primary open-in-main", title: "Open the project folder" },
    svg(ICONS.arrowUpRight, 10, { stroke: 2.2 }),
    label,
  );
  const caret = h("button", {
    class: "icon-btn open-in-caret",
    title: "Other options",
    "aria-label": "Other options",
  });
  clear(caret);
  caret.append(svg(ICONS.chevronDown, 8));
  const menu = h("div", { class: "open-in-menu" });
  const wrap = h("div", { class: "open-in" }, main, caret, menu);

  let targets: OpenTarget[] = [];
  let loaded = false;
  // The one request, kept so that a click landing while it is still in flight
  // waits for the answer instead of reading an empty list and doing nothing.
  let pending: Promise<void> | null = null;
  let chosen = State.settings.openInDefault;

  /**
   * Asked once, and asked straight away rather than when the caret is first
   * clicked: the button names a target on its face, so a click on it has to do
   * something even when nobody has ever opened the menu.
   */
  const ask = (): Promise<void> => {
    pending ??= (async () => {
      try {
        targets = (await Bridge.openTargets()) ?? [];
        chosen = targets.find((t) => t.id === chosen)?.id ?? targets[0]?.id ?? "";
      } catch {
        targets = [];
      }
      loaded = true;
      State.notify();
      onHeightChange();
    })();
    return pending;
  };

  const say = (why: string) => {
    State.noteMessage = why;
    State.view = "note";
    State.notify();
  };

  /** One launch path for the button and for the menu, so both behave the same. */
  const launch = async (id: string) => {
    try {
      await Bridge.openIn(id, State.taskFolder ?? null);
    } catch (err) {
      const why = String(err).replace(/^Error:\s*/, "");
      // "Nothing has ever run here" is not a failure the user can act on without
      // being asked for a folder, so ask instead of reporting it.
      if (/no folder chosen/i.test(why)) {
        const picked = await Bridge.pickFolder();
        if (!picked) return;
        State.taskFolder = picked;
        State.notify();
        return launch(id);
      }
      say(why);
    }
  };

  main.addEventListener("click", () => {
    void ask().then(() => {
      const target = targets.find((t) => t.id === chosen) ?? targets[0];
      // Nothing installed: the button already says so, so show what it says —
      // the menu carries the install links — rather than swallow the click.
      if (!target) {
        menu.classList.add("on");
        State.notify();
        onHeightChange();
        return;
      }
      void launch(target.id);
    });
  });

  caret.addEventListener("click", () => {
    void ask();
    const opening = !menu.classList.contains("on");
    menu.classList.toggle("on", opening);
    onHeightChange();
  });

  // The menu closes on the island going away, and on Escape with it — a list that
  // outlives the panel would be a list nobody can reach.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("on")) {
      menu.classList.remove("on");
      onHeightChange();
    }
  });

  // The button is not usable until it knows what this machine has, so the asking
  // starts here rather than on a click that is already too late to need it.
  void ask();

  return {
    el: wrap,
    sync() {
      const target = targets.find((t) => t.id === chosen) ?? targets[0];
      if (!loaded) {
        label.textContent = "Open in…";
        return;
      }
      if (targets.length === 0) {
        clear(menu);
        menu.append(
          h("div", { class: "open-in-empty", text: "No editor found" }),
          h("a", {
            class: "open-in-link",
            href: "https://code.visualstudio.com/download",
            text: "Install VS Code",
          }),
          h("a", {
            class: "open-in-link",
            href: "https://opencode.ai",
            text: "Install OpenCode",
          }),
        );
        label.textContent = "Nothing to open with";
        main.classList.add("is-empty");
        return;
      }
      main.classList.remove("is-empty");
      label.textContent = target ? `Open in ${target.label}` : "Open in…";

      const key = `${targets.map((t) => `${t.id}:${t.id === chosen}`).join("|")}:${menu.classList.contains("on")}`;
      if (menu.dataset.key === key) return;
      menu.dataset.key = key;
      clear(menu);
      if (!menu.classList.contains("on")) return;
      for (const t of targets) {
        const row = h(
          "button",
          {
            class: `open-in-item${t.id === chosen ? " on" : ""}`,
            onclick: () => {
              chosen = t.id;
              State.settings.openInDefault = t.id;
              void Bridge.saveSettings(State.settings);
              menu.classList.remove("on");
              onHeightChange();
              State.notify();
            },
          },
          h("span", { text: t.label }),
        );
        menu.append(row);
      }
    },
  };
}

function buildOverview(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const openIn = buildOpenIn(onHeightChange);
  const left = card(null, leftBody, openIn.el);
  // The card is a column so "Open in…" is a row under the integration rather than a
  // badge floating in its corner. Absolute placement is what put it on top of the
  // title, the status line and the button row, and what left the card's own height
  // as the only thing keeping them apart.
  left.classList.add("left-card");
  const pills = h("div", { class: "pills" });
  // The 2×2 grid and the "+" are siblings, not grid items: a fifth child would
  // spill onto a third row and be clipped by the card.
  const pillGrid = h("div", { class: "pill-grid" });
  pills.append(pillGrid, buildNewTaskButton(actions));
  // Real sessions started from the island. Sits under the integration pills so
  // the existing layout is untouched when there are none.
  const tasks = buildTaskList(
    {
      abort: (id) => {
        void Bridge.taskAbort(id).catch((err) => {
          State.noteMessage = String(err).replace(/^Error:\s*/, "");
          State.view = "note";
          State.notify();
        });
      },
      open: (id) => void Bridge.taskOpen(id),
      followup: (id, text) => {
        void Bridge.taskFollowup(id, text).catch((err) => {
          State.noteMessage = String(err).replace(/^Error:\s*/, "");
          State.view = "note";
          State.notify();
        });
      },
      complain: (message) => {
        State.noteMessage = message;
        State.view = "note";
        State.notify();
      },
    },
    onHeightChange,
  );
  const right = card(null, pills, buildMcpIndicator(actions).el, tasks.el);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "OpenCode" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          // `integration_claude` is the carrier for sessions the island did not
          // start. While one is live the ticker above is the honest card; when one
          // is not, there is nothing to describe, so it says so rather than
          // dressing an empty lane up as an integration.
          leftBody.append(
            task.id === "integration_claude"
              ? buildEmpty(actions).el
              : renderIntegrationCard(task, hooks),
          );
        }
      }

      openIn.sync();

      // The VS Code integration is not a pill. It is the internal carrier for
      // activity in sessions the island did not start — approvals, steps, the
      // ticker — and it stays in `State.tasks` for all of that, but a row of
      // pills is where a person looks for things they can open, and this one was
      // never one of them.
      const others = State.otherTasks
        .filter((t) => t.id !== "integration_claude")
        .slice(0, MAX_ACTIVE_INTEGRATIONS);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        // Only the grid is emptied. The "+" beside it is built once and stays put:
        // rebuilding it would let a Rust push that lands between a mouse-down and
        // a mouse-up replace the pressed button and swallow the click.
        clear(pillGrid);
        for (const t of others) pillGrid.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

/**
 * The "+" at the end of the agent row: start a new task.
 *
 * Built once and never rebuilt. The row around it is rebuilt whenever a pill
 * badge changes — which Rust pushes at any moment — and a rebuild between a
 * mouse-down and a mouse-up replaces the pressed button, so the `click` never
 * fires and the press is silently eaten. That is the whole reason this node
 * outlives the pills beside it.
 */
function buildNewTaskButton(actions: ViewActions): HTMLElement {
  const btn = h(
    "button",
    {
      class: "pill add",
      title: "New task",
      "aria-label": "New task",
    },
    svg(ICONS.plus, 13),
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.blip();
    actions.setView("newtask");
  });
  return btn;
}


/** Long-press a pill to take that agent out of the row. */
function wirePillRemoval(pill: HTMLElement, task: AgentTask) {
  let timer: number | null = null;
  const start = () => {
    timer = window.setTimeout(() => {
      timer = null;
      void State.toggleIntegration(task.id);
    }, 550);
  };
  const cancel = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
  };
  pill.addEventListener("pointerdown", start);
  pill.addEventListener("pointerup", cancel);
  pill.addEventListener("pointerleave", cancel);
  pill.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
    void State.toggleIntegration(task.id);
  });
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  // The `piko agent ·` prefix is for the places that name the agent *doing*
  // something. A pill is a name on a shelf: "piko agent · Vercel" there says the row
  // belongs to an agent called Vercel. Same reason the card title drops it.
  const label = task.id === "integration_claude" ? "VS Code" : plainName(task.name);
  // 16, not 24: the slot is the body and the canvas is drawn at bodySize/0.6, so a
  // 24px slot produced a 40px face overflowing a 28px-tall pill by 6px top and
  // bottom. At 16 the face is 26.7px and sits inside the pill's height, which is
  // what lets the label sit beside it in flow instead of across it (see .pill).
  const canvas = createMiniBot(task, 16);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  if (task.id !== "integration_claude") wirePillRemoval(pill, task);
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
btn("Ask OpenCode", "primary", () => actions.setView("prompt")),
  );
  // `empty` is presentation only: it gives the stylesheet a hook for this one
  // screen so the empty state can have its own treatment without every other
  // `.view` inheriting it. Layout, padding and the button are unchanged.
  return { el: h("div", { class: "view empty" }, card(null, body)), sync() {} };
}

// ── New task ───────────────────────────────────────────────────────────────────

/**
 * The screen behind the overview's "+": which agent, and what it should do.
 *
 * The kind is *instruction*, not enforcement. The three options differ in what
 * the agent is told, not in what it is permitted to do — a real read-only mode
 * would have to live in OpenCode's permission layer, and Piko can only answer
 * that one request at a time. Saying so on screen is the point: the word on the
 * button is "Look", not "Read-only".
 */
function buildNewTask(actions: ViewActions): ViewHost {
  const agentRow = h("div", { class: "kind-agents" });
  const kindRow = h("div", { class: "kind-row" });
  const hint = h("div", { class: "sub", style: "margin-top:8px" });

  // Who the island watches. This lives here because it is the only place an agent
  // can be added: the "+" on the overview starts a task, and a row that can only
  // be shrunk is a row nobody can rearrange. `toggleIntegration` also refuses to
  // return a full row, so the note and the disabled rows below are its answer
  // rather than a dead end.
  const rowRow = h("div", { class: "kind-agents" });
  const addRow = h("div", { class: "kind-agents" });

  function renderAgentRow() {
    clear(rowRow);
    clear(addRow);
    const active = State.settings.activeIntegrations;
    const byId = new Map(INTEGRATION_AGENTS.map((t) => [t.id, t]));

    for (const id of active) {
      const t = byId.get(id);
      if (!t) continue;
      const b = h(
        "button",
        { class: "agent-row on", title: `Take ${plainName(t.name)} out of the row` },
        h("i", { style: `background:${t.color}` }),
        h("span", { class: "agent-row-name", text: plainName(t.name) }),
        h("span", { class: "agent-row-x" }, svg(ICONS.xmark, 7, { stroke: 3 })),
      );
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void State.toggleIntegration(id);
      });
      rowRow.append(b);
    }

    const room = MAX_ACTIVE_INTEGRATIONS - active.length;
    if (room <= 0) {
      addRow.append(
        h("div", {
          class: "agent-picker-empty",
          text: `The row holds ${MAX_ACTIVE_INTEGRATIONS}. Take one out to add another.`,
        }),
      );
      return;
    }
    for (const t of INTEGRATION_AGENTS) {
      if (t.id === "integration_claude" || active.includes(t.id)) continue;
      const b = h(
        "button",
        { class: "agent-row", title: `Give ${plainName(t.name)} a slot in the row` },
        h("i", { style: `background:${t.color}66` }),
        h("span", { class: "agent-row-name", text: plainName(t.name) }),
        h("span", { class: "agent-row-add" }, svg(ICONS.plus, 7, { stroke: 2.6 })),
      );
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const added = await State.toggleIntegration(t.id);
        if (!added) {
          State.noteMessage = `The row already holds ${MAX_ACTIVE_INTEGRATIONS} agents. Remove one to make room.`;
          State.view = "note";
        }
        State.notify();
      });
      addRow.append(b);
    }
  }
  renderAgentRow();

  const kindBlurbs = new Map<string, string>();
  for (const k of TASK_KINDS) {
    const b = h(
      "button",
      { class: "kind-btn", title: k.blurb },
      h("span", { class: "kind-label", text: k.label }),
    );
    b.dataset.kind = k.id;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      State.taskKind = k.id;
      State.notify();
    });
    kindBlurbs.set(k.id, k.blurb);
    kindRow.append(b);
  }

  function agentButtons(): HTMLElement[] {
    const list = State.taskAgents;
    const fallback = list.find((a) => a.isDefault)?.name ?? "";
    const chosen = State.settings.taskAgent || fallback;
    return list.map((a) => {
      const b = h(
        "button",
        { class: "agent-row", title: a.description || a.name },
        h("span", { text: a.name }),
      );
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        State.settings.taskAgent = a.name;
        State.notify();
      });
      b.dataset.agent = a.name;
      b.dataset.chosen = String(a.name === chosen);
      return b;
    });
  }

  async function loadAgents() {
    if (State.taskAgents.length) return;
    try {
      State.taskAgents = await Bridge.taskAgents();
      State.notify();
    } catch {
      // Nothing reachable: the screen still works, it just offers the server
      // default and says so rather than pretending there is a list.
      State.taskAgents = [];
    }
  }
  void loadAgents();

  // The way back, at the top rather than only in the button row at the bottom:
  // this screen grows with the number of agents the server offers, and the bottom
  // row is the first thing the frame clips when it does.
  const back = h(
    "button",
    { class: "card-back", title: "Back", "aria-label": "Back" },
    svg(ICONS.chevronLeft, 9, { stroke: 2.4 }),
    h("span", { text: "Back" }),
  );
  back.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.blip();
    actions.setView(State.defaultView());
  });

  const body = h(
    // `sticky-top` rather than `auto`: the screen scrolls, and auto-centring a
    // scrolled column puts its own top out of reach — which put the Back pill on
    // the "In the row" label and the "Do" section below the frame.
    "div",
    { class: "stack sticky-top", style: "padding:6px 18px 0 118px" },
    back,
    h("div", { class: "title", text: "New task" }),
    h("div", { class: "sub", text: "Who does it, and how far should they go?" }),
    h("div", { class: "recent-label", style: "margin-top:8px", text: "Agent" }),
    agentRow,
    h("div", { class: "recent-label", style: "margin-top:8px", text: "In the row" }),
    rowRow,
    h("div", { class: "recent-label", style: "margin-top:8px", text: "Add" }),
    addRow,
    h("div", { class: "recent-label", style: "margin-top:8px", text: "Do" }),
    kindRow,
    hint,
  );

  // The footer is outside the scroller rather than stuck to the bottom of it: the
  // window is 320 tall and this screen is taller, and Continue is the only way on
  // from here that is not the Back pill, which is at the top and scrolls away first.
  const footer = h(
    "div",
    { class: "card-footer" },
    btn("Cancel", "secondary", () => actions.setView(State.defaultView())),
    btn("Continue", "primary", () => {
      // Hand the choices to the composer rather than duplicating folder and
      // prompt here: that screen already has both, plus the recent folders.
      State.chatMode = "task";
      actions.setView("prompt");
    }),
  );

  const el = h(
    "div",
    { class: "view" },
    card(null, h("div", { class: "card-split" }, h("div", { class: "card-scroll" }, body), footer)),
  );
  // Nothing here presses the window's background: the agent rows and kind buttons
  // fill the card, and a stray press here must not fold the island away.
  el.addEventListener("mousedown", (e) => e.stopPropagation());

  let agentKey = "";
  let rowKey = "";
  return {
    el,
    sync() {
      // `State.taskKind` and `taskAgent` are plain fields, so the only thing that
      // brings this screen back is a notify from the click itself.
      for (const b of kindRow.children) {
        b.classList.toggle("on", (b as HTMLElement).dataset.kind === State.taskKind);
      }
      hint.textContent = kindBlurbs.get(State.taskKind) ?? "";

      // Adding or taking out an agent changes which chips belong in each row, and
      // the click that did it is the only thing that brings this screen back.
      const nextRowKey = State.settings.activeIntegrations.join(",");
      if (nextRowKey !== rowKey) {
        rowKey = nextRowKey;
        renderAgentRow();
      }

      const key = State.taskAgents.map((a) => a.name).join("|") + `#${State.settings.taskAgent}`;
      if (key !== agentKey) {
        agentKey = key;
        clear(agentRow);
        const list = agentButtons();
        if (list.length) {
          agentRow.append(...list);
        } else {
          agentRow.append(h("div", { class: "agent-picker-empty", text: "No server reachable." }));
        }
      }
    },
    onLeave() {
      void Bridge.saveSettings(State.settings);
    },
  };
}

// ── MCP indicator ──────────────────────────────────────────────────────────────

/**
 * The always-there answer to "can an agent move my mouse right now?".
 *
 * It is a *view* of `State.mcp`, which Rust owns. The island has no opinion of
 * its own and no local copy that could drift: if this says off, it is off, even
 * if some other part of the webview thought otherwise. Hidden entirely when
 * input control is off and nothing is waiting, because a permanent grey badge
 * would be noise.
 */
function buildMcpIndicator(actions: ViewActions): ViewHost {
    const el = h("div", { class: "mcp-indicator" });
    let key = "";
    return {
      el,
      sync() {
        const { enabled, awaiting, registered, killHint } = State.mcp;
        // Shown whenever OpenCode actually knows about the server. With nothing
        // registered the row would offer a switch that cannot do anything, so it
        // stays hidden rather than inviting a dead end.
        if (!enabled && !awaiting && !registered) {
          el.style.display = "none";
          key = "";
          return;
        }
        el.style.display = "";
        const label = enabled ? "Screen control on" : "Screen control off";
        // The chord is part of the state: if another app took it, the row says so
        // rather than pretending there is a kill switch.
        const hotkey = State.mcpHotkeyFree
          ? `${killHint} stops it`
          : `${killHint} unavailable`;
        const next = `${label}|${awaiting}|${registered}|${hotkey}`;
        if (next === key) return;
        key = next;
        clear(el);
        el.append(
          dot(enabled ? "#F5A524" : "#6B7280", 6),
          h("span", { class: "mcp-label", text: label }),
          // Without the registration row the toggle does nothing, so say which it
          // is rather than leaving the user to work it out.
          h("span", {
            class: "mcp-note",
            text: registered ? hotkey : "not set up in OpenCode",
          }),
          // Off is instant and needs nobody's permission; on goes through a card,
          // because handing an agent the mouse is not a thing a stray click
          // should do on its own.
          btn(
            enabled ? "Stop" : "Turn on",
            "secondary",
            () => {
              actions.blip();
              if (enabled) {
                // Same command the chord runs, so the button and the hotkey cannot
                // mean different things.
                void Bridge.mcpKill().then((status) => {
                  if (status) State.setMcp(status);
                });
              } else {
                State.mcpConfirmEnable = true;
                State.isPinned = true;
                actions.alert("approval");
                State.notify();
              }
            },
          ),
        );
      },
    };
  }

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const from = h("div", { class: "approval-from" });
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const sessionRow = h("label", { class: "mcp-session" });
  const sessionBox = h("input", { type: "checkbox" });
  // "2 more waiting" — the person has to know answering this one is not the
  // whole job, otherwise a queue of three looks like one request and they stop
  // looking after the first Allow.
  const more = h("div", { class: "approval-more" });
  const el = h(
    "div",
    { class: "view" },
    card("amber", stack(116, 16, who, from, code, more, sessionRow, row)),
  );
  let rowKey = "";
  // Local only, and re-read on every sync: Rust decides what a grant is worth,
  // so a tick the server would ignore must not look available.
  let session = false;
  return {
    el,
    sync() {
      clear(who);
      // Before anything an agent asked: the switch itself. Switching control on
      // is the one decision no one has asked for yet, so it gets a card of its
      // own rather than being buried in the settings window.
      if (State.mcpConfirmEnable) {
        who.append(agentWho(State.focusTask, "Let agents control this computer?"));
        from.textContent = "screen control";
        from.style.display = "";
        from.title = "";
        code.textContent =
          "They would be able to move the mouse, click, type and take a picture of " +
          "the screen. Every action still comes to you first. " +
          `${State.mcp.killHint} stops it at any time.`;
        // No tick here on purpose: this is a switch, not a grant, and offering
        // "for the next 10 minutes" would imply it were one.
        sessionRow.style.display = "none";
        if (rowKey !== "enable") {
          rowKey = "enable";
          clear(row);
          row.append(
            btn("Not now", "secondary", () => {
              State.mcpConfirmEnable = false;
              State.notify();
            }),
            btn("Turn on", "primary", () => actions.setScreenControl(true)),
          );
        }
        more.style.display = "none";
        return;
      }
      const ask = State.mcpAsk;
      if (ask) {
        who.append(agentWho(State.focusTask, "OpenCode wants to control your screen"));
        from.textContent = State.mcp.action ?? "screen control";
        from.style.display = "";
        from.title = "";
        // Never the typed text: Rust sends a description like "type 12 chars".
        code.textContent = ask.description;
        sessionBox.checked = session;
        // `type_text` can type a password, so it is never grantable and the tick
        // must not be offered for it.
        const grantable = State.mcp.action !== "type_text";
        sessionRow.style.display = grantable ? "" : "none";
        clear(sessionRow);
        if (grantable) {
          sessionRow.append(
            sessionBox,
            h("span", { text: "Allow this for the next 10 minutes" }),
          );
        }
        if (rowKey !== "mcp") {
          rowKey = "mcp";
          clear(row);
          row.append(
            btn("Deny", "secondary", () => {
              session = false;
              actions.mcpAnswer(false, false);
            }),
            btn("Allow", "primary", () => {
              actions.mcpAnswer(true, session && grantable);
            }),
          );
        }
        // Screen control holds one slot, so there is never a queue behind it.
        more.style.display = "none";
        return;
      }

      const approval = State.pendingApproval;
      who.append(agentWho(State.focusTask, "needs permission"));
      // Which task is asking. "bash" on its own is not a decision anyone can make.
      const folder = approval?.directory
        ? approval.directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? approval.directory
        : "";
      const label = approval?.taskTitle
        ? `${folder ? `${folder} — ` : ""}${approval.taskTitle}`
        : folder;
      from.textContent = label;
      from.style.display = label ? "" : "none";
      from.title = approval?.directory ?? "";
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      sessionRow.style.display = "none";
      // The queue depth. Without it a person who allowed the first of three has
      // no way to know two more are coming, and stops watching.
      const waiting = State.approvalsWaiting;
      more.textContent = waiting > 1 ? `${waiting - 1} more waiting` : "";
      more.style.display = waiting > 1 ? "" : "none";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
        who.append(agentWho(State.focusTask, "OpenCode is asking a question"));
        const task = State.focusTask;
        title.textContent = task?.steps.at(-1) ?? "OpenCode needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Piko can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => void retryStopped()),
    btn("Open in n8n", "secondary", () => void Bridge.openN8n()),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));

  /**
   * Retry, which used to do nothing but navigate back to the overview.
   *
   * The common cause of "Workflow stopped" is that OpenCode was not answering, so
   * the first thing a retry can honestly do is ask whether it is answering now. If
   * it is not, the reason is put on screen where Retry and Start OpenCode both
   * are; if it is, there is nothing to restart from here — the work is gone — so it
   * goes back to the overview rather than pretending a button did something.
   */
  async function retryStopped() {
    const last = State.focusTask?.steps.at(-1) ?? "";
    const health = await Connection.check();
    if (!health?.ok) {
      // Still nothing there. The room is where Retry and Start OpenCode live, and
      // the reason is worth more than this card's, so it goes there rather than
      // leaving a person on an error card whose button has just done nothing.
      Connection.watch(true);
      Sound.play("error");
      actions.setView("prompt");
      return;
    }
    if (Connection.isConnectionFailure(last)) {
      // It was the connection and the connection is fixed; nothing left to report.
      Sound.play("approve");
    }
    actions.setView(State.defaultView());
  }

  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
        who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "OpenCode"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
        who.append(agentWho(State.focusTask, "OpenCode finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

/**
 * A one-line message, with a way back.
 *
 * This used to be a dead end: the message appeared and the only way out was
 * clicking the island's background. Anything that can raise a note — the "+" when
 * the agent row is full, a failed task, a chat error — therefore trapped the user
 * on a card with no button on it.
 */
function buildNote(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const back = btn("Back", "secondary", () => actions.setView(State.defaultView()), "Esc");
  back.classList.add("note-back");
  const el = h(
    "div",
    { class: "view" },
    card(
      null,
      h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title, h("div", { class: "actions" }, back)),
    ),
  );
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const ocBadge = h("span", { class: "status-badge" });
  const keysBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      ocBadge,
      keysBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  // This badge used to read `hooksInstalled`, which the Rust side pins to true
  // because there are no Claude hooks to install any more: labelled "Claude
  // Code", permanently green, describing a binding that does not exist. It now
  // asks the server it is actually bound to, and shows that version.
  let probedAt = 0;
  let probing = false;
  async function probeOpencode() {
    probing = true;
    try {
      const version = await Bridge.opencodeTest();
      clear(ocBadge);
      ocBadge.append(dot("#22C55E", 6), h("span", { text: `OpenCode ${version}` }));
      ocBadge.title = `Connected to OpenCode ${version}`;
    } catch (err) {
      clear(ocBadge);
      ocBadge.append(dot("#F4505E", 6), h("span", { text: "OpenCode" }));
      ocBadge.title = String(err).replace(/^Error:\s*/, "");
    } finally {
      probing = false;
    }
  }
  // Probed off a time check rather than a timer: ViewHost has no teardown, and
  // an interval would outlive the view.
  function maybeProbe() {
    const now = Date.now();
    if (!probing && now - probedAt > 20_000) {
      probedAt = now;
      void probeOpencode();
    }
  }
  ocBadge.append(dot("#8e939c", 6), h("span", { text: "OpenCode" }));
  ocBadge.title = "Asking OpenCode whether it is there…";
  maybeProbe();

  /**
   * "Keys": how many integration API keys are stored.
   *
   * This badge used to be a red dot next to the word "API", hardcoded - the same
   * three characters on every sync, saying nothing. It is now a measurement, and
   * the colour follows what the measurement means rather than what a missing key
   * feels like: an integration with no key is not an error, it is an integration
   * nobody has set up, so nothing stored is grey and never red. Only the *number*
   * is shown; which keys, and what they are, is Rust's business.
   *
   * Cached for a few seconds because the Credential Manager is not free to read and
   * `sync` runs on every state change - which is every cursor-relevant tick while
   * the card is open.
   */
  const KEYS_TTL_MS = 5_000;
  let keysAt = 0;
  let keysCount: number | null = null;
  async function probeKeys() {
    try {
      const n = (await Bridge.secretStoredCount()) ?? 0;
      if (keysCount !== n) {
        keysCount = n;
        clear(keysBadge);
        keysBadge.append(
          dot(n > 0 ? "#22C55E" : "#6B7079", 6),
          h("span", { text: "Keys" }),
        );
      }
      keysBadge.title =
        n === 0
          ? "No API keys stored"
          : `${n} API key${n === 1 ? "" : "s"} stored`;
    } catch {
      // Could not read the Credential Manager. "Keys" with no dot says nothing
      // either way, which is more honest than a dot that means "no".
      if (keysCount !== null) return;
      clear(keysBadge);
      keysBadge.append(h("span", { text: "Keys" }));
      keysBadge.title = "Could not read stored keys";
    } finally {
      keysAt = Date.now();
    }
  }
  function maybeProbeKeys() {
    if (Date.now() - keysAt > KEYS_TTL_MS) void probeKeys();
  }
  keysBadge.append(dot("#6B7079", 6), h("span", { text: "Keys" }));
  keysBadge.title = "Asking the Credential Manager…";
  void probeKeys();

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      // The badges own themselves once they have an answer; re-rendering a
      // placeholder here would wipe a good result on every unrelated sync.
      maybeProbe();
      maybeProbeKeys();
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions, onChatHeightChange));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote(actions));
  map.set("settings", buildSettings(actions));
  map.set("newtask", buildNewTask(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, actions.setView));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // `mail`, `searching` and `result` were registered as placeholders and nothing
  // ever navigated to them — `result` rendered the single word "Result". They are
  // gone from the registry and from `IslandViewName`, so a view that is not built
  // cannot be asked for either.
  return map;
}

