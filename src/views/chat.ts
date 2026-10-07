// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type ChatContext, type AgentInfo } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { IslandViewName } from "../core/layout";
import type { ViewHost } from "./views";

let nextId = 1;

/**
 * How long a turn may go without a single word before it is declared dead.
 *
 * `chatPending` is cleared by the `chat-done` and `chat-error` events, so a stream
 * that simply stops — the server restarted, the SSE connection dropped, the model
 * died mid-answer — leaves it set forever. Nothing else clears it: the request
 * itself already resolved successfully, which is the whole point of streaming, and
 * `submit`'s `catch` never runs. The visible result is a room that will not accept
 * another question and a character that thinks for the rest of the session, and the
 * only way out is quitting the app.
 *
 * This is an idle timeout rather than a total one: a turn that keeps producing text
 * for minutes is fine, and re-arming on every delta is what makes that true.
 *
 * Two windows, because the two waits are not the same. Nothing at all has come back
 * yet when a cold model is still loading, which is slower than any gap between
 * tokens it goes on to produce — so the first word gets the longer of the two.
 */
const TURN_FIRST_WORD_MS = 90_000;
const TURN_IDLE_MS = 45_000;

let turnWatchdog: number | null = null;

/**
 * Ends the open turn if nothing arrives for `TURN_IDLE_MS`.
 *
 * A reply with words in it is left alone and simply stops: it is the truth of what
 * came back, and replacing it with an error would throw away an answer the person
 * was reading. Only an *empty* one is popped, and only then is there something to
 * say instead.
 */
function watchTurn(ms = TURN_IDLE_MS) {
  if (turnWatchdog != null) window.clearTimeout(turnWatchdog);
  turnWatchdog = window.setTimeout(() => {
    turnWatchdog = null;
    const reply = openReply();
    if (!State.chatPending) return;
    State.chatPending = false;
    State.stateOverride = null;
    if (reply && !reply.content.trim()) {
      State.chatHistory.pop();
      State.noteMessage = "The reply stopped arriving.";
      // Only pull the island to the note if the room is what is on screen. Yanking
      // someone out of the overview because a turn they walked away from died is
      // worse than the dead turn.
      if (State.view === "prompt") State.view = "note";
      Sound.play("error");
    }
    State.notify();
  }, ms);
}

function stopWatching() {
  if (turnWatchdog != null) {
    window.clearTimeout(turnWatchdog);
    turnWatchdog = null;
  }
}

/** The assistant message currently being written into, if a turn is open. */
function openReply(): ChatMessage | null {
  if (!State.chatPending) return null;
  const last = State.chatHistory[State.chatHistory.length - 1];
  return last && last.role === "assistant" ? last : null;
}

/**
 * The reply, arriving.
 *
 * `chat-text` always carries the whole answer so far rather than a fragment, so
 * writing it over the bubble is the update — nothing to stitch together here.
 * Rust sends it from the same SSE stream every task event uses, which is what
 * replaced the one blocking request this room used to wait on.
 */
