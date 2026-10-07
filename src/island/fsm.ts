// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "piko";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /**
   * There is no longer a petit → hidden timer. The island used to retract by
   * itself after a minute of not being touched, leaving a 240x6 *transparent*
   * strip with nothing visible to aim at, and people reported the app vanishing
   * when they had never quit it. A compact island is small and always
   * clickable; disappearing is not worth the tidiness. `hidden` is now reached
   * only by Pause in the tray.
   */
  /** piko → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** piko → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /**
   * A reply is on its way, or one is being read. Set from the island rather than
   * from here, and checked when a collapse is both scheduled and fired: a
   * conversation must not shrink out from under the person having it.
   */
  hold = false;

  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  /** Whether a collapse away from `home` or `piko` is currently allowed. */
  private get collapseAllowed(): boolean {
    return !this.pinned && !this.hold;
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("piko");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "piko":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        // Deliberately does nothing. The island stays visible; only Pause or
        // Quit takes it away.
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "piko":
        this.clear("greetCollapse");
        if (this.collapseAllowed) this.transition("petit");
        break;
    }
  }

  /**
   * Whether a conversation or a reply is on screen, so the island stops
   * collapsing on its own until it ends. Clears a pending collapse that was
   * already armed, which `pinned` never did — it was only consulted when
   * scheduling, so a pin raised mid-countdown still lost the panel.
   */
  setHold(hold: boolean) {
    if (this.hold === hold) return;
    this.hold = hold;
    if (hold) {
      this.clear("homeCollapse");
      this.clear("greetCollapse");
    }
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "piko") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /** Explicit close (OK button, Escape, an alert being answered). */
  forcePetit() {
    this.cancelTimers();
    this.hold = false;
    this.transition("petit");
  }

  /** Tray → Pause, and only that: the island's own idle path never gets here. */
  forceHidden() {
    this.cancelTimers();
    this.hold = false;
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (!this.collapseAllowed) return;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      // Re-checked here, not only when armed: a reply that starts while the
      // countdown is running must cancel it.
      if (this.state === "home" && this.collapseAllowed) this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    if (!this.collapseAllowed) return;
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "piko" && this.collapseAllowed) this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
