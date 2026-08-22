/**
 * J3 arm mechanics: bind each of the design's three kill targets to a REAL process in the
 * Foundation stack, and replay a command against the RESTARTED daemon over its own HTTP
 * surface.
 *
 * WHAT "runner" IS IN THIS STACK, stated rather than implied. The design (line 1099) names
 * agent/runner/daemon. `@moe/runner` is a LIBRARY the daemon links in process — there is no
 * runner executable — and the process that actually runs an attempt is the agent wrapper: it
 * hosts the MCP host, the agent spawner, the node verifier and `verifier-process-runner.ts`,
 * which runs the verification command as its own child. So `runner` binds to the wrapper
 * process. The binding is asserted in the spec, not assumed here.
 *
 * NOTHING HERE DECIDES. The replay goes out through the seed's OWN wire and envelope
 * builders, so the daemon answers a request it would have answered from the shipped client;
 * a hand-rolled POST would be a second client whose refusals prove nothing about the first.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE — `e2e-harness.test.ts` scans every non-test module in
 * this directory for four needles by plain substring match.
 */
import { existsSync, readFileSync } from "node:fs";

import { readSeedConfig } from "../../../apps/daemon/src/orchestrator/demo-seed-env.js";
import type { SeedConfig } from "../../../apps/daemon/src/orchestrator/demo-seed-env.js";
import {
  isOutcome,
  wireFor,
} from "../../../apps/daemon/src/orchestrator/demo-seed-http.js";
import { readDaemonRefusal } from "../../../apps/daemon/src/orchestrator/demo-seed-refusal.js";
import type { DaemonRefusalEcho } from "../../../apps/daemon/src/orchestrator/demo-seed-refusal.js";
import {
  buildDemoSeedPlan,
  toWireEnvelope,
} from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import type { SeedCommand } from "../../../apps/daemon/src/orchestrator/demo-seed-plan.js";
import { type J1Scratch, CSRF_TOKEN, killPid } from "./j1-loop-harness.js";

/** Fixed, not read from a clock: the digest the daemon checks does not cover it. */
const REPLAY_DECIDED_AT = "2026-01-01T00:00:00.000Z";

/**
 * The seed's own config, rebuilt from the SAME environment the seed was handed.
 *
 * Restating the goal, run and principal ids as literals here would let this module and the
 * seed drift apart silently: the replayed command would then target an aggregate the seed
 * never advanced, and a refusal about a missing aggregate would be mistaken for fencing.
 */
export function seedConfigFor(scratch: J1Scratch, origin: string): SeedConfig {
  const result = readSeedConfig({
    MOE_CSRF_TOKEN: CSRF_TOKEN,
    MOE_DAEMON_CREDENTIAL: scratch.credential,
    MOE_DAEMON_ORIGIN: origin,
    MOE_NODE_SPECS_DIR: scratch.specsDir,
    MOE_PROJECT_ID: scratch.projectId,
    MOE_STORE_PATH: scratch.storePath,
  });
  if (!result.ok) {
    throw new Error(`seed config refused: ${result.refusals.map((r) => r.code).join(",")}`);
  }
  return result.config;
}

/** One planned seed command, looked up by kind so no version literal is restated here. */
export function seedCommand(config: SeedConfig, commandKind: string): SeedCommand {
  const plan = buildDemoSeedPlan({ ...config, decidedAt: REPLAY_DECIDED_AT });
  const found = plan.find((command) => command.commandKind === commandKind);
  if (found === undefined) throw new Error(`the seed plans no ${commandKind}`);
  return found;
}

export interface ReplayAnswer {
  readonly frame: Record<string, unknown>;
  readonly outcome: string | null;
  readonly refusal: DaemonRefusalEcho | null;
}

/**
 * Posts a command to the RESTARTED daemon and reports what it answered, refusal and all.
 *
 * `outcome` and `refusal` are carried side by side on purpose: a frame that is neither an
 * acceptance nor a readable refusal must not collapse into "it was refused", which is the
 * shape that lets an unreadable answer pass for fencing.
 */
export async function replayCommand(
  config: SeedConfig, command: SeedCommand,
): Promise<ReplayAnswer> {
  const wire = wireFor(config, fetch as never);
  const frame = await wire.post("/command", toWireEnvelope(command, config.credential));
  if (isOutcome(frame)) {
    throw new Error(`transport refused the replay: ${frame.ok ? "OK" : frame.code}`);
  }
  const outcome = typeof frame["outcome"] === "string" ? frame["outcome"] : null;
  return { frame, outcome, refusal: readDaemonRefusal(frame) };
}

/** The same command with a NEW id: same body, same expected version, so only staleness differs. */
export function withFreshId(command: SeedCommand, commandId: string): SeedCommand {
  return Object.freeze({ ...command, commandId });
}

/**
 * The agent's pid, read from the file the spawned agent writes.
 *
 * Bounded by an ATTEMPT COUNT rather than a deadline: this module is scanned for wall-clock
 * needles, and a count is the honest bound anyway — the arm wants "the agent is up", not
 * "some number of milliseconds elapsed".
 */
export async function waitForAgentPid(scratch: J1Scratch, attempts = 400): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(scratch.agentPidFile)) {
      const raw = readFileSync(scratch.agentPidFile, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error("the agent never wrote its pid file");
}

export type Settlement<T> =
  | { readonly kind: "REJECTED"; readonly reason: string }
  | { readonly kind: "RESOLVED"; readonly value: T }
  | { readonly kind: "STILL_RUNNING" };

/**
 * Waits for a promise, or gives up after a bounded number of ticks.
 *
 * A rejection is reported as its own kind rather than folded into "still running": a killed
 * process whose watcher threw and one that never settled are different facts, and an arm
 * that could not tell them apart would report a hang for a crash.
 */
export async function settledWithin<T>(
  promise: Promise<T>, attempts = 600,
): Promise<Settlement<T>> {
  let outcome: Settlement<T> = { kind: "STILL_RUNNING" };
  void promise.then(
    (value) => { outcome = { kind: "RESOLVED", value }; },
    (reason: unknown) => { outcome = { kind: "REJECTED", reason: String(reason) }; },
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (outcome.kind !== "STILL_RUNNING") return outcome;
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  }
  return outcome;
}

/** Reaps a pid the arm may have orphaned by killing its parent. Idempotent by construction. */
export function reap(pid: number | undefined): void {
  if (pid !== undefined) killPid(pid);
}
