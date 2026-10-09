// The island's side of the OpenCode connection: asking whether there is a server,
// saying what it found, and keeping the Rust reconnect loop honest.
//
// All of it lives here rather than in the chat view because the answer outlives the
// view: a failure found while sending a turn is still the answer when the room is
// opened again, and the room is the only place that asks.

import { Bridge, type OpenCodeHealth } from "./bridge";
import { State } from "./state";

/**
 * What counts as a connection failure.
 *
 * Rust already words its connection errors ("OpenCode unreachable (…)"), but the
 * same break reaches the island from several places and not all of them went
 * through that helper, so the shape of the message is matched too rather than only
 * the phrase. A false positive here means a turn failure is shown as a connection
 * failure — which is why the list is narrow and says "error sending request" only
 * in the company of something connection-shaped.
 */
const CONNECTION_FAILURE =
  /unreachable|error sending request|connection (?:refused|closed|reset)|failed to connect|ECONNREFUSED|os error 1006|no route to host|proxy ?error/i;

/** Whether a thrown message is a failure to reach OpenCode, rather than a refusal. */
export function isConnectionFailure(message: string): boolean {
  return CONNECTION_FAILURE.test(message);
}

/** Puts one health answer into the state the island renders. */
function apply(health: OpenCodeHealth) {
  State.connection = health.ok
    ? { kind: "connected", version: health.version ?? "?", url: health.url }
    : {
        kind: "failed",
        url: health.url,
        reason: health.reason ?? "OpenCode did not answer.",
        cliMissing: Boolean(health.cliMissing),
      };
  State.notify();
}

/**
 * Asks once, out loud, and records the answer.
 *
 * `what` is what is being attempted, for the "connecting…" line: a plain check and
 * a start are different things to be waiting for and reading as the same would make
 * the start look like a hang.
 */
export async function check(what = "Connecting…"): Promise<OpenCodeHealth | null> {
  State.connection = { kind: "connecting", what };
  State.notify();
  try {
    const health = await Bridge.opencodeHealth();
    apply(health);
    return health;
  } catch (err) {
    // The command itself failed, which is a different thing from the server being
    // down and still has to be reported as a failure rather than swallowed.
    const why = String(err).replace(/^Error:\s*/, "");
    console.error("[piko] opencode_health failed", err);
    void Bridge.log(`opencode health check failed: ${why}`);
    State.connection = {
      kind: "failed",
      url: "unknown",
      reason: why,
      cliMissing: false,
    };
    State.notify();
    return null;
  }
}

/**
 * The island's Start OpenCode, and only ever that.
 *
 * Rust checks health before it spawns, so a server that is already running is
 * reported as connected rather than joined by a second one, and only a server this
 * started is stopped when Piko exits.
 */
export async function start(): Promise<void> {
  State.connection = { kind: "connecting", what: "Starting OpenCode…" };
  State.notify();
  try {
    await Bridge.opencodeStart();
  } catch (err) {
    const why = String(err).replace(/^Error:\s*/, "");
    console.error("[piko] opencode_start failed", err);
    void Bridge.log(`opencode start failed: ${why}`);
    // Re-ask rather than writing the message in by hand: a failed start often
    // leaves a server that came up late, and the honest state is whatever health
    // says now, not what the failure guessed.
    await check();
    return;
  }
  await check();
}

/**
 * The reconnect loop, asked for on the island's behalf.
 *
 * Rust keeps exactly one loop running however often this is called with `true`, and
 * the loop ends by itself the moment health passes — so this is not something that
 * has to be balanced, only requested.
 */
export function watch(on: boolean): void {
  void Bridge.opencodeWatch(on);
}

/** Rust's own progress, pushed as the loop goes. */
export function applyEvent(health: OpenCodeHealth): void {
  apply(health);
}