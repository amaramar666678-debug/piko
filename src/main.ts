// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent, type OpenCodeHealth } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { applyEvent as applyConnection, watch as watchConnection } from "./core/connection";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerChatStream } from "./views/chat";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  // A press that landed outside the island. Rust has to report it because the
  // window is click-through out there: the click belongs to whatever is
  // underneath, and the webview would never hear about it.
  await onEvent<null>("outside-press", () => island.outsideClick());

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The reconnect loop's progress. Pushed rather than polled so the island can say
  // what it is waiting for, and so the "connecting" line is the server's own news
  // rather than this side's guess that it is still trying.
  await onEvent<OpenCodeHealth>("opencode-status", (health) => applyConnection(health));

  // The settings window is always-on-top-beneath the island. Rust reports both
  // edges of it, so the panel is not sitting on the settings pane and is not left
  // collapsed once the settings window closes.
  await onEvent<boolean>("settings-open", (open) => {
    if (open) island.hideForSettings();
    else island.restoreAfterSettings();
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerChatStream();
  registerIntegrationHandlers(island);

  // A connection nobody has asked about yet is `unknown`, which is honest: the app
  // has not checked. Asking here would put a "failed" state on screen for every
  // launch on a machine where OpenCode is simply not running until someone opens
  // the room that needs it.
  void watchConnection(false);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
