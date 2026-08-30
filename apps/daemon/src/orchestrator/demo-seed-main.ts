import { NODE_DELIVER_KIND } from "../http/affordance-contract.js";
import { BOARD_PROJECTION } from "../projections/board-projection-contracts.js";
import { readSeedConfig } from "./demo-seed-env.js";
import type { SeedConfig } from "./demo-seed-env.js";
import {
  MOE_SEED_FRAME_UNREADABLE,
  asObject,
  failure,
  fetchBudgetCommitment,
  isOutcome,
  refusalOutcome,
  wireFor,
} from "./demo-seed-http.js";
import type { FetchLike, SeedOutcome, Wire } from "./demo-seed-http.js";
import { buildDemoSeedPlan, toWireEnvelope } from "./demo-seed-plan.js";
import type { DemoSeedInput, SeedCommand } from "./demo-seed-plan.js";
import { checkApprovalPending, checkNodeReady } from "./demo-seed-surface.js";

/**
 * The demo seed: dispatches the J1 bootstrap chain over the daemon's own HTTP
 * surface so a code node reaches the wrapper's board without a human hand-driving
 * the live board or hand-building curl.
 *
 * A pure CLIENT — it changes no daemon contract and invents no command. Two rules
 * shape it: a command's durable commit is CONFIRMED on `/events/read` before the
 * next command is sent (the daemon's prerequisite table is about durable state, so
 * firing ahead of a commit is how a seed races itself), and any refusal is echoed
 * with the daemon's OWN code and layer rather than being restated as a local error.
 */

export { MOE_SEED_FRAME_UNREADABLE, MOE_SEED_TRANSPORT_FAILED } from "./demo-seed-http.js";
export type { FetchLike, SeedOutcome } from "./demo-seed-http.js";
export { MOE_SEED_NODE_NOT_READY } from "./demo-seed-surface.js";
export const MOE_SEED_COMMIT_TIMEOUT = "MOE_SEED_COMMIT_TIMEOUT" as const;
export const MOE_SEED_COMMIT_UNOBSERVABLE = "MOE_SEED_COMMIT_UNOBSERVABLE" as const;

/**
 * How a committed effect names itself on the event stream. Measured against a live
 * daemon: the row carries no plain commandId — its `identity.commandId` is
 * `moe-internal:decision-effect:<effectId>`, and `<effectId>` is what `POST /command`
 * answered with. That pair is the ONLY honest link between a request and its commit.
 */
const EFFECT_IDENTITY_PREFIX = "moe-internal:decision-effect:";

export interface SeedDeps {
  /** Injected so the envelopes carry the caller's reading, not a hidden clock. */
  readonly clock?: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  readonly log: (line: string) => void;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_ATTEMPTS = 40;
const DEFAULT_POLL_DELAY_MS = 50;
const PAGE_LIMIT = 200;

interface CommitWatch {
  readonly seen: Set<string>;
}

async function acknowledge(
  wire: Wire, config: SeedConfig, cursor: Record<string, unknown>,
): Promise<void> {
  await wire.post("/events/ack", {
    presentedCursor: { generation: cursor["generation"], position: cursor["position"] },
    subscriberId: config.subscriberId,
  });
}

/** Effect ids seen on the stream, whatever page they arrived on. */
function collect(frame: Record<string, unknown>, watch: CommitWatch): number {
  const events = Array.isArray(frame["events"]) ? frame["events"] : [];
  for (const event of events) {
    const identity = asObject(asObject(event)?.["identity"]);
    const named = identity?.["commandId"];
    if (typeof named === "string" && named.startsWith(EFFECT_IDENTITY_PREFIX)) {
      watch.seen.add(named.slice(EFFECT_IDENTITY_PREFIX.length));
    }
  }
  return events.length;
}

/**
 * Reads pages until the awaited command's effect appears, ACKNOWLEDGING each page it
 * consumed. Both halves are the documented protocol, not caution: a page with a
 * nextCursor stays the subscriber's pending offer until that exact cursor is presented
 * to /events/ack, so a client that never acks re-reads the same frozen page forever and
 * the next command's commit never arrives. Effect ids also ACCUMULATE across polls,
 * because a commit can go past in a page read while an earlier command was awaited.
 */
async function awaitCommit(
  wire: Wire, config: SeedConfig, watch: CommitWatch, awaited: string, deps: SeedDeps,
): Promise<SeedOutcome | null> {
  const attempts = deps.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const delayMs = deps.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const pause = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const frame = await wire.post("/events/read", {
      limit: PAGE_LIMIT, projection: BOARD_PROJECTION, subscriberId: config.subscriberId,
    });
    if (isOutcome(frame)) return frame;
    const refused = refusalOutcome("commit", frame);
    if (refused !== null) return refused;
    const consumed = collect(frame, watch);
    const cursor = asObject(frame["nextCursor"]);
    if (consumed > 0 && cursor !== null) await acknowledge(wire, config, cursor);
    if (watch.seen.has(awaited)) return null;
    await pause(delayMs);
  }
  return failure(
    MOE_SEED_COMMIT_TIMEOUT,
    `effect ${awaited} never appeared on /events/read after ${attempts} polls`,
  );
}

