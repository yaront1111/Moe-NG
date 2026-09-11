/**
 * TWO NODES OF THE BROWSER-COMPILED PLAN, STAFFED CONCURRENTLY AND LANDED FOR REAL.
 *
 * WHAT THIS CLOSES. task-161b7e9d's DoD 1 asks for "node landing shas (at least 2 nodes, at
 * least 2 staffed concurrently)". `landLaneNode` cannot answer it: it resolves the SEEDED spec
 * node, takes no goal, and lands exactly one. This drives the same production chain --
 * `agent-wrapper-main.ts` -> compiled node source -> delivery coordinator -> `node-verifier.ts`
 * -> `node-lander.ts` -> git -- against the graph the BROWSER sealed, in the product repository
 * the BROWSER bootstrapped, with the wrapper's own concurrency knob above 1.
 *
 * HOW CONCURRENCY IS PROVED, and why the proof is what it is. `concurrentStaffing` below reads
 * the wrapper's own transcript for a BUSY refusal on node B strictly inside node A's delivery
 * window. That shape, rather than two simultaneous deliveries, is what the product actually
 * permits: one checkout owner per repository root. Observing "two landings happened" would NOT
 * be evidence of anything -- a strictly sequential wrapper produces two landings too.
 *
 * EVERY SHA IS READ FROM GIT, never parsed out of the wrapper's transcript, and each is matched
 * to its node through the lander's OWN commit body (`node-lander.ts`'s `landingMessage`).
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SqliteEventStore } from "@moe/store";

import { policyAggregateId } from "../../../apps/daemon/src/bootstrap/bootstrap-sequence.js";
import { reviewerCalibrationSlice, verifierPolicySlice }
  from "../../../apps/daemon/src/orchestrator/demo-seed-policy.js";
import { compiledExecutionRef }
  from "../../../apps/daemon/src/orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs }
  from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { LANDING_FAULT_DEVELOPMENT_ENV, LANDING_FAULT_POINT_ENV }
  from "../../../apps/daemon/src/orchestrator/landing-fault-injection.js";
import type { LandingFaultPoint }
  from "../../../apps/daemon/src/orchestrator/landing-fault-injection.js";
import { killTree } from "./daemon-children.js";
import { readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { liveProviderSeat, providerExecutable } from "./live-proof-seat.js";
import { checksFor, modulePath } from "./live-proof-workspace.js";
import { resolveLaneScratch, startWrapper, WRAPPER_INTERVAL_MS, wrapperEnv } from "./wrapper-lane.js";

/**
 * Baseline, three REAL provider seats, three verifier runs and three commits.
 *
 * RAISED FOR THE REAL SEATS. A scripted seat wrote its file in milliseconds; a provider reads
 * the acceptance checks, writes a module and runs the checks itself, which cost 1-4 minutes per
 * node when measured. Delivery is serialized by the repository coordinator, so the budget is
 * the SUM of three provider turns plus the wrapper's own passes, not the maximum of them.
 */
export const LIVE_LANDING_BUDGET_MS = 1_200_000;
/** One provider seat's turn, from staffing to the module existing on disk. */
const SEAT_WRITE_BUDGET_MS = 900_000;
/**
 * THREE, so the two NODE seats can be alive together.
 *
 * The board carries a third READY item beside the two nodes -- `plan.propose@run-live-1`, which
 * the seat launcher does not claim and which the wrapper retries until its attempts exhaust.
 * MEASURED 2026-09-09 at `MOE_WRAPPER_MAX_AGENTS=2`: that item held one of the two seats, only
 * `node-auth-api` was ever staffed, and `node-entries` was reported SEAT_NEVER_WROTE. Three is
 * the smallest bound at which both nodes can be staffed in one pass; the CONCURRENCY CLAIM is
 * still `concurrentStaffing`'s transcript witness, not this number.
 */
