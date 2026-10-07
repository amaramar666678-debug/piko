// Proves that the agent picked in the island is the agent that leaves it.
//
// The question this exists to answer is not "does OpenCode honour `agent`" — that
// is the server's half and `src-tauri/src/opencode.rs` covers it. It is whether the
// name the person tapped in the room survives the trip out of the front end and
// into the `chat_send` payload. That hop is pure DOM and state, has no test
// framework around it, and used to be wrong in the quietest possible way: the
// picker was hidden, so nothing was ever picked and `agent` was always null.
//
// So this drives the real page — the actual view code, the actual state, the actual
// click and key handlers — in headless Chrome, with only the Tauri IPC replaced by
// a recorder. Nothing is imported or re-implemented: if `chat.ts` stops passing the
// chosen name, this fails.
//
// No test framework: Chrome and node's built-in WebSocket are enough, the same
// pair scripts/shot.mjs already uses.
//
//   node scripts/agent-routing.mjs            (starts and stops its own vite server)
//   node scripts/agent-routing.mjs --url URL  (use a dev server you already run)

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9500 + Math.floor(Math.random() * 300);
const PROFILE = mkdtempSync(join(tmpdir(), "piko-agent-test-"));

/** `/agent` as 1.18.34 answers it: three internal workers and two subagents in it. */
const AGENTS = [
  { name: "build", description: "The default agent. Executes tools based on configured permissions.", mode: "primary", hidden: false, isDefault: true },
  { name: "compaction", description: null, mode: "primary", hidden: true, isDefault: false },
  { name: "explore", description: "Fast agent specialized for exploring codebases.", mode: "subagent", hidden: false, isDefault: false },
  { name: "general", description: "General-purpose agent for researching complex questions.", mode: "subagent", hidden: false, isDefault: false },
  { name: "plan", description: "Plan mode. Disallows all edit tools.", mode: "primary", hidden: false, isDefault: false },
  { name: "summary", description: null, mode: "primary", hidden: true, isDefault: false },
  { name: "title", description: null, mode: "primary", hidden: true, isDefault: false },
];

const SETTINGS = {
  soundEnabled: false,
  soundVolume: 0,
  autoCloseInterval: 600,
  absenceInterval: 180,
  activeIntegrations: [],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "opencode",
  inputControlEnabled: false,
  miniGrid: false,
  // Deliberately empty: "no choice made yet" is the case where the island has to
  // fall back to OpenCode's own default rather than to nothing.
  taskAgent: "",
  chatAgent: "",
  managedServer: true,
  characterId: "robot",
  islandOffsetX: 0,
  islandOffsetY: 0,
  dock: "top",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── harness ────────────────────────────────────────────────────────────────────

let vite = null;
let chrome = null;

async function startVite() {
  vite = spawn(
    process.execPath,
    [join(import.meta.dirname, "..", "node_modules", "vite", "bin", "vite.js"),
     "--port", String(PORT + 1), "--strictPort"],
    { cwd: join(import.meta.dirname, ".."), stdio: "ignore", shell: false },
  );
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/`, { method: "HEAD" });
      if (r.ok || r.status === 404) return `http://127.0.0.1:${PORT + 1}`;
    } catch { /* not listening yet */ }
    await sleep(300);
  }
  throw new Error("vite never came up");
}

async function targets() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("devtools never came up");
}

let nextId = 1;
function rpc(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * The recorder. It stands in for the Tauri command layer and for nothing else:
 * every call the page makes goes through it, so `window.__calls` is the request
 * bodies as the front end actually built them.
 */
const RECORDER = `
  const AGENTS = ${JSON.stringify(AGENTS)};
  const SETTINGS = ${JSON.stringify(SETTINGS)};
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      window.__calls.push({ cmd, args: args === undefined ? null : args });
      switch (cmd) {
        case "boot":
          return Promise.resolve({
            settings: SETTINGS,
            screen: { x: 0, y: 0, width: 2560, height: 1440, scale: 1 },
            version: "0.1.1", hookPath: "",
          });
        case "task_agents": return Promise.resolve(AGENTS);
        case "task_list": return Promise.resolve([]);
        case "task_folders": return Promise.resolve([]);
        case "mcp_status": return Promise.resolve({
          enabled: false, registered: false, awaiting: false, action: null,
          description: null, killHint: "Ctrl+Alt+Shift+Esc", remainingThisSec: 5,
        });
        case "island_geometry": return Promise.resolve(
          { winX: 0, winY: 0, winW: 640, winH: 300, monX: 0, monY: 0, monW: 2560, monH: 1440 });
        // chat_send resolves, and no chat-done follows: a hung turn. Nothing in
        // this test waits for a reply, and leaving the turn open keeps the second
        // send from being blocked by chatPending.
        default: return Promise.resolve(null);
      }
    },
    transformCallback: (cb) => { const id = Math.random(); window[id] = cb; return id; },
    metadata: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
`;

// ── assertions ─────────────────────────────────────────────────────────────────

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log(`       ${detail}`);
    failures.push(name);
  }
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── the run ────────────────────────────────────────────────────────────────────