/** Everything one dispatched command needs, bundled so the sender keeps a readable arity. */
interface Drive {
  readonly commandIds: string[];
  readonly config: SeedConfig;
  readonly deps: SeedDeps;
  readonly watch: CommitWatch;
  readonly wire: Wire;
}

/** Sends ONE planned command and confirms its durable commit. `null` means it committed. */
async function dispatchCommand(drive: Drive, command: SeedCommand): Promise<SeedOutcome | null> {
  const { commandIds, config, deps, watch, wire } = drive;
  // Sealed HERE, at the wire: the plan itself never carries the credential.
  const frame = await wire.post("/command", toWireEnvelope(command, config.credential));
  if (isOutcome(frame)) return frame;
  const refused = refusalOutcome(command.commandKind, frame);
  if (refused !== null) {
    // ANOTHER DRIVER GOT THERE FIRST, and that is convergence, not failure: the
    // agent wrapper self-staffs the same bootstrap steps this seed drives, under
    // its own command ids, so the version fence answers CONFLICT where a replay
    // of OUR id would have answered REPLAYED. The durable state the seed wants
    // exists either way; skip the step and keep walking the plan.
    if (refused.code === "EXPECTED_VERSION_CONFLICT") {
      deps.log(`skipped ${command.commandKind} ${command.commandId} (already committed by another driver)`);
      return null;
    }
    return refused;
  }
  const decision = asObject(frame["decision"]);
  // REPLAYED is the durable decision answering from the store: this exact command
  // is ALREADY committed, and its effect rows were consumed on the run that first
  // decided it. Waiting for them to appear again is waiting for an event the seam
  // will never re-issue — measured by running the seed twice over one store.
  if (decision?.["disposition"] === "REPLAYED") {
    commandIds.push(command.commandId);
    deps.log(`replayed ${command.commandKind} ${command.commandId} (already durable)`);
    return null;
  }
  const effectId = decision?.["effectId"];
  if (typeof effectId !== "string" || effectId === "") {
    // Accepted but unobservable: the seed cannot confirm this commit on the
    // stream, and proceeding anyway would call a race a success.
    return failure(
      MOE_SEED_COMMIT_UNOBSERVABLE,
      `${command.commandKind} was accepted with no effectId, so its commit cannot be confirmed`,
    );
  }
  const waited = await awaitCommit(wire, config, watch, effectId, deps);
  if (waited !== null) return waited;
  commandIds.push(command.commandId);
  deps.log(`committed ${command.commandKind} ${command.commandId} (effect ${effectId})`);
  return null;
}