const MAX_AGENTS = 3;
/** Raised for the reason `lane-landing.ts` raises it: the out-of-process round costs passes. */
const STAFFING_ATTEMPTS = 30;
/**
 * How long an ARMED pass is given to reach the named point and write its note.
 *
 * The note cannot appear until the provider seat has finished, the wrapper's verifier has run
 * and the landing write has started, so this bounds a REAL SEAT'S WHOLE TURN plus a verify.
 */
const CRASH_NOTE_BUDGET_MS = 900_000;

/** Arms the DEVELOPMENT-ONLY crash knob for the FIRST node's landing write, and only that one. */
export interface LiveLandingFault { readonly point: LandingFaultPoint }

/**
 * How the caller recovers the interrupted landing. Answers null when the product accepted the
 * recovery, or the refusal code when it did not -- never a boolean, because "it did not work"
 * is not evidence and this row's whole value is that its records carry codes.
 */
export type LiveCrashRecovery = (crash: LiveLandingCrash) => Promise<string | null>;

/**
 * How long the reconciled commit is given to be readable in Git after the recovery is recorded.
 *
 * Short by design: the commit was written BEFORE the crash, so this waits on a filesystem read
 * rather than on any work. A budget that had to be long would mean the commit was never there.
 */
const RECOVERED_LANDING_MS = 60_000;

/** What the knob left behind, read from the dead pass's own fd 2 rather than from memory. */
export interface LiveLandingCrash {
  /** The knob's timestamp, as the dying process wrote it. */
  readonly at: string;
  readonly knob: string;
  readonly nodeKey: string;
  readonly nodeRef: string;
  /** The note verbatim. */
  readonly note: string;
  readonly pid: number;
  readonly point: string;
}

/** When a seat ran, from its own markers. Windows do not overlap: delivery is serialized. */
export interface LiveSeatWindow {
  readonly endedAt: number;
  readonly moduleBytes: number;
  readonly nodeKey: string;
  readonly providerStatus: number | null;
  /** Configured provider process was launched; its executable is attested outside this log. */
  readonly realProvider: boolean;
  readonly startedAt: number;
}

export interface LiveNodeLanding {
  readonly nodeKey: string;
  readonly nodeRef: string;
  readonly sha: string;
}

/** Whether two nodes of one goal were being staffed at the same moment, and the proof line. */
export interface LiveStaffingWitness {
  readonly concurrent: boolean;
  /** The wrapper line that carries the refusal code, verbatim. */
  readonly evidence: string | null;
  /** The node holding the repository checkout, and the node refused while it held it. */
  readonly holder: string | null;
  readonly waiter: string | null;
}

export interface LiveProofLanded {
  /** Present only when the caller armed the knob: what crashed, where, and when. */
  readonly crash: LiveLandingCrash | null;
  readonly landings: readonly LiveNodeLanding[];
  readonly ok: true;
  readonly seats: readonly LiveSeatWindow[];
  readonly staffing: LiveStaffingWitness;
  readonly wrapperPid: number | null;
}

export interface LiveProofLandingRefused {
  readonly detail: string;
  readonly ok: false;
  readonly wrapperPid: number | null;
}

/** The compiled node ref for every node key the browser's sealed plan carries. */
export function liveCompiledRefs(
  scratch: LaneScratch, keys: readonly string[],
): Readonly<Record<string, string>> {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const refs: Record<string, string> = {};
    for (const graph of activeCompiledGraphs(store, scratch.projectId)) {
      for (const node of graph.content.snapshot.nodes) {
        if (keys.includes(node.nodeKey)) {
          refs[node.nodeKey] = compiledExecutionRef(scratch.projectId, graph, node.nodeKey);
        }
      }
    }
    return Object.freeze(refs);
  } finally { store.close(); }
}

/** Removes the seeded SPEC node so only the browser's compiled nodes are staffable. */
function retireSpecNode(scratch: LaneScratch): void {
  for (const name of readdirSync(scratch.nodeSpecsDir)) {
    if (name.endsWith(".json")) rmSync(join(scratch.nodeSpecsDir, name), { force: true });
  }
}