try {
  const url = process.argv.includes("--url")
    ? process.argv[process.argv.indexOf("--url") + 1]
    : await startVite();
  console.log(`page: ${url}`);

  chrome = spawn(
    CHROME,
    [
      "--headless=new", "--disable-gpu", "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--window-size=760,420", "about:blank",
    ],
    { stdio: "ignore" },
  );

  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });

  await rpc(ws, "Page.enable");
  await rpc(ws, "Runtime.enable");
  await rpc(ws, "Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
  await rpc(ws, "Page.navigate", { url });
  await sleep(5000);

  const evalJs = async (expression) => {
    const r = await rpc(ws, "Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    }
    return r.result?.value;
  };

  // Open the panel and hold it open: headless never moves the pointer, so the
  // island folds straight back up on its auto-close timer.
  await evalJs(`(() => {
    const el = document.getElementById("island");
    const o = {bubbles:true,cancelable:true,pointerId:1,isPrimary:true,
               clientX:380,clientY:20,screenX:380,screenY:20};
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    clearInterval(window.__hold);
    window.__hold = setInterval(() => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("mousemove", {bubbles:true,
        clientX:r.left + r.width/2, clientY:r.top + Math.min(20, r.height/2)}));
    }, 80);
    return true;
  })()`);
  await sleep(2200);

  await evalJs(`(() => {
    const b = [...document.querySelectorAll("button")]
      .find(n => (n.getAttribute("title") || "").toLowerCase() === "ask");
    b.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
    return true;
  })()`);
  await sleep(1800);

  console.log("\nwhat the room offers");
  const offered = await evalJs(`
    [...document.querySelectorAll(".agent-card")].map(c => ({
      name: c.querySelector(".agent-card-name").firstChild.textContent.trim(),
      on: c.classList.contains("on"),
    }))`);
  equal("only OpenCode's non-hidden, non-subagent agents are offered",
    offered.map((o) => o.name), ["build", "plan"]);
  equal("the default is OpenCode's own default, not merely the first card",
    offered.find((o) => o.on)?.name, "build");

  const send = async (text) => {
    await evalJs(`(() => {
      const i = document.querySelector(".chat-input");
      i.focus();
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true, cancelable:true}));
      return true;
    })()`);
    await sleep(700);
  };

  /**
   * Ends the turn the last send opened, through the button a person would press.
   *
   * The recorder answers `chat_send` and never sends `chat-done`, so the room is
   * left believing an answer is still arriving — which is true of a hung turn and
   * is exactly what the Stop button exists for. Without this the second Enter is
   * refused, and the test would be measuring its own stub.
   */
  const stopPendingTurn = async () => {
    await evalJs(`(() => {
      const b = document.querySelector(".send-btn");
      if (!b || !b.classList.contains("stop")) return false;
      b.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
      return true;
    })()`);
    await sleep(400);
  };

  const callsOf = (cmd) => evalJs(`
    window.__calls.filter(c => c.cmd === ${JSON.stringify(cmd)}).map(c => c.args)`);

  const clearCalls = () => evalJs(`(() => { window.__calls.length = 0; return true; })()`);

  console.log("\nwith nothing chosen yet");
  await clearCalls();
  await send("first question");
  let sent = await callsOf("chat_send");
  equal("one chat_send per Enter", sent.length, 1);
  equal("the query is the text that was typed", sent[0]?.query, "first question");
  check("the default agent is sent, not null",
    sent[0]?.agent === "build",
    `agent was ${JSON.stringify(sent[0]?.agent)}, expected "build"`);
  await stopPendingTurn();

  console.log("\nafter choosing plan");
  await clearCalls();
  await evalJs(`(() => {
    const c = [...document.querySelectorAll(".agent-card")]
      .find(n => n.querySelector(".agent-card-name").firstChild.textContent.trim() === "plan");
    c.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
    return true;
  })()`);
  await sleep(700);

  const chip = await evalJs(`document.querySelector(".agent-chip").textContent`);
  equal("the chip names the chosen agent", chip.trim(), "plan");

  // Read before clearing: the save happens on the tap, not on the send.
  const saved = await callsOf("save_settings");
  check("the choice is persisted rather than held in the page",
    saved.length > 0 && saved[saved.length - 1]?.settings?.chatAgent === "plan",
    `save_settings payloads: ${JSON.stringify(saved.map((s) => s?.settings?.chatAgent))}`);

  await clearCalls();
  await send("second question");
  sent = await callsOf("chat_send");
  equal("one chat_send per Enter", sent.length, 1);
  check("the agent that left the room is the one that was tapped",
    sent[0]?.agent === "plan",
    `agent was ${JSON.stringify(sent[0]?.agent)}, expected "plan"`);
  await stopPendingTurn();

  console.log("\nif the stored choice no longer exists");
  // The server is asked again and comes back without plan: an agent deleted from
  // opencode.json between runs. Sending its name is accepted with a 204 and then
  // produces nothing at all, which is the one failure the room cannot show a person.
  await evalJs(`(() => {
    const orig = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "task_agents") {
        window.__calls.push({ cmd, args: args === undefined ? null : args });
        return Promise.resolve(AGENTS.filter(a => a.name !== "plan"));
      }
      return orig(cmd, args);
    };
    const r = document.querySelector(".agent-retry");
    if (!r) return false;
    r.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
    return true;
  })()`);
  await sleep(900);
  await clearCalls();
  await send("third question");
  sent = await callsOf("chat_send");
  check("a name the server no longer has falls back to the default",
    sent[0]?.agent === "build",
    `agent was ${JSON.stringify(sent[0]?.agent)}, expected "build"`);
  const stillShown = await evalJs(`
    [...document.querySelectorAll(".agent-card")].map(c => c.querySelector(".agent-card-name").firstChild.textContent.trim())`);
  equal("and the list drops it rather than offering a name that would vanish",
    stillShown, ["build"]);

  ws.close();
} finally {
  chrome?.kill();
  vite?.kill();
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("all checks passed");