/**
 * THE APPROVAL RIDES A SECOND PHASE, and the ordering is the correctness. Its `budgetRef` is
 * the decide-time COMMITMENT the daemon binds back at activation (`approval-activation.ts` ->
 * `verifyBudgetCommitment`) over material that is not durable until this plan's own finalize
 * terminal has committed — so the seed READS it off `/budget/commitment/read` once the prelude
 * is committed. Deriving it client-side would be a second material list, the one thing
 * budget-commitment.ts exists to prevent; spelling it is the literal the bind-back refuses.
 */
async function dispatchApproval(
  drive: Drive, input: DemoSeedInput,
): Promise<SeedOutcome | null> {
  const commitment = await fetchBudgetCommitment(drive.wire, drive.config.runId);
  if (!commitment.ok) return commitment;
  const approval = buildDemoSeedPlan({ ...input, budgetRef: commitment.ref })
    .find((command) => command.commandKind === "approval.decide");
  if (approval === undefined) {
    return failure(
      MOE_SEED_FRAME_UNREADABLE,
      "the plan builds no approval.decide even holding the daemon's own commitment",
    );
  }
  drive.deps.log(`budget commitment ${commitment.ref} for ${drive.config.runId}`);
  return dispatchCommand(drive, approval);
}

export async function runDemoSeed(deps: SeedDeps): Promise<SeedOutcome> {
  const resolved = readSeedConfig(deps.env);
  if (!resolved.ok) {
    const first = resolved.refusals[0];
    const line = resolved.refusals.map((r) => `${r.code} ${r.subject}: ${r.message}`).join("; ");
    return failure(first?.code ?? MOE_SEED_FRAME_UNREADABLE, line);
  }
  const config = resolved.config;
  const wire = wireFor(config, deps.fetch);
  const input: DemoSeedInput = {
    // No commitment is held yet, so the prelude below plans no approval at all.
    budgetRef: null,
    correlationId: config.correlationId,
    decidedAt: (deps.clock ?? (() => new Date().toISOString()))(),
    goalId: config.goalId,
    node: config.node,
    principalId: config.principalId,
    projectId: config.projectId,
    runId: config.runId,
    stopBeforeApproval: config.stopBeforeApproval,
  };
  const commandIds: string[] = [];
  const drive: Drive = {
    commandIds, config, deps, watch: { seen: new Set<string>() }, wire,
  };
  for (const command of buildDemoSeedPlan(input)) {
    const failed = await dispatchCommand(drive, command);
    if (failed !== null) return failed;
  }
  if (config.stopBeforeApproval) {
    const pending = await checkApprovalPending(wire, config);
    if (pending !== null) return pending;
    deps.log(`PENDING approval.decide@${config.runId} — approve it on the live board`);
    return Object.freeze({
      commandIds: Object.freeze(commandIds), nodeRef: config.node.nodeRef, ok: true,
    });
  }
  const approved = await dispatchApproval(drive, input);
  if (approved !== null) return approved;
  const ready = await checkNodeReady(wire, config);
  if (ready !== null) return ready;
  deps.log(`READY ${NODE_DELIVER_KIND}@${config.node.nodeRef} (${config.node.title})`);
  return Object.freeze({ commandIds: Object.freeze(commandIds), nodeRef: config.node.nodeRef, ok: true });
}

/** The process shell: stdout for the ids, stderr for the daemon's own refusal. */
export async function main(): Promise<number> {
  const outcome = await runDemoSeed({
    env: process.env,
    fetch: globalThis.fetch as unknown as FetchLike,
    log: (line: string) => process.stdout.write(`${line}\n`),
  });
  if (!outcome.ok) {
    process.stderr.write(`${outcome.line}\n`);
    return 1;
  }
  process.stdout.write(`seeded ${outcome.nodeRef}: ${outcome.commandIds.join(" ")}\n`);
  return 0;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  process.exitCode = await main();
}
