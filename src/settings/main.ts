// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, IS_TAURI, onEvent, type McpRegisterPlan, type McpStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { CHARACTERS, getCharacterSVG, type CharacterId } from "../characters";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

// ── OpenCode section ──────────────────────────────────────────────────────────

const OC_DEFAULT_URL = "http://127.0.0.1:4096";

function opencodeSection(present: Record<string, boolean>): HTMLElement {
  const dot = h("span", { class: "dot" });
  const state = h("div", { class: "hint", text: "" });
  const feedback = h("div", {});

  const mk = (type: string, ph: string) =>
    h("input", {
      type, placeholder: ph, style: "flex:1 1 auto;min-width:0",
      autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
  const url = mk("text", present["opencode-url"] ? "(stored)  e.g. http://127.0.0.1:51131" : OC_DEFAULT_URL);
  const user = mk("text", present["opencode-username"] ? "(stored)" : "opencode");
  const pass = mk("password", present["opencode-password"] ? "••••••••••••  (stored)" : "OPENCODE_SERVER_PASSWORD");

  const note = (ok: boolean, text: string) => {
    clear(feedback);
    feedback.append(h("div", { class: ok ? "notice ok" : "notice err", text }));
    dot.style.background = ok ? "#22c55e" : "#f4505e";
  };

  const saveFields = async () => {
    for (const [key, el] of [["opencode-url", url], ["opencode-username", user], ["opencode-password", pass]] as const) {
      const v = el.value.trim();
      if (v) { await Bridge.secretSet(key, v); el.value = ""; present[key] = true; el.placeholder = "(stored)"; }
    }
  };

  const test = h("button", { class: "primary", text: "Save & test" });
  test.addEventListener("click", async () => {
    try {
      if (!settings.managedServer) await saveFields();
      const version = await Bridge.opencodeTest();
      note(true, `Connected — OpenCode ${version}`);
    } catch (err) {
      note(false, String(err).replace(/^Error:\s*/, ""));
    }
  });

  const detect = h("button", { text: "Auto-detect" });
  detect.addEventListener("click", async () => {
    const found = await Bridge.opencodeDetect();
    if (found) { url.value = found; note(true, `Found a server at ${found}. Press Save & test.`); }
    else note(false, "No running OpenCode server found. Start one with `opencode serve`, or leave this on the managed server.");
  });

  const reset = h("button", { class: "danger", text: "Forget credentials" });
  reset.addEventListener("click", async () => {
    for (const k of ["opencode-url", "opencode-username", "opencode-password"]) {
      await Bridge.secretClear(k); present[k] = false;
    }
    note(true, "Credentials removed.");
  });

  // Managed mode owns the URL, the port and the password, so the boxes that set
  // them have nothing to say while it is on. Hiding them is the honest version of
  // "recommended": there is nothing to fill in.
  const manual = h(
    "div",
    {},
    h("div", { class: "row" }, h("label", { text: "Server URL" }), url, detect),
    h("div", { class: "row" }, h("label", { text: "Username" }), user),
    h("div", { class: "row" }, h("label", { text: "Password" }), pass),
    h("div", { class: "row" }, test, reset),
    feedback,
  );
  const manualHint = h("div", { class: "hint", text:
    "Point Piko at an OpenCode you start yourself. Piko only reads this address — " +
    "it will not start, stop or restart anything." });

  const managedHint = h("div", { class: "hint", text:
    "Piko starts `opencode serve` itself on a free port, with a password it " +
    "generates and keeps in the Windows Credential Manager. Nothing is written " +
    "to disk, and the server is stopped when Piko quits." });

  const applyMode = () => {
    const on = settings.managedServer;
    managedHint.style.display = on ? "block" : "none";
    manualHint.style.display = on ? "none" : "block";
    manual.style.display = on ? "none" : "block";
  };

  const managedSwitch = toggle(settings.managedServer, (on) => {
    settings.managedServer = on;
    void save();
    applyMode();
  });
  applyMode();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "OpenCode" })),
    h("div", { class: "row" },
      h("span", { text: "Use managed server (recommended)" }),
      managedSwitch),
    managedHint,
    manualHint,
    state,
    manual,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Piko — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const agent = h("select", {}) as HTMLSelectElement;
  const agentHint = h("span", { class: "hint", text: "Loading agents…" });
  // The island's task composer has the same list; this is where it is set once
  // and for all, rather than per task. Empty means "let the server decide".
  agent.addEventListener("change", () => {
    settings.taskAgent = agent.value;
    void save();
  });
  void (async () => {
    try {
      const list = (await Bridge.taskAgents()) ?? [];
      agent.replaceChildren(
        h("option", { value: "", text: "Server default" }),
        ...list.map((a) =>
          h("option", { value: a.name, text: a.isDefault ? `${a.name} (default)` : a.name }),
        ),
      );
      agent.value = settings.taskAgent;
      agentHint.textContent = list.length
        ? "Used when a task starts without a choice of its own."
        : "No agents listed — is OpenCode running?";
    } catch {
      agent.replaceChildren(h("option", { value: "", text: "Server default" }));
      agentHint.textContent = "Could not ask OpenCode for its agents.";
    }
  })();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Task agent" }),
      agent,
      agentHint,
    ),
    h("div", { class: "row" },
      h("label", { text: "Corner characters" }),
      toggle(settings.miniGrid, (v) => { settings.miniGrid = v; void save(); }),
      h("span", { class: "hint", text: "a row of tiny agents in the island's corner — the cards already list them" }),
    ),
  );
}