/** The seat's own report, over the daemon's real command edge. Shape only; the verifier judges. */
async function submitProductRound(
  lane: DaemonLane, scratch: LaneScratch, workspace: string, nodeKey: string, nodeRef: string,
): Promise<string | null> {
  const store = SqliteEventStore.openForProject(scratch.storePath, lane.projectId);
  let expectedVersion: number;
  try { expectedVersion = store.getAggregateVersion(nodeRef); } finally { store.close(); }
  const digest = (domain: string, bytes: string): string =>
    createHash("sha256").update(`${domain}::${bytes}`).digest("hex");
  const delivered = readFileSync(join(workspace, modulePath(nodeKey)), "utf8");
  const payload = {
    findings: [],
    packageItems: [
      { digest: digest("criterion", nodeRef), kind: "CRITERION", locator: `${nodeRef}/test` },
      { digest: digest("receipt", nodeRef), kind: "DAEMON_RECEIPT", locator: `${nodeRef}/baseline` },
      { digest: digest("graph", lane.projectId), kind: "GRAPH_HASH", locator: lane.projectId },
      { digest: digest("tree", nodeKey), kind: "INTEGRATED_TREE", locator: nodeKey },
      { digest: digest("plan", nodeRef), kind: "PLAN_HASH", locator: `${nodeRef}/spec` },
      { digest: digest("rubric", nodeRef), kind: "RUBRIC", locator: `${nodeRef}/rubric` },
      { digest: createHash("sha256").update(delivered).digest("hex"),
        kind: "SUBMITTED_BYTES", locator: modulePath(nodeKey) },
    ],
    round: expectedVersion + 1, subjectRef: nodeRef,
  };
  const response = await fetch(`${lane.daemonOrigin}/command`, {
    body: JSON.stringify({
      commandId: `live-proof-review-${nodeKey}`, commandKind: "review.submit",
      correlationId: "live-proof-landing", expectedVersion, payload,
      requestDigest: "d".repeat(64), schemaVersion: "moe-runtime-command/1",
      sessionCredential: lane.credential, targetAggregateId: nodeRef,
    }),
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": lane.credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    method: "POST",
  });
  const answer: unknown = await response.json();
  return (answer as { outcome?: unknown }).outcome === "ACCEPTED"
    ? null : `REVIEW_SUBMIT ${String(response.status)}: ${JSON.stringify(answer)}`;
}

/** The lander's own commit for a node, matched on the body `node-lander.ts` writes. */
function landedSha(workspace: string, nodeRef: string): string | null {
  const message = `Moe landed node ${nodeRef} after the daemon verified it.`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  const out = execFileSync("git",
    ["log", "--format=%H", "--fixed-strings", `--grep=${message}`],
    { cwd: workspace, encoding: "utf8", env, windowsHide: true }).trim();
  const lines = out.split(/\r?\n/u).filter((line) => /^[0-9a-f]{40}$/u.test(line));
  return lines.length === 1 ? lines[0]! : null;
}

/**
 * The same read, given a budget. EXACTLY ONE matching commit is still the answer: `landedSha`
 * returns null for two, so a duplicated landing reads as ABSENT here rather than as success.
 */
async function landedShaWithin(
  workspace: string, nodeRef: string, budgetMs: number,
): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const sha = landedSha(workspace, nodeRef);
    if (sha !== null || Date.now() >= deadline) return sha;
    await delay(1_000);
  }
}

/**
 * TWO NODES LIVE ON THE BOARD AT ONE MOMENT, taken from the WRAPPER'S OWN transcript.
 *
 * WHY IT IS NOT "TWO SEATS ALIVE AT ONCE". MEASURED 2026-09-09: the repository delivery
 * coordinator admits exactly ONE checkout owner per repository root, and a second node asking
 * while the first holds it is refused `REPOSITORY_EXECUTION_BUSY (REPOSITORY_DELIVERY)`. That is
 * a designed invariant -- all nodes of a goal share one MOE_NODE_WORKSPACE -- so a proof that
 * demanded two simultaneous DELIVERIES would be demanding the product be wrong.
 *
 * WHAT IS TRUE AND WHAT THIS MEASURES: the wrapper staffs every READY item each pass, so both
 * nodes are claimed and attempted while one is delivering. The witness is a BUSY refusal for
 * node B strictly BETWEEN node A's `SPAWNED` and its `agent exited`, which can only appear if
 * both items were being staffed inside the same delivery window. A board holding one node, or a
 * wrapper that staffed one item per pass, produces no such line -- so the arm can fail.
 */