export function registerChatStream() {
  void onEvent<{ text: string }>("chat-text", ({ text }) => {
    const reply = openReply();
    if (!reply) return;
    reply.content = text;
    // Re-armed on every fragment, so the watchdog measures silence rather than
    // length: a long answer is not a stuck one.
    watchTurn();
    // `stateOverride` stays "thinking" for the whole turn so the character keeps
    // looking like it is working; the dots are the view's business, not this one's.
    State.notify();
  });

  void onEvent<null>("chat-done", () => {
    const reply = openReply();
    stopWatching();
    State.chatPending = false;
    if (State.stateOverride === "thinking") State.stateOverride = null;
    // A turn that ended with nothing to show is a failure the user has to be told
    // about, not an empty bubble they have to notice themselves.
    if (reply && !reply.content.trim()) {
      State.chatHistory.pop();
      State.noteMessage = "No answer — check the model configured in OpenCode.";
      State.view = "note";
      Sound.play("error");
    } else if (reply) {
      Sound.play("finish");
    }
    State.notify();
  });

  void onEvent<{ message: string }>("chat-error", ({ message }) => {
    const reply = openReply();
    stopWatching();
    State.chatPending = false;
    State.stateOverride = null;
    if (reply && !reply.content.trim()) State.chatHistory.pop();
    State.noteMessage = message;
    State.view = "note";
    Sound.play("error");
    State.notify();
  });
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void, goTo: (v: IslandViewName) => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));

  /**
   * One button, two jobs: send an empty field's worth of nothing, or stop the turn
   * that is running. Swapped rather than added beside, so the bar does not change
   * width under the pointer as the reply arrives.
   */
  let sendIsStop = false;
  function setSendState(pending: boolean) {
    if (pending === sendIsStop) return;
    sendIsStop = pending;
    send.classList.toggle("stop", pending);
    send.title = pending ? "Stop this reply" : "Send";
    clear(send);
    send.append(svg(pending ? ICONS.stop : ICONS.arrowUp, pending ? 10 : 11));
  }

  /**
   * Ends the turn in flight, from the person rather than from the watchdog.
   *
   * Whatever has already arrived stays: it is an answer that was really given, and
   * a stop is not a discard. The watchdog is the backstop for a stream that broke;
   * this is for one that is merely long, or one the person has changed their mind
   * about. Rust is told first — otherwise OpenCode keeps generating into a session
   * nobody is reading.
   */
  async function stopTurn() {
    if (!State.chatPending) return;
    stopWatching();
    State.chatPending = false;
    State.stateOverride = null;
    try {
      await Bridge.chatStop();
    } catch (err) {
      // The turn is over on this side either way, so this is reported, not fatal.
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
    }
    Sound.play("close");
    State.notify();
    onHeightChange();
  }

  // ── task mode ──────────────────────────────────────────────────────────────
  // "Ask" is the existing chat. "Task" is the same box pointed at a real OpenCode
  // session in a folder: the prompt is fired and dropped, and the work happens
  // in its own session so several can run at once.
  const askBtn = h("button", { class: "mode-btn", title: "Ask", text: "Ask" });
  const taskBtn = h("button", { class: "mode-btn", title: "Start a task in a folder", text: "Task" });
  const modes = h("div", { class: "mode-row" }, askBtn, taskBtn);

  const folderName = h("span", { class: "folder-name", text: "No folder chosen" });
  const chooseBtn = h(
    "button",
    { class: "folder-btn", title: "Choose a folder", onclick: () => void chooseFolder() },
    "Choose…",
  );
  const folderRow = h("div", { class: "folder-row" }, folderName, chooseBtn);
  const recents = h("div", { class: "recent-row" });

  // ── the agent picker ────────────────────────────────────────────────────────
  // One list, bound to whichever setting the current mode writes. It used to be two
  // `<select>` elements over one fetch: a closed dropdown of bare names, hidden
  // outright unless the fetch had already succeeded. That hid the problem twice
  // over — no way to see a description, and no way to tell "OpenCode is not
  // answering" from "there is nothing to pick".

  const agentCards = h("div", { class: "agent-cards" });
  const agentLabel = h("span", { class: "recent-label", text: "Agent" });
  const agentBar = h("div", { class: "agent-bar" }, agentLabel, agentCards);

  const agentNote = h("span", { class: "agent-note-text" });
  const agentRetry = h(
    "button",
    { class: "agent-retry", title: "Ask OpenCode again", onclick: () => void loadAgents(true) },
    svg(ICONS.refresh, 9),
    h("span", { text: "Retry" }),
  );
  const agentProblem = h("div", { class: "agent-problem" }, agentNote, agentRetry);

  // The name of whoever is about to answer, next to the field that sends to them.
  // A chip rather than a dropdown because the answer to "who is replying to me" has
  // to be readable without touching anything.
  const agentChip = h("span", { class: "agent-chip" }, h("i", { class: "agent-chip-dot" }), h("span"));
  const chipName = agentChip.lastChild as HTMLElement;
  const bar = h("div", { class: "chat-bar" }, agentChip, input, send);

  const taskPanel = h("div", { class: "task-panel" }, folderRow, recents);

  async function chooseFolder() {
    const picked = await Bridge.pickFolder();
    if (!picked) return;
    State.taskFolder = picked;
    State.notify();
    void refreshFolders();
  }

  async function refreshFolders() {
    const list = (await Bridge.taskFolders()) ?? [];
    State.taskFolders = list;
    State.notify();
  }

  /**
   * The agents a person may pick.
   *
   * `/agent` returns OpenCode's own bookkeeping alongside the real ones, and both
   * kinds have to go: `compaction`, `summary` and `title` come back `hidden`, and
   * `explore` / `general` are `mode: "subagent"` — workers OpenCode invokes through
   * its own Task tool rather than as a session's agent. Verified against 1.18.34,
   * where the hidden three carry no description at all. This is about correctness,
   * not tidiness: `prompt_async` takes any string as `agent`, and a name it cannot
   * use is an error rather than a fallback.
   */
  function choosable(agents: AgentInfo[]): AgentInfo[] {
    return agents.filter((a) => !a.hidden && a.mode !== "subagent");
  }

  /** The setting the current mode writes. The two are stored apart on purpose. */
  function activeSetting(): "chatAgent" | "taskAgent" {
    return State.chatMode === "task" ? "taskAgent" : "chatAgent";
  }

  /**
   * The agent to show as chosen: the last one this person picked, else OpenCode's
   * own default.
   *
   * A stored name that is no longer in the list — the agent was deleted from
   * opencode.json since, or it was one of the internal workers this filter now
   * drops — falls back to the default rather than sending a name the server will
   * reject. The default is `isDefault`, which Rust reads as the head of `/agent`:
   * the server sorts `default_agent` to the front and falls back to `build`.
   */
  function resolveAgent(list: AgentInfo[]): string {
    const setting = activeSetting();
    const stored = State.settings[setting];
    if (stored && list.some((a) => a.name === stored)) return stored;
    const fallback = list.find((a) => a.isDefault)?.name ?? list[0]?.name ?? "";
    State.settings[setting] = fallback;
    return fallback;
  }

  /** One agent's description, cut to something a card can hold on one or two lines. */
  function blurb(text: string): string {
    const first = text.split(/(?<=[.!?])\s/)[0]?.trim() || text.trim();
    return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
  }

  function agentCard(a: AgentInfo, on: boolean): HTMLElement {
    return h(
      "button",
      {
        class: `agent-card${on ? " on" : ""}`,
        title: a.description || a.name,
        onclick: () => {
          State.settings[activeSetting()] = a.name;
          // Saved on the choice, not on a later flush, so the agent is still the
          // one this person picked after a restart.
          void Bridge.saveSettings(State.settings);
          Sound.play("blip");
          State.notify();
        },
      },
      h(
        "span",
        { class: "agent-card-name" },
        a.name,
        a.isDefault ? h("i", { class: "agent-card-def", text: "default" }) : null,
      ),
      h("span", { class: "agent-card-desc", text: blurb(a.description) }),
    );
  }

  /**
   * Draws the list, or the reason there is not one.
   *
   * The failure case used to be silence: the fetch threw, `taskAgents` stayed
   * empty, and the picker hid itself, so an unreachable OpenCode looked exactly
   * like an empty room. Now it says so and offers the one action that can fix it.
   */
  function renderAgents() {
    const list = choosable(State.taskAgents);
    const chosen = resolveAgent(list);
    const key = `${list.map((a) => `${a.name}${a.isDefault ? "*" : ""}`).join("|")}#${chosen}`;
    if (agentCards.dataset.key !== key) {
      agentCards.dataset.key = key;
      clear(agentCards);
      for (const a of list) agentCards.append(agentCard(a, a.name === chosen));
    }

    const setting = activeSetting();
    chipName.textContent = chosen;
    const current = list.find((a) => a.name === chosen);
    agentChip.title = current?.description ? `${chosen} — ${current.description}` : chosen;
    // An empty pill with a glowing dot in it reads as a chip that failed to load.
    // With nothing chosen there is nothing to say, so it goes rather than lying.
    agentChip.style.display = chosen ? "" : "none";

    const failing = State.taskAgentsError !== null;
    const empty = !failing && list.length === 0 && State.taskAgentsLoaded;
    agentProblem.style.display = failing || empty ? "" : "none";
    agentBar.style.display = failing || empty ? "none" : "";
    if (failing) {
      agentNote.textContent = `No connection to OpenCode. ${State.taskAgentsError}`;
    } else if (empty) {
      // Connected, answered, and offered nobody. A different problem from the one
      // above, so it says so rather than borrowing the connection's wording.
      agentNote.textContent = "OpenCode has no agents available.";
    }
    agentRetry.title = `Ask OpenCode again${setting === "chatAgent" ? " (chat)" : " (task)"}`;
  }

  /**
   * One `GET /agent`, shared by both modes.
   *
   * `force` is what the Retry button passes: a failed attempt is cached as
   * "loaded, and it went wrong", so without it a person who fixed OpenCode would
   * still be looking at the failure until they restarted Piko.
   */
  async function loadAgents(force = false) {
    const haveList = State.taskAgents.length > 0;
    if (!force && (haveList || State.taskAgentsLoaded)) {
      renderAgents();
      return;
    }
    State.taskAgentsError = null;
    State.notify();
    try {
      State.taskAgents = await Bridge.taskAgents();
      State.taskAgentsError = null;
    } catch (err) {
      State.taskAgents = [];
      State.taskAgentsError = String(err).replace(/^Error:\s*/, "");
    }
    State.taskAgentsLoaded = true;
    renderAgents();
    State.notify();
    // The list and the problem row both change the room's height.
    onHeightChange();
  }

  function setMode(mode: "ask" | "task") {
    State.chatMode = mode;
    if (mode === "task" && State.taskFolders.length === 0) void refreshFolders();
    void loadAgents();
    State.notify();
    onHeightChange();
  }

  askBtn.addEventListener("click", () => setMode("ask"));
  taskBtn.addEventListener("click", () => setMode("task"));

  async function startTask(prompt: string): Promise<void> {
    const folder = State.taskFolder;
    if (!folder) {
      State.taskError = "Choose a folder first.";
      State.notify();
      return;
    }
    State.taskError = null;
    try {
      await Bridge.taskStart(folder, prompt, State.settings.taskAgent || null, State.taskKind);
      Sound.play("send");
      // Straight back to the overview: the work is now visible there, and the
      // island has no way to show two things at once.
      goTo("overview");
    } catch (err) {
      State.taskError = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
      State.notify();
    }
  }

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash chat-card" },
      // The agent list sits above the log so the reply and whoever produced it are
      // visible together, and the chip beside the input repeats it where the
      // question is actually typed.
      h("div", { class: "chat-body" }, modes, taskPanel, agentBar, agentProblem, chipRow, log, bar),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let renderedCount = -1;
  let renderedMode = "";
  /** The live `.reply` node of the last assistant bubble, written to in place. */
  let liveReply: HTMLElement | null = null;
  let renderedLen = 0;
  /** Set once the room has asked OpenCode for its agents; see `sync`. */
  let agentsRequested = false;

  async function submit() {
    const query = input.value.trim();
    // One turn at a time: both replies land in the same bubble, and the second one
    // would overwrite the first.
    if (!query || State.chatBusy || State.chatPending) return;
    input.value = "";
    State.chatBusy = true;

    if (State.chatMode === "task") {
      await startTask(query);
      State.chatBusy = false;
      onHeightChange();
      return;
    }

    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    // The reply is created empty and filled in as it is written. Waiting for a
    // finished one to push it is what left the room silent through the whole turn.
    State.chatHistory.push({ id: nextId++, role: "assistant", content: "" });
    State.chatPending = true;
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();
    watchTurn(TURN_FIRST_WORD_MS);

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 2 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      await Bridge.chatSend(query, context, State.settings.chatAgent || null);
    } catch (err) {
      stopWatching();
      State.chatPending = false;
      State.stateOverride = null;
      State.chatHistory.pop();
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      // Unlocked as soon as the request is in, not when the answer is: the input
      // belongs to the person, and `chatPending` is what the island watches now.
      State.chatBusy = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => (State.chatPending ? void stopTurn() : void submit()));
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      // Enter follows the button, not the mode it happens to be in: while a turn is
      // open that is Stop. Silently dropping the key would leave the one control
      // that can end a hung turn reachable only by mouse.
      if (State.chatPending) void stopTurn();
      else void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const mode = State.chatMode;
      // The fetch is kicked off from here rather than from a button, because
      // `sync` runs the moment the room is on screen and this used to wait for Ask
      // or Task to be pressed — so the list was still missing the first time anyone
      // looked at it.
      if (!agentsRequested) {
        agentsRequested = true;
        void loadAgents();
      }
      if (mode !== renderedMode) {
        renderedMode = mode;
        askBtn.classList.toggle("on", mode === "ask");
        taskBtn.classList.toggle("on", mode === "task");
        taskPanel.style.display = mode === "task" ? "" : "none";
        log.style.display = mode === "ask" ? "" : "none";
        chipRow.style.display = mode === "ask" ? "" : "none";
        // Rebound: the cards write whichever setting this mode owns, and the chip
        // has to name that one too.
        if (agentCards.dataset.key) {
          agentCards.dataset.key = "";
          renderAgents();
        }
        onHeightChange();
      }

      if (mode === "task") {
        const dir = State.taskFolder ?? "";
        folderName.textContent = dir ? dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir : "No folder chosen";
        folderName.title = dir;
        chooseBtn.textContent = dir ? "Change…" : "Choose…";
        if (State.taskError) {
          folderRow.title = State.taskError;
        } else {
          folderRow.removeAttribute("title");
        }

        // Recent folders as one-tap shortcuts — the five most recent, newest
        // first, so the common case is zero dialogs.
        const recentKey = State.taskFolders.join("|");
        if (recents.dataset.key !== recentKey) {
          recents.dataset.key = recentKey;
          clear(recents);
          for (const dir of State.taskFolders) {
            recents.append(
              h(
                "button",
                {
                  class: "recent-btn",
                  title: dir,
                  text: dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir,
                  onclick: () => {
                    State.taskFolder = dir;
                    State.notify();
                  },
                },
              ),
            );
          }
        }
        input.placeholder = State.taskFolder
          ? "Describe the task…"
          : "Choose a folder to work in";
        input.disabled = State.chatBusy;
        // A task is stopped from its own card, not from here, so the button goes
        // back to sending even if an Ask turn was open when the mode was switched.
        setSendState(false);
        return;
      }

      // Ask mode. The agent that will answer is chosen above and named on the chip.
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      // The dots mean "asked, nothing yet". Once there are words they would be a second
      // thing talking over the answer, so they go on the first of them.
      const last = State.chatHistory[State.chatHistory.length - 1];
      const started = last?.role === "assistant" && last.content.length > 0;
      const typing = State.stateOverride === "thinking" && !started;
      const count = State.chatHistory.length + (typing ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        renderedLen = last?.content.length ?? 0;
        liveReply = null;
        clear(log);
        for (const m of State.chatHistory) {
          const node = bubble(m);
          log.append(node);
          if (m.role === "assistant") liveReply = node.querySelector(".reply");
        }
        if (typing) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      } else if (liveReply && last?.role === "assistant" && last.content.length !== renderedLen) {
        // A delta. The shape of the log has not changed, only the words in the
        // last bubble, so it is written in place — rebuilding the log on every
        // fragment would cost more than the answer itself.
        renderedLen = last.content.length;
        liveReply.textContent = last.content;
        log.scrollTop = log.scrollHeight;
        onHeightChange();
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      // Only the moment of sending disables the field. A reply in flight must not
      // take the keyboard away — the next question can be written while this one is
      // still arriving, and Stop (or Enter) is what ends that turn.
      input.disabled = State.chatBusy;
      setSendState(State.chatPending);
      // Idempotent and keyed on the list itself, so this costs one string compare
      // per frame and keeps the chip correct after a Retry or a new choice.
      renderAgents();
    },
    onLeave() {
      // Come back with nothing to show? Ask again. A list that loaded once is kept,
      // so reopening the room is not a second round trip every time.
      if (State.taskAgentsError) agentsRequested = false;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