// ── Screen control (MCP) section ───────────────────────────────────────────────

/**
 * Registration and the master switch.
 *
 * The order here is the whole design: register, look at the exact diff, then
 * decide — and only then can the switch be turned on. A person who has not seen
 * the diff has not agreed to anything, so the switch stays disabled until the
 * entry is in the file.
 */
function screenSection(): HTMLElement {
  const state = h("div", { class: "hint", text: "" });
  const feedback = h("div", {});
  const diff = h("pre", { class: "diff" });
  const pathLine = h("div", { class: "hint mono" });
  /**
   * The exe the entry would point at, shown before anything is written.
   *
   * `pathLine` above is the *config* file. This is the other half of the same
   * question - "where will OpenCode go when it wants to call Piko?" - and it is the
   * half that silently breaks: a registration written from a `cargo build` points
   * at `target\debug\piko.exe`, and the next clean deletes it. Nobody notices until
   * OpenCode reports a dead MCP server and the path is no longer on screen.
   */
  const exeLine = h("div", { class: "hint mono" });
  /**
   * The warning, shown whenever the resolved path is a build tree.
   *
   * A warning and not a refusal: refusing would make this app unusable for anyone
   * developing it, which is the person most likely to be reading this diff. It only
   * has to be *seen* — which is what `confirming` forces: the first press arms the
   * button, the second one writes.
   */
  const devWarn = h("div", { class: "notice warn", style: "display:none" });
  let confirming = false;
  const apply = h("button", { text: "Add to OpenCode" });
  const remove = h("button", { text: "Remove" });
  const hotkeyLine = h("div", { class: "hint" });
  const switchEl = toggle(false, () => void setEnabled());

  let plan: McpRegisterPlan | null = null;
  let status: McpStatus | null = null;
  let hotkeyArmed: boolean | null = null;

  const say = (ok: boolean, text: string) => {
    clear(feedback);
    feedback.append(h("div", { class: ok ? "notice ok" : "notice err", text }));
  };

  const render = () => {
    const registered = plan?.alreadyRegistered ?? status?.registered ?? false;
    const enabled = status?.enabled ?? false;
    // Re-read from the command rather than from local state, so what the button
    // does is always visible before it is pressed.
    apply.textContent = registered ? "Update OpenCode" : "Add to OpenCode";
    // A dev-build path takes two presses. The first only arms the button, and says
    // so; nothing is written until the second, so the warning cannot be scrolled
    // past and the button pressed by muscle memory.
    if (plan?.debugBuild) {
      apply.textContent = confirming ? "Click again to register it anyway" : "Register the dev path…";
    }
    apply.disabled = !plan || (registered && plan.diff === "");
    remove.disabled = !registered;
    // A switch that does nothing yet is worse than an absent one.
    switchEl.toggleAttribute("disabled", !registered);
    switchEl.classList.toggle("on", enabled);
    switchEl.setAttribute("aria-pressed", String(enabled));
    clear(state);
    if (registered) {
      state.textContent = "Registered. OpenCode can see Piko's tools once it restarts.";
    } else if (plan) {
      state.textContent = "Not registered. OpenCode cannot call anything yet.";
    } else {
      state.textContent = "Could not read OpenCode's config.";
    }
    clear(pathLine);
    if (plan) pathLine.textContent = plan.path;
    clear(exeLine);
    if (plan?.command?.length) {
      exeLine.textContent = `Will run: ${plan.command.join(" ")}`;
    }
    // Armed state is dropped whenever the plan is re-read: the thing that was
    // confirmed has to be the thing that gets written.
    confirming = false;
    const dev = plan?.debugBuild === true;
    devWarn.style.display = dev ? "" : "none";
    if (dev) {
      clear(devWarn);
      devWarn.append(
        h("span", {
          text:
            "Dev build path: this registration will break after a rebuild. " +
            "OpenCode would be calling a file under target\\ that cargo replaces or " +
            "deletes. Register the installed build instead if this is to last.",
        }),
      );
    }
    clear(hotkeyLine);
    if (hotkeyArmed === false) {
      hotkeyLine.textContent =
        "Ctrl+Alt+Shift+Esc is already taken by another app, so the hotkey kill switch is unavailable. The Stop button on the island still works.";
    } else if (status?.killHint) {
      hotkeyLine.textContent = `Press ${status.killHint} at any time to stop it instantly.`;
    }
  };

  const refresh = async () => {
    try {
      plan = await Bridge.mcpRegisterPlan();
    } catch (err) {
      plan = null;
      say(false, String(err).replace(/^Error:\s*/, ""));
    }
    status = await Bridge.mcpStatus();
    try {
      hotkeyArmed = await Bridge.mcpKillHotkeyAvailable();
    } catch {
      hotkeyArmed = null;
    }
    clear(diff);
    if (plan?.diff) diff.textContent = plan.diff;
    if (plan?.reformats) {
      // Worth saying out loud: the rewrite is not only an addition.
      say(true, "Piko rewrites the file's formatting as well as adding the entry. A backup is written first.");
    }
    render();
  };

  const setEnabled = async () => {
    const next = !(status?.enabled ?? false);
    const updated = await Bridge.mcpSetEnabled(next);
    if (updated) status = updated;
    say(next, next ? "Screen control is on. Every action still asks first." : "Screen control is off.");
    render();
  };

  apply.addEventListener("click", async () => {
    // Two-press gate for a build-tree path. Nothing is read, checked or written on
    // the arming press - it exists so that the write is always a second, deliberate
    // act after the warning has been on screen.
    if (plan?.debugBuild && !confirming) {
      confirming = true;
      render();
      return;
    }
    // The digest being applied is the one that was rendered, not a fresh
    // re-read: a config that changed behind the window's back makes the write
    // fail instead of quietly becoming a diff nobody read.
    const approved = plan?.digest;
    if (!approved) {
      say(false, "OpenCode's config could not be read.");
      return;
    }
    try {
      const backup = await Bridge.mcpRegisterApply(approved);
      say(true, backup
        ? `Added. A copy of the previous file is at ${backup}`
        : "Added to OpenCode.");
    } catch (err) {
      say(false, String(err).replace(/^Error:\s*/, ""));
    }
    await refresh();
  });

  remove.addEventListener("click", async () => {
    try {
      const backup = await Bridge.mcpRegisterRemove();
      say(true, backup
        ? `Removed. The previous file is at ${backup}`
        : "Nothing to remove.");
    } catch (err) {
      say(false, String(err).replace(/^Error:\s*/, ""));
    }
    await refresh();
  });

  const el = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Screen control" })),
    h("div", { class: "hint" },
      "Lets OpenCode read the screen and move the mouse and keyboard. Off by default, " +
      "and every single action still has to be approved on the island before it runs."),
    h("div", { class: "row" },
      h("span", { text: "Allow screen control" }),
      switchEl),
    state,
    hotkeyLine,
    h("div", { class: "row" },
      h("span", { text: "Set up in OpenCode" }),
      apply,
      remove),
    pathLine,
    exeLine,
    devWarn,
    diff,
    feedback,
  );

  void refresh();
  // The island can flip the switch or a hotkey can kill it while this window is
  // open, so the controls follow the server instead of assuming they are right.
  void onEvent<McpStatus>("mcp-status", (s) => {
    status = s;
    render();
  });
  return el;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }

  const keys = [
    "opencode-url", "opencode-username", "opencode-password",
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Piko" }), h("span", { class: "version", text: version })),
    opencodeSection(present),
    characterSection(),
    screenSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
/**
 * The character picker. Hovering a card plays that character's `working` face in
 * the preview strip so the choice can be made without leaving Settings; clicking
 * commits it, and Rust pushes `settings-changed` so the island swaps at once.
 */
function characterSection(): HTMLElement {
  const wrap = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Character" })),
    h("div", { class: "hint", text: "Pick a character. Changes apply immediately." }),
  );

  const strip = h("div", {
    style:
      "display:flex;align-items:center;justify-content:center;gap:8px;height:110px;margin-bottom:12px;background:#f8fafc;border-radius:12px;",
  });
  const big = h("div", { style: "width:100px;height:100px;" });
  strip.append(big);
  // Only shown when the write fails. A silent save failure is the one thing the
  // person cannot debug from what they see.
  const hint = h("div", {
    style: "color:#dc2626;font:500 11px var(--font);margin-bottom:8px;display:none;",
  });

  const grid = h("div", { style: "display:flex;flex-wrap:wrap;gap:10px;" });
  const cards = new Map<CharacterId, HTMLElement>();

  const paint = (id: CharacterId) => {
    big.innerHTML = getCharacterSVG(id, "idle", 100);
  };

  const markSelected = () => {
    for (const [id, card] of cards) {
      const on = settings.characterId === id;
      card.style.border = `2px solid ${on ? "#3b82f6" : "#e5e7eb"}`;
      card.setAttribute("aria-pressed", String(on));
    }
  };

  for (const c of CHARACTERS) {
    const card = h(
      "div",
      {
        role: "button",
        tabindex: "0",
        "aria-pressed": "false",
        style:
          "border:2px solid #e5e7eb;border-radius:10px;padding:8px;width:90px;text-align:center;cursor:pointer;",
      },
      // `html`, not `innerHTML`: `h` maps that key to the property. Passing
      // `innerHTML` falls through to setAttribute, which silently does nothing
      // and leaves an empty box where the character should be.
      h("div", { html: getCharacterSVG(c.id, "idle", 70) }),
      h("div", { style: "font-size:12px;margin-top:4px;", text: c.label }),
    );

    card.addEventListener("mouseenter", () => paint(c.id));
    card.addEventListener("focus", () => paint(c.id));
    card.addEventListener("click", async () => {
      settings.characterId = c.id;
      markSelected();
      paint(c.id);
      // `saveSettings` reports whether Rust wrote the file. Before this it
      // returned `undefined` on success, and `undefined == null` made every
      // successful save report itself as a failure.
      void Bridge.log(`character → ${c.id}`);
      const saved = await Bridge.saveSettings(settings);
      if (!saved && IS_TAURI) {
        hint.textContent = `Couldn't save — ${c.label} was not kept.`;
        hint.style.display = "";
      } else {
        hint.style.display = "none";
      }
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.click();
      }
    });

    cards.set(c.id, card);
    grid.append(card);
  }

  // Hovering back out returns the strip to whatever is actually selected.
  grid.addEventListener("mouseleave", () => paint(settings.characterId));

  markSelected();
  paint(settings.characterId);
  wrap.append(strip, hint, grid);
  return wrap;
}