export function concurrentStaffing(
  transcript: string, refs: readonly string[],
): LiveStaffingWitness {
  const lines = transcript.split(/\r?\n/u);
  for (const holder of refs) {
    const spawnedAt = lines.findIndex((line) => line.includes(`node.deliver@${holder}: SPAWNED`));
    if (spawnedAt === -1) continue;
    const exitedAt = lines.findIndex((line, index) =>
      index > spawnedAt && line.includes(`node.deliver@${holder} agent exited`));
    const window = lines.slice(spawnedAt + 1, exitedAt === -1 ? lines.length : exitedAt);
    for (const waiter of refs.filter((ref) => ref !== holder)) {
      const busy = window.find((line) =>
        line.includes(`node.deliver@${waiter}`) && line.includes("REPOSITORY_EXECUTION_BUSY"));
      if (busy !== undefined) {
        return Object.freeze({ concurrent: true as const, evidence: busy.trim(), holder, waiter });
      }
    }
  }
  return Object.freeze({ concurrent: false as const, evidence: null, holder: null, waiter: null });
}

function readMark(dir: string, nodeKey: string): Readonly<Record<string, unknown>> | null {
  const file = join(dir, `seat-${nodeKey}.end`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Readonly<Record<string, unknown>>; }
  catch { return null; }
}

/**
 * Installs the STANDING VERIFIER AUTHORITY, on the operator wire, and says so.
 *
 * MEASURED, NOT ASSUMED, on this drive 2026-09-09: with only the browser's own policy install
 * the wrapper's verifier prints "standing authority incomplete: moe-verifier-policy/1,
 * moe-reviewer-calibration/1 not installed ... delivered nodes wait on verification until
 * policy.install lands them", and no node is ever accepted. The two slices come from the
 * daemon's OWN production module (`demo-seed-policy.ts`), never restated here.
 *
 * THIS IS THE OPERATOR'S ACT, NOT THE BROWSER'S, and the transcript records it as such: the
 * control room's activation chain installs exactly one policy slice, so a browser-bootstrapped
 * product cannot install these two from any screen it ships. That is a recorded finding of this
 * drive, filed rather than routed around, and the owner's ruling (comment-267eccae) is what
 * permits an operator-wire step to stand in where the browser is genuinely unable.
 */
export async function installStandingAuthority(
  lane: DaemonLane, scratch: LaneScratch,
): Promise<readonly { readonly outcome: unknown; readonly sliceRef: unknown }[]> {
  const aggregate = policyAggregateId(lane.projectId);
  const slices = [
    verifierPolicySlice({ projectId: lane.projectId }),
    reviewerCalibrationSlice({ projectId: lane.projectId }),
  ];
  const answers: { outcome: unknown; sliceRef: unknown }[] = [];
  for (const [index, slice] of slices.entries()) {
    const store = SqliteEventStore.openForProject(scratch.storePath, lane.projectId);
    let expectedVersion: number;
    try { expectedVersion = store.getAggregateVersion(aggregate); } finally { store.close(); }
    const response = await fetch(`${lane.daemonOrigin}/command`, {
      body: JSON.stringify({
        commandId: `live-proof-standing-authority-${String(index)}`,
        commandKind: "policy.install", correlationId: "live-proof-standing-authority",
        expectedVersion, payload: { slice }, requestDigest: "d".repeat(64),
        schemaVersion: "moe-runtime-command/1", sessionCredential: lane.credential,
        targetAggregateId: aggregate,
      }),
      headers: {
        "content-type": "application/json", origin: lane.daemonOrigin,
        "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": lane.credential,
        "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
      },
      method: "POST",
    });
    const answer: unknown = await response.json();
    answers.push({
      outcome: (answer as { outcome?: unknown }).outcome ?? answer,
      sliceRef: slice["sliceRef"],
    });
  }
  return Object.freeze(answers);
}

