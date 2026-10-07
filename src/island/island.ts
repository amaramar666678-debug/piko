// The island: DOM shell, sizing animation, Piko placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  BUBBLE, COMPACT_RADIUS, EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  bubbleOffset, dockOffset, islandSize, normaliseDock,
  type Dock, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { characterById } from "../characters";
import { BotEngine } from "../piko/engine";
import { Greeting, setGreetingCharacter } from "../piko/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../piko/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { rearmApprovalTimer } from "./hooks";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Which view was on screen last sync, so the one we left can be told. */
  private lastView: IslandViewName | null = null;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** True while the island is parked out of the way for the settings window. */
  private settingsOpen = false;
  private fsmBeforeSettings: "hidden" | "petit" | "home" | "piko" = "petit";

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.syncHold();
      this.dirty = true;
      this.ensureRunning();
    });
    this.syncHold();
  }

  /**
   * Holds the island open while a conversation is on screen.
   *
   * Nothing used to stop it collapsing mid-chat: the countdown was armed on mouse
   * leave and fired fifteen seconds later regardless of whether an answer was
   * still being fetched, taking the reply off screen as it arrived. Scoped to
   * Ask mode deliberately — a Task is work in a folder and is fine to fold away.
   * A click on the background or Escape still closes it; that is an explicit
   * dismissal, not a timeout.
   */
  private syncHold() {
    const talking =
      State.view === "prompt" && (State.chatBusy || State.chatHistory.length > 0);
    this.fsm.setHold(talking);
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      alert: (v) => this.alert(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === "integration_claude") void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        // Another request was waiting behind this one: show it rather than
        // closing the panel while a decision is still outstanding.
        if (State.advanceApproval()) {
          rearmApprovalTimer(this);
          State.notify();
          return;
        }
        State.isPinned = false;
        this.fsm.pinned = false;
        State.updateTask("integration_claude", "working");
        State.setPillBadge("integration_claude", null);
        this.setView(State.defaultView());
      },
      mcpAnswer: (allow, session) => {
        const ask = State.mcpAsk;
        if (!ask) return;
        // The card's own id, so a stale click on a replaced card answers nothing.
        // Whether the answer counts is decided by the server, not here.
        void Bridge.log(`mcp ${allow ? "allow" : "deny"} ${ask.action}`);
        Sound.play(allow ? "approve" : "blip");
        void Bridge.mcpAnswer(ask.id, allow, session);
        // Rust's `mcp-status` takes the card down a moment later; clearing here
        // keeps the island from offering a decision that has already been given.
        State.setMcpAsk(null);
        this.setView(State.defaultView());
      },
      setScreenControl: (on) => {
        // Rust owns the switch and reports the truth back, so the island never
        // keeps its own idea of whether an agent can move the mouse.
        State.mcpConfirmEnable = false;
        void Bridge.mcpSetEnabled(on).then((status) => {
          if (status) State.setMcp(status);
        });
        Sound.play(on ? "approve" : "blip");
        this.dropPin();
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => this.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      startDrag: (e) => this.startDrag(e),
      recenter: () => void Bridge.islandRecenter(),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Piko. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "piko") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "piko") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "piko":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
      this.updateWindowCollapsed();
      this.animateGeometry(modeOrder(mode) < modeOrder(prev));
      // Collapsing picks the edge the bubble is nearest to, once the geometry has
      // settled — doing it before would measure the panel's box, not the circle's.
      if (mode === "compact") {
        window.setTimeout(() => this.snapToEdge(), 360);
      }
      State.notify();
    }

    /**
     * Resolves once the island has stopped moving.
     *
     * The geometry is a spring, not a transition, so there is no "done" event to
     * wait for — this polls the tracked values instead. Bounded so a spring that
     * never quite arrives cannot wedge a snap that will never happen.
     */
    private settled(): Promise<void> {
      return new Promise((resolve) => {
        const deadline = performance.now() + 900;
        const stillMoving = () =>
          this.width.animating || this.height.animating || this.radius.animating;
        const tick = () => {
          if (!stillMoving() || performance.now() > deadline) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }

    /**
     * Puts the collapsed bubble against the nearest screen edge and moves the
     * window so it actually lands there.
     *
     * "Nearest" is measured on the bubble's centre against the monitor it is on,
     * which is the only definition that does something sensible when the island
     * has been dragged: drop it near the right and it stays on the right, rather
     * than every collapse marching it back to the middle.
     */
    private async snapToEdge() {
      if (State.mode !== "compact") return;
      // Measured twice, and only the second one counts. The window is moved by
      // Rust and the island is resized by a spring, so a single read taken right
      // after the mode changed is measuring where the window *was*: that is how a
      // bubble that was already at the top edge ended up believing it was nearest
      // the right-hand one and marching across the screen.
      await this.settled();
      const rect = this.islandRect();
      // One round trip answers all of it: where the window is, and how big the
      // display it is on. The webview cannot work the display's scale out for
      // itself, and guessing it here is how a snap lands half a bubble off.
      const geo = await Bridge.islandGeometry();
      if (!geo) return;
      // The compact window *is* the bubble's box, so the bubble's centre is the
      // window's centre. Measuring it from the pushed rect instead would be one
      // more thing that could disagree with where the window actually is.
      const cx = geo.winX + geo.winW / 2;
      const cy = geo.winY + geo.winH / 2;      const toLeft = cx - geo.monX;
      const toRight = geo.monX + geo.monW - cx;
      const toTop = cy - geo.monY;
      const toBottom = geo.monY + geo.monH - cy;
      // Ties go to the edge the island is *already* on, so a bubble sitting dead
      // centre of a wide screen stays where the person put it instead of being
      // yanked sideways by whichever comparison happened to come first.
      const current = normaliseDock(State.settings.dock);
      const edges: Array<[Dock, number]> = [
        ["left", toLeft],
        ["right", toRight],
        ["top", toTop],
        ["bottom", toBottom],
      ];
      const nearest = Math.min(...edges.map(([, d]) => d));
      const tied = edges.filter(([, d]) => Math.abs(d - nearest) < 1);
      const dock: Dock = tied.length === 1 ? tied[0][0] : tied.find(([e]) => e === current)?.[0] ?? tied[0][0];
      if (dock === current) return;
      State.settings.dock = dock;
      void Bridge.islandDock(dock, rect.w);
      void Bridge.saveSettings(State.settings);
      State.notify();
    }


  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /**
   * A press anywhere outside the island — on the desktop, in another app — puts
   * it away. This is the dismissal that works from anywhere, and the one people
   * reach for: clicking the island's own blank space cannot help when the island
   * is not under the cursor.
   *
   * It overrides the chat hold on purpose. "Do not shrink while I am talking"
   * means no *timer* should take the panel away mid-conversation, not that it
   * should be impossible to dismiss. Two exceptions, both cases where the person
   * did not mean to dismiss anything: a card is waiting for an answer, and the
   * island is being dragged.
   */
  outsideClick() {
    if (State.mode !== "expanded") return;
    if (State.isPinned || this.drag) return;
    this.collapse();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /**
   * Opens the settings window with the island out of the way.
   *
   * The island window is `always_on_top` and `WS_EX_TOOLWINDOW`, so it sits above
   * the settings window and its 720×320 black shape covers the settings pane. The
   * settings window is created hidden and hidden again on close (`lib.rs`), never
   * destroyed, so the way back is to watch its visibility rather than to listen
   * for a close event that never comes.
   *
   * Only the FSM state is touched, not `State.isPinned`: an alert waiting for an
   * answer has to still be waiting when the island comes back.
   */
  private openSettingsWindow() {
    void Bridge.openSettingsWindow();
  }

  /**
   * Parks the island while the settings window is up.
   *
   * The island window is `always_on_top` and `WS_EX_TOOLWINDOW`, so it sits above
   * the settings window and its 720×320 black shape covers the settings pane.
   * Rust reports both edges of that (lib.rs `show_settings_window` and its close
   * handler), which is also the path the tray menu takes — the island cannot see
   * that one coming from its own buttons.
   *
   * Only the FSM state is touched, not `State.isPinned`: an alert waiting for an
   * answer has to still be waiting when the island comes back.
   */
  hideForSettings() {
    if (this.settingsOpen) return;
    this.settingsOpen = true;
    // Restored on the way back, so opening settings from the greeting does not
    // silently swap the greeting for the overview.
    this.fsmBeforeSettings = this.fsm.state;
    this.fsm.cancelTimers();
    this.fsm.forcePetit();
  }

  restoreAfterSettings() {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    this.fsm.pinned = State.isPinned;
    // `petit` unless it was open: a `hidden` island (Pause) stays hidden, and
    // bringing it back would undo the pause from the tray.
    if (this.fsmBeforeSettings === "petit" || this.fsmBeforeSettings === "hidden") {
      this.fsm.forcePetit();
    } else {
      this.fsm.forceHome();
    }
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Piko eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Piko has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r =
      State.mode === "expanded"
        ? EXPANDED_CORNER
        : State.mode === "compact"
          ? COMPACT_RADIUS
          : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
      this.islandEl.style.width = `${w}px`;
      this.islandEl.style.height = `${hh}px`;
      // A negative radius means "all the way round", which is the compact island:
      // it is a circle. The expanded one is rounded on every side too — it used to
      // be `0 0 r r`, hanging off the top edge of the screen like a notch, and the
      // two square top corners read as a hard black edge rather than a panel. This
      // line runs every frame, so the stylesheet's value never had a chance to
      // disagree with it.
      this.islandEl.style.borderRadius = r < 0 ? "50%" : `${r}px`;
      // Placed explicitly rather than by `translateX(-50%)`, because where the
      // island sits inside the window is now a decision: the collapsed bubble goes
      // to the screen edge it is docked against.
      const at =
        State.mode === "compact" ? bubbleOffset() : dockOffset(this.dock(), w, hh);
      this.islandEl.style.left = `${at.x}px`;
      this.islandEl.style.top = `${at.y}px`;
      this.islandEl.style.transform = "none";
      // Tells the CSS the whole collapsed shape is a handle.
      this.islandEl.classList.toggle("bubble", State.mode === "compact");
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

const rect = this.islandRect();
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
      // The shape moved and the cursor did not, so no `cursor` event is coming:
      // Rust skips the emit below 1px of movement. Everything `onCursor` derives
      // from "is the pointer inside" — the FSM's idea of hover, the bot's gaze, the
      // drop sequence — would stay frozen at the old shape and read as a cursor
      // glued to the island. Re-run it against the last known position; every
      // branch in there is edge-triggered, so a repeat is a no-op when nothing
      // actually changed.
      this.onCursor(State.mouse.x, State.mouse.y);
    }
  }

    /**
     * The edge the collapsed bubble is docked against. The panel is always
     * "top": a 640×320 card pushed to the side of the screen would be hanging off
     * the edge of the desktop.
     */
    private dock(): Dock {
      return normaliseDock(State.settings.dock);
    }

    /** Island rect in window coordinates (origin top-left of the window). */
    private islandRect(): { x: number; y: number; w: number; h: number } {
      const w = this.width.value;
      const hh = this.height.value;
      if (State.mode === "compact") {
        // The compact window is the bubble's own box, so it sits dead centre in it
        // whatever edge the bubble is docked against — the window is what moved.
        const at = bubbleOffset();
        return { ...at, w, h: hh };
      }
      return { ...dockOffset(this.dock(), w, hh), w, h: hh };
    }


  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setIslandShape("strip");
      }, 420);
      return;
    }
    if (this.collapseTimer != null) return;
    // Two shapes, and the resize happens *before* the island animates into it.
    // A collapsed bubble gets its own 104×104 window: drawn inside the 720-wide
    // panel window it could never be dragged further than the middle third of the
    // screen, because the window itself was clamped there.
    const shape = State.mode === "compact" ? "bubble" : "panel";
    if (this.collapsed) this.collapsed = false;
    void Bridge.setIslandShape(shape);
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A press on the header is the start of a move, not of a dismissal.
      if (this.drag) return;
        if (State.mode !== "expanded") {
          // A press on the bubble might still turn into a hold-and-move, and
          // opening on the press would make that impossible: the panel would be
          // up before the pointer had travelled anywhere. `pointerdown` runs
          // before `mousedown`, so a pending press is already recorded here, and
          // the tap is completed in `onDragEnd` once we know which it was.
          if (this.dragPending) return;
          this.fsm.click();
          return;
        }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
        return;
      }
      // A click on the bare backdrop collapses the island — the usual way out of
      // a panel that opened itself. A click on a card, a button or the header is
      // content, not empty space, and must be left alone; the listener is in the
      // bubble phase so it sees those too.
      if (!State.isPinned && this.isBackgroundClick(e.target)) this.collapse();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    this.wireDrag();

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  /**
   * Dragging the island by its header.
   *
   * Pointer capture rather than a mouse handler: the cursor leaves the header the
   * instant the window moves under it, and losing the stream halfway is what
   * makes a drag feel like it slipped. During a drag the hover logic is silenced
   * — the window sliding under a still cursor fires enter and leave for a place
   * the person never pointed at, which would collapse the island mid-move.
   *
   * The background click that collapses the panel is suppressed for the length of
   * a drag: a press on the header that ends in a move must not also dismiss.
   */
    private drag: { pointerId: number; fromX: number; fromY: number; baseX: number; baseY: number } | null =
      null;
    /**
     * A press on the collapsed bubble that has not decided what it is yet.
     *
     * The bubble is a button and a handle at the same time, and the two gestures
     * are told apart by the press, not by the target: let go without holding and
     * it opens the island; hold it and it becomes a drag. Nothing is committed
     * until one of those two things has happened, so neither is a guess.
     */
    private dragPending: {
      pointerId: number;
      fromX: number;
      fromY: number;
      timer: number;
    } | null = null;
    /** How far a press has to travel before it counts as a drag, in CSS pixels. */
    private static readonly DRAG_SLOP = 6;
    /** How long a press has to last before it means "move me", in ms. */
    private static readonly HOLD_MS = 320;

    startDrag(e: PointerEvent) {
      if (this.drag || this.dragPending) return;
      const pending = {
        pointerId: e.pointerId,
        fromX: e.screenX,
        fromY: e.screenY,
        timer: 0,
      };
      pending.timer = window.setTimeout(() => {
        // Held still long enough: this is a move, not a tap. Say so before the
        // pointer goes anywhere — a handle that only announces itself once it is
        // already sliding across the screen feels broken, not grabbable.
        if (this.dragPending !== pending) return;
        this.dragPending = null;
        this.islandEl.classList.add("grabbed");
        void this.beginDrag(e.pointerId, pending.fromX, pending.fromY);
      }, Island.HOLD_MS);
      this.dragPending = pending;
      void this.beginDrag(e.pointerId, pending.fromX, pending.fromY);
    }

    private async beginDrag(pointerId: number, fromX: number, fromY: number) {
      if (this.drag) return;
      const pos = await Bridge.islandPosition();
      // The press was released while this was in flight.
      if (!pos || this.drag) return;
      if (this.dragPending?.pointerId !== pointerId && !this.islandEl.classList.contains("grabbed")) {
        return;
      }
      this.drag = { pointerId, fromX, fromY, baseX: pos[0], baseY: pos[1] };
    }

    private onDragMove = (e: PointerEvent) => {
      const pending = this.dragPending;
      if (pending && pending.pointerId === e.pointerId) {
        const moved = Math.hypot(e.screenX - pending.fromX, e.screenY - pending.fromY);
        // Sliding before the hold matures still means a move: someone who starts
        // dragging does not mean to wait a third of a second first. The tap is
        // protected by the release, not by this.
        if (moved < Island.DRAG_SLOP) return;
        window.clearTimeout(pending.timer);
        this.dragPending = null;
        this.islandEl.classList.add("grabbed");
        if (!this.drag) return; // the position never arrived; let it go
        this.islandEl.classList.add("dragging");
        // Force the window to keep taking the mouse: the island is about to slide
        // out from under the cursor, and the click-through test is about where it
        // used to be.
        void Bridge.islandDragStart();
      }
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      void Bridge.islandDragTo(d.baseX + (e.screenX - d.fromX), d.baseY + (e.screenY - d.fromY));
    };

    private onDragEnd = (e: PointerEvent) => {
      const pending = this.dragPending;
      if (pending && pending.pointerId === e.pointerId) {
        window.clearTimeout(pending.timer);
        this.dragPending = null;
        // `drag` has to be cleared here too, and this is the load-bearing line of
        // the whole method. `beginDrag` fills it as soon as the window position
        // comes back — a few milliseconds — so by the time an ordinary header click
        // is released it is already set, and the tap branch used to return without
        // touching it. `drag` is the guard at the top of `onCursor`, so one click on
        // the header was enough to freeze every cursor-derived thing in the app for
        // the rest of the session: the gaze, the hover edge, the drop sequence, the
        // auto-close timer. The cursor reads as glued to the island.
        this.drag = null;
        // Released before the hold matured and without moving: a tap. Opening the
        // panel is the whole point of a tap on the bubble, and the mousedown
        // handler deliberately left this to us.
        if (State.mode !== "expanded") this.fsm.click();
        return;
      }
      const grabbed = this.islandEl.classList.contains("grabbed");
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) {
        this.islandEl.classList.remove("grabbed");
        return;
      }
      this.drag = null;
      this.islandEl.classList.remove("dragging", "grabbed");
      void Bridge.islandDragEnd();
      if (!grabbed) return;
      // Dropped somewhere: take the edge it is nearest to, so the bubble lands
      // against a side rather than wherever it was let go.
      window.setTimeout(() => void this.snapToEdge(), 80);
    };


  private wireDrag() {
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragEnd);
    // The last resort for a drag whose release never arrives: a pointerup that
    // lands while the webview has lost focus is never delivered, and a `drag` left
    // set is a `drag` that silences the cursor for good (see `onDragEnd`). Rust is
    // told too, or its click-through flag stays latched the same way.
    window.addEventListener("blur", () => {
      if (!this.drag && !this.dragPending) return;
      if (this.dragPending) window.clearTimeout(this.dragPending.timer);
      this.dragPending = null;
      this.drag = null;
      this.islandEl.classList.remove("dragging", "grabbed");
      void Bridge.islandDragEnd();
      this.onCursor(State.mouse.x, State.mouse.y);
    });
    // The collapsed bubble is a circle with a face in it and no header, so the
    // header handle cannot reach it — the whole shape is the handle. Only in
    // compact: an expanded panel's blank space is the thing that folds it away,
    // and turning that into a drag would make the panel nearly impossible to
    // dismiss by clicking where the dismissal is.
    this.islandEl.addEventListener("pointerdown", (e) => {
      if (State.mode !== "compact") return;
      if ((e.target as Element | null)?.closest("button")) return;
      this.startDrag(e);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // Where the cursor *is* is recorded even mid-drag: that stays true while the
    // window slides. Only the enter/leave bookkeeping below is silenced, because a
    // window moving under a still cursor reports enter and leave for places the
    // person never pointed at. Recording it unconditionally also means a drag that
    // somehow outlives its release can no longer freeze the gaze as well.
    State.mouse = { x, y };
    if (this.drag) {
      this.ensureRunning();
      return;
    }
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "piko") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /**
   * True when a mousedown landed on the island's own background rather than on
   * something the user can interact with.
   *
   * The obvious check — "was the target `#content`?" — never holds. `.view` is
   * `position: absolute; inset: 0`, so the active view blankets the whole island
   * and every click on empty space targets `.view.overview`, not `#content`. So
   * this walks *out* from the target instead: a click counts as background unless
   * it was on something the user aimed at.
   *
   * The listener that asks this is in the bubble phase, so it also sees clicks on
   * cards, buttons and the header; treating those as background would make every
   * button press double as "dismiss".
   *
   * The chat room is the exception, and it is decided here rather than by listing
   * `.chat-card` as interactive and leaving the rest of the room exposed. That used
   * to mean pressing anywhere in the room that was not a control — the log, the
   * empty space under it, the reply being read — fell through to "background" and
   * folded the panel away, taking the room with it. There is no blank space in the
   * chat view to tell from content: the composer fills the panel, so every press
   * inside it is a press on the conversation.
   *
   * Escape and a press outside the island both still close it, which is what the
   * room is for.
   */
  private isBackgroundClick(target: EventTarget | null): boolean {
    const start = target instanceof Element ? target : null;
    if (!start) return false;
    if (State.view === "prompt") return false;

    const INTERACTIVE =
      ".card:not(.chat-card), button, input, textarea, select, a, .pill, .tab, .task-row, .code, .agent-row, #header, .chip";

    for (let el: Element | null = start; el && el !== this.islandEl; el = el.parentElement) {
      if (el.matches?.(INTERACTIVE)) return false;
      // The view layer itself is the background once its cards have been ruled out.
      if (el.classList?.contains("view")) return true;
    }
    return start === this.islandEl || start === this.contentEl;
  }

private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Piko
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    const showGlow =
      (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) ||
      State.mode === "compact";

    if (showGlow) {
      const d = p.diameter;
      // The character is the resting colour and the state is the news: an idle
      // bubble glows in the character's own hue, and anything worth noticing —
      // working, thinking, an error, somebody waiting on a decision — takes the
      // colour over. Reversing that would mean a bubble at rest is grey, which is
      // the one state it almost never is.
      const stateColor = botGlowColor(State.effectiveState);
      const quiet = State.effectiveState === "idle" || State.effectiveState === "sleeping";
      const character = characterById(State.settings.characterId)?.palette;
      const color = quiet && character ? character.top : stateColor;
      this.botGlow.style.display = "block";
      // The compact bubble is the whole island, so its glow is sized to the bubble
      // rather than to the little bot inside it — the light has to read as the
      // shape's, not as a halo behind something else.
      const span = State.mode === "compact" ? BUBBLE * 1.7 : d * 2.2;
      const inset = span * 0.5;
      this.botGlow.style.width = `${span}px`;
      this.botGlow.style.height = `${span}px`;
      this.botGlow.style.left = `${this.botCx.value - inset}px`;
      this.botGlow.style.top = `${this.botCy.value - inset}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(
        State.mode === "compact"
          ? // More present than in the panel: when the island is only this bubble,
            // the glow is how you find it at all.
            (quiet ? 0.75 : 0.95)
          : botGlowOpacity(State.effectiveState),
      );
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    // The main bot always wears the chosen character. It used to take the focused
    // agent's colour instead, and since the default focus is VS Code — whose
    // colour is `#F5F6F8`, essentially white — the body came out white while the
    // ears stayed the character's colour. `bodyColor` exists for the mini bots
    // and the pills (minibots.ts sets it with `isMini`); `drawBody` returns early
    // on it and skips the palette entirely.
    this.engine.bodyColor = null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    // Only the view on screen gets `sync`, so a view cannot see itself being
    // hidden. Tell the one we just left.
    if (this.lastView !== State.view) {
      if (this.lastView) this.views.get(this.lastView)?.onLeave?.();
      this.lastView = State.view;
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // The mini grid belongs to the panel now. It used to be the compact island's
    // only content, which is why the collapsed state was a 288 px bar rather than
    // a bubble — and a row of agents is not something you can dock to a screen
    // edge. While expanded it is what the overview card draws; the collapsed
    // bubble is the character alone.
    //
    // Also a setting now, and off by default: the card's own pills already list
    // these agents larger, named and clickable, so the grid was a second, worse copy
    // of them sitting in the margin — which is where the chat room's agent list
    // now goes. `settings.miniGrid` brings it back for anyone who wants it.
    const showGrid = State.mode === "expanded" && State.settings.miniGrid;
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Applies settings coming from Rust at boot or from the Settings window. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // Logged because this is the only link in the chain that cannot be seen
    // from outside: a wrong character is otherwise a silent wrong colour.
    void Bridge.log(`character applied: ${State.settings.characterId}`);
    this.engine.setCharacter(State.settings.characterId);
    setGreetingCharacter(State.settings.characterId);
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}