/** Runs the real wrapper until EVERY named node has landed, then stops it. */
export async function landLiveProofNodes(
  lane: DaemonLane, workspace: string, keys: readonly string[],
  rendezvous: readonly string[], objectives: Readonly<Record<string, string>> = {},
  fault: LiveLandingFault | null = null,
  onCrash: LiveCrashRecovery | null = null,
): Promise<LiveProofLanded | LiveProofLandingRefused> {
  const scratch = resolveLaneScratch(lane);
  if (scratch === null) {
    return { detail: "LANE_SCRATCH_UNRESOLVED", ok: false, wrapperPid: null };
  }
  const refs = liveCompiledRefs(scratch, keys);
  const missing = keys.filter((key) => refs[key] === undefined);
  if (missing.length > 0) {
    return { detail: `NO_COMPILED_EXECUTION_NODE ${missing.join(",")}`, ok: false, wrapperPid: null };
  }
  retireSpecNode(scratch);
  const seat = liveProviderSeat({
    briefs: keys.map((key) => ({
      checks: checksFor(key), modulePath: modulePath(key), nodeKey: key,
      objective: objectives[key] ?? "",
    })),
    dir: scratch.root,
    executable: providerExecutable(),
    providerMode: "REAL_PROVIDER",
    refs,
    rendezvous,
    workspace,
  });
  const tracked: ChildProcess[] = [];
  const priorTranscripts: string[] = [];
  const startPass = (arming: LiveLandingFault | null): ReturnType<typeof startWrapper> =>
    startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, seat.command, WRAPPER_INTERVAL_MS, true),
    // `node`, NOT `process.execPath`: this host's executable is "C:\Program Files\nodejs\node.exe"
    // and the verifier parses the command into argv, so the space split it and the run exited 1
    // with FAILED_ROUND_RECORDED. The lane's own seeded node command uses the bare name too.
    MOE_NODE_TEST_COMMAND: "node verify.mjs",
    MOE_NODE_WORKSPACE: workspace,
    MOE_WRAPPER_MAX_AGENTS: String(MAX_AGENTS),
    MOE_WRAPPER_MAX_ITEM_ATTEMPTS: String(STAFFING_ATTEMPTS),
    // THE CRASH KNOB, and it is the SHIPPED one: `landing-fault-injection.ts` refuses to arm
    // unless BOTH variables are set, so an unarmed pass passes neither and the injector reads
    // FAULT_INJECTION_DISARMED. Nothing here can crash an unarmed run.
    ...(arming === null ? {} : {
      [LANDING_FAULT_DEVELOPMENT_ENV]: "1", [LANDING_FAULT_POINT_ENV]: arming.point,
    }),
  }, tracked);
  let watched = startPass(fault);
  const wrapperPid = watched.child.pid ?? null;
  let armed = fault;
  let crash: LiveLandingCrash | null = null;
  let stopped = false;
  const stopTracked = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const child of [...tracked].reverse()) await killTree(child);
  };
  // THE NOISE ITEM IS FILTERED OUT OF THE DIAGNOSIS, not out of the run: the board's
  // `plan.propose` retries fill the tail and would hide the node lines a refusal is read for.
  const refuse = (detail: string): LiveProofLandingRefused => {
    // DEDUPLICATED PER PASS, because a poll that repeats one refusal 300 times is one fact --
    // but a line the SECOND pass printed is a different fact from the identical line the first
    // pass printed, and deduplicating across the restart boundary erased the whole recovery
    // pass from the tail (measured 2026-09-09: the restarted wrapper looked silent when it was
    // merely repeating itself). Order is preserved and nothing is rewritten.
    const lines = [...priorTranscripts, watched.transcript()].flatMap((pass) => {
      const seen = new Set<string>();
      return pass.split(/\r?\n/u)
        .filter((line) => !line.includes("plan.propose@") && line.trim() !== "")
        .filter((line) => { const had = seen.has(line); seen.add(line); return !had; });
    });
    return { detail: `${detail}\n${lines.slice(-40).join("\n")}`, ok: false, wrapperPid };
  };
  try {
    // ONE NODE AT A TIME, BY THE PRODUCT'S RULE AND NOT BY PREFERENCE. The delivery coordinator
    // holds the repository reservation from the moment a node is staffed until it LANDS, so a
    // driver that waited for every seat to write before recording any round DEADLOCKS: node A
    // holds the checkout waiting for a round that waits on node B, and B is refused
    // REPOSITORY_EXECUTION_BUSY on every pass. MEASURED 2026-09-09 as exactly that. Whichever
    // node writes first is recorded and landed; the rest follow as the checkout frees.
    const remaining = [...keys];
    const landings: LiveNodeLanding[] = [];
    while (remaining.length > 0) {
      const seatDeadline = Date.now() + SEAT_WRITE_BUDGET_MS;
      // The file may become visible before its JSON write finishes; wait for a complete mark.
      const ready = (): string | undefined =>
        remaining.find((row) => readMark(scratch.root, row) !== null);
      let key = ready();
      while (key === undefined && Date.now() < seatDeadline) {
        await delay(250);
        key = ready();
      }
      if (key === undefined) return refuse(`SEAT_NEVER_WROTE ${remaining.join(",")}`);
      const mark = readMark(scratch.root, key);
      if (mark?.["ok"] !== true || mark["realProvider"] !== true || mark["providerStatus"] !== 0
        || typeof mark["moduleBytes"] !== "number" || !(mark["moduleBytes"] > 0)) {
        return refuse(`SEAT_PROVIDER_COMPLETION_UNPROVEN ${key}`);
      }
      const nodeRef = refs[key]!;
      const round = await submitProductRound(lane, scratch, workspace, key, nodeRef);
      if (round !== null) return refuse(round);
      if (armed !== null) {
        // THE FORCED CRASH, MID-WRITE. The knob SIGKILLs the process performing the landing
        // write at the named point; the pass never returns and its terminal line never reaches
        // stdout. The note it writes to fd 2 before the signal is the only thing it leaves
        // behind, and it reads identically on Windows, which has no signals.
        //
        // `\d` AND `\S`, DOUBLED, BECAUSE THIS IS A TEMPLATE LITERAL. A single `\d` inside
        // backticks is a NonEscapeCharacter and collapses to a bare `d`, so the pattern silently
        // becomes `pid=(d+)` and never matches. MEASURED 2026-09-09: the knob fired, the note was
        // in the transcript verbatim, and the wait still reported FAULT_NOTE_NEVER_WRITTEN.
        //
        // THE WHOLE NOTE IS GROUP 1 because `watched.waitFor` resolves with `exec(...)[1]` and
        // nothing else -- a pattern whose first group is the pid would throw the timestamp away.
        const note = await watched.waitFor(
          new RegExp(`^(${LANDING_FAULT_POINT_ENV} point=${armed.point} pid=\\d+ at=\\S+)`, "mu"),
          CRASH_NOTE_BUDGET_MS);
        if (note === null) return refuse(`FAULT_NOTE_NEVER_WRITTEN ${armed.point} ${key}`);
        const stamped = /pid=(\d+) at=(\S+)/u.exec(note);
        crash = { at: stamped?.[2] ?? "", knob: LANDING_FAULT_POINT_ENV, nodeKey: key, nodeRef,
          note, pid: Number(stamped?.[1] ?? 0), point: armed.point };
        // THE RESTART. A NEW process, same store, same repository, same handle, NO arming. It is
        // told nothing about what happened and works it out from the store, which is the whole
        // claim. The dead pass's transcript is kept, so a refusal after this point still carries
        // the crash in its tail.
        priorTranscripts.push(watched.transcript(), `--- RESTART AFTER ${note} ---`);
        await killTree(watched.child);
        armed = null;
        watched = startPass(null);
        // AND THEN THE PRODUCT'S OWN RECOVERY RUNS, driven by the caller.
        //
        // MEASURED 2026-09-09/10, and this is why re-driving a ROUND is NOT what happens here.
        // The delivery coordinator persists `phase: LANDING` before it calls the lander
        // (`repository-delivery-coordinator.ts:163`), so the restarted pass finds a reservation
        // in LANDING, reads durable facts that say ACCEPTED rather than LANDED, and BLOCKS it
        // (`:180`, and BLOCKED is terminal in the phase table). A second round then has nowhere
        // to run: a first drive armed at `before-intent` re-submitted one and twenty minutes of
        // a fresh pass produced no landing at all. The shipped way out is `repository.recover`,
        // which is human-only by construction -- so the caller drives it, from the browser.
        //
        // THIS IS ALSO WHERE A DUPLICATE WOULD COME FROM, and that is the point: the reconcile
        // writes a landing receipt only when the durable evidence proves Git already committed
        // and no receipt exists yet, so a second outcome for this node would be exactly what
        // DoD 2's row count catches.
        const recovered = onCrash === null
          ? "NO_RECOVERY_DRIVER" : await onCrash(crash);
        priorTranscripts.push(recovered === null
          ? "--- RECOVERY RECONCILED ---" : `--- RECOVERY REFUSED: ${recovered} ---`);
        if (recovered !== null) return refuse(`RECOVERY_REFUSED ${recovered}`);
        // THE COMMIT IS ALREADY IN GIT: the knob fired after the landing journaled its
        // completion, so the lander never prints a COMMITTED line for this node and waiting for
        // one would time out on a landing that really happened. Git is the durable answer.
        const recoveredSha = await landedShaWithin(workspace, nodeRef, RECOVERED_LANDING_MS);
        if (recoveredSha === null) return refuse(`RECOVERED_LANDING_ABSENT ${key}`);
        landings.push({ nodeKey: key, nodeRef, sha: recoveredSha });
        remaining.splice(remaining.indexOf(key), 1);
        continue;
      }
      const committed = await watched.waitFor(
        new RegExp(`^\\[lander\\] (${nodeRef.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}): COMMITTED `, "mu"),
        LIVE_LANDING_BUDGET_MS);
      if (committed === null) return refuse(`LANDING_BUDGET_SPENT ${key}`);
      landings.push({ nodeKey: key, nodeRef, sha: "" });
      remaining.splice(remaining.indexOf(key), 1);
    }
    await stopTracked();
    const resolved = landings.map((row) => ({ ...row, sha: landedSha(workspace, row.nodeRef) ?? "" }));
    const unresolved = resolved.filter((row) => row.sha === "");
    if (unresolved.length > 0) {
      return refuse(`LANDING_COMMIT_UNRESOLVED ${unresolved.map((row) => row.nodeKey).join(",")}`);
    }
    const seats = keys.map((key) => {
      const mark = readMark(scratch.root, key);
      return {
        endedAt: Number(mark?.["endedAt"] ?? 0), moduleBytes: Number(mark?.["moduleBytes"] ?? 0), nodeKey: key,
        providerStatus: typeof mark?.["providerStatus"] === "number" ? mark["providerStatus"] : null,
        realProvider: mark?.["realProvider"] === true,
        startedAt: Number(mark?.["startedAt"] ?? 0),
      };
    });
    return {
      crash, landings: resolved, ok: true, seats,
      // EVERY PASS, NOT THE LAST ONE. The concurrency window belongs to the FIRST node's
      // delivery, and when the knob is armed that pass is the one the crash killed -- its
      // transcript is in `priorTranscripts` and the live handle holds only the restarted pass.
      // MEASURED 2026-09-09: reading `watched.transcript()` alone reported concurrent:false on a
      // run whose dead pass carried the BUSY line verbatim.
      staffing: concurrentStaffing(
        [...priorTranscripts, watched.transcript()].join("\n"),
        rendezvous.map((key) => refs[key]!)),
      wrapperPid,
    };
  } finally {
    await stopTracked();
  }
}
