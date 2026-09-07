/**
 * CODEX-SEAT MECHANICS: the shim that actually selects the codex branch, one wrapper pass whose
 * seats are all the codex double, and the durable readback the journey is graded on.
 *
 * WHAT IS REUSED AND WHY. The world, the source-bound goal and the Gate-1-approved contract come
 * from `j5-plan-reject-harness.ts` (`createJ5Scratch`, `preludeThroughGate1`, `decidePlan`),
 * which is the only tracked module that drives the PLANNING lane to the point where the wrapper
 * will staff a real planning seat. Process control (`startDaemon`, `runWrapper`, `killTree`) is
 * `j1-loop-harness.ts`'s. Both are imported, never edited: this row certifies the codex seat,
 * not the harness those journeys depend on.
 *
 * WHAT IS NEW HERE IS EXACTLY THE PROVIDER SEAM: a shim whose BASENAME selects the provider, and
 * a readback that can tell a codex spawn from a claude one.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: `e2e-harness.test.ts` scans every non-test module in this
 * directory for four needles by plain substring match, comments included. Every clock reading
 * arrives as a PARAMETER from the test file, which that scan excludes; scratch uniqueness is
 * `mkdtempSync`'s, which the OS makes unique without a random source of ours.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readReviewLedger } from "@moe/daemon";
import type { SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";

import { readLandingReceipt } from "../../../apps/daemon/src/repository/landing-ledger.js";
import {
  landingReceiptId,
} from "../../../apps/daemon/src/repository/landing-receipt-contracts.js";

import { IS_WINDOWS, REPOSITORY_ROOT, runWrapper } from "./j1-loop-harness.js";
import type { ProcessRun } from "./j1-loop-harness.js";
import { createJ5Scratch } from "./j5-plan-reject-harness.js";
import type { J5Scratch } from "./j5-plan-reject-harness.js";
import { ALPHA } from "./multi-node-graph-harness.js";
import { executionRefFor, withStore } from "./multi-node-reads.js";

const CODEX_AGENT = "tests/e2e/foundation/codex-agent.mjs";
/** The kind the compiled planning chain commits under; see `compiledPlanDecisions`. */
const PLAN_PROPOSE_KIND = "plan.propose";
/** `compile-run-resolution.ts` idsOf: one derived identity family per approved revision + run. */
const COMPILE_COMMAND_PREFIX = "compile-";

/**
 * The node key the codex planning seat binds every criterion to.
 *
 * It must name a module directory the journey's repository already carries, because the SAME
 * double then delivers into it: `createMultiNodeScratch` builds one directory per criterion, so
 * reusing alpha's keeps the world's own definition rather than inventing a second one.
 */
export const CODEX_NODE_KEY = ALPHA;
/** Where the codex double writes its deliverable, relative to the repository workspace. */
export const CODEX_IMPLEMENT_PATH = `${ALPHA}/math.mjs`;

/**
 * The two shim basenames, and the second one is the whole point of the control.
 *
 * `codex` is selected by `isCodexCommand`'s `/(?:^|[\\/])codex(?:\.[a-z]+)?$/iu`; `agent-codex`
 * is NOT, because the character before "codex" is a hyphen. Naming both here, in one union,
 * keeps the misnaming a DELIBERATE argument of a committed arm instead of a rename nobody
 * notices: a journey whose shim quietly became `agent-codex.*` would run the CLAUDE branch and
 * still pass every other assertion.
 */
export type ShimBasename = "codex" | "agent-codex";

/** The double's arms: the full journey, or a clean exit that submits nothing. */
export type CodexArm = "complete" | "skip-submit";

export interface CodexScratch extends J5Scratch {
  /** Where the double records its spawn surface and echoes every mission it received. */
  readonly echoDir: string;
  /** The shim's OWN directory: a bare `codex.cmd` has no arm suffix to disambiguate it. */
  readonly seatDir: string;
}

export function createCodexScratch(): CodexScratch {
  const scratch = createJ5Scratch();
  const echoDir = join(scratch.root, "codex-echo");
  const seatDir = join(scratch.root, "codex-seat");
  mkdirSync(echoDir);
  mkdirSync(seatDir);
  return { ...scratch, echoDir, seatDir };
}

export interface CodexShimOptions {
  readonly arm?: CodexArm;
  /** `codex` unless an arm is deliberately proving that the OTHER name selects claude. */
  readonly basename?: ShimBasename;
}

/**
 * The shim MOE_AGENT_COMMAND points at, named so the spawner's codex regex actually matches.
 *
 * Two facts `writeAgentShim`'s docblock records still bind and are restated here rather than
 * inherited, because that writer cannot produce this name: `agentSpawnInvocation` quotes the
 * COMMAND ITSELF for cmd.exe, so a multi-word MOE_AGENT_COMMAND becomes one unusable token -
 * hence the shim names `node` and prepends this run's argv; and `agentEnvironment()` scrubs
 * every non-allowlisted key and drops all `MOE_*`, so NO environment variable reaches the double
 * except the bearer the spawner injects AFTER that scrub. Everything else travels on argv.
 *
 * The shim gets its own directory: every other shim in this tree distinguishes itself by
 * filename (`agent-${arm}`), and this one cannot, because the name is fixed by the regex.
 */
export function writeCodexShim(scratch: CodexScratch, options: CodexShimOptions = {}): string {
  const arm = options.arm ?? "complete";
  const agent = join(REPOSITORY_ROOT, CODEX_AGENT);
  const flags = [
    `--echo-dir "${scratch.echoDir}"`,
    `--arm ${arm}`,
    `--node-key ${CODEX_NODE_KEY}`,
    `--implement "${CODEX_IMPLEMENT_PATH}"`,
  ].join(" ");
  const directory = join(scratch.seatDir, `${options.basename ?? "codex"}-${arm}`);
  mkdirSync(directory, { recursive: true });
  if (!IS_WINDOWS) {
    const path = join(directory, `${options.basename ?? "codex"}.sh`);
    writeFileSync(path, ["#!/bin/sh", `exec node "${agent}" ${flags} "$@"`, ""].join("\n"), {
      encoding: "utf8", mode: 0o755,
    });
    return path;
  }
  const path = join(directory, `${options.basename ?? "codex"}.cmd`);
  writeFileSync(path, ["@echo off", `node "${agent}" ${flags} %*`, ""].join("\r\n"), "utf8");
  return path;
}

/**
 * One REAL wrapper pass whose seats are all the codex double.
 *
 * `runWrapper` applies `options.environment` LAST, so overriding MOE_AGENT_COMMAND replaces the
 * shim it would otherwise write while every other wrapper fact stays byte-identical to what the
 * existing arms are handed. THREE SEATS rather than one, for the reason `runCompilerWrapper`
 * measured: the seeded world leaves an unrelated step READY beside this goal's own, and a
 * one-seat pass can spend its only seat there and never reach the seat under test.
 */
export function runCodexPass(scratch: CodexScratch, shim: string): Promise<ProcessRun> {
  return runWrapper(scratch, "complete", {
    environment: {
      MOE_AGENT_COMMAND: shim,
      MOE_NODE_SPECS_DIR: "",
      MOE_NODE_TEST_COMMAND: "node test.mjs",
      MOE_NODE_WORKSPACE: scratch.workspace,
      MOE_WRAPPER_MAX_AGENTS: "3",
      MOE_WRAPPER_ONCE: "1",
    },
  });
}

/** What one spawned double recorded about the invocation it actually received. */
export interface SpawnRecord {
  readonly argv: readonly string[];
  readonly bearerFromEnvironment: boolean;
  readonly cwd: string;
  readonly mcpConfigFlagPresent: boolean;
  readonly originFromArgv: string | null;
  readonly pid: number;
}

function slotsOf(directory: string, prefix: string, suffix: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort((left, right) => ordinalOf(left, prefix, suffix) - ordinalOf(right, prefix, suffix))
    .map((name) => readFileSync(join(directory, name), "utf8"));
}

/** `spawn-10.json` must sort after `spawn-2.json`; a plain string sort puts it first. */
function ordinalOf(name: string, prefix: string, suffix: string): number {
  return Number(name.slice(prefix.length, -suffix.length));
}

/** Every spawn surface a double actually received, in the order the doubles recorded them. */
export function spawnRecords(scratch: CodexScratch): readonly SpawnRecord[] {
  return slotsOf(scratch.echoDir, "spawn-", ".json")
    .map((text) => JSON.parse(text) as SpawnRecord);
}

/**
 * The wrapper's own `<command> --version` probe, which is an invocation but not a SEAT.
 *
 * `orchestrator/seat-start-recorder.ts` measures each provider's CLI once per wrapper process,
 * deliberately through the SAME `agentSpawnInvocation` the spawner uses so the reading is of the
 * image a seat actually gets. The double therefore records that probe alongside the seats it
 * doubles for, and a sweep that treats every record as a seat grades the probe against the seat
 * surface. Discriminated by the trailing `--version` the probe passes, which is the mirror of
 * the trailing `-` that carries a codex seat's mission on stdin - never by the filename.
 */
export function isVersionProbe(record: SpawnRecord): boolean {
  return record.argv.at(-1) === "--version";
}

/** Every mission a double was actually handed, in the order it echoed them. */
export function echoedMissions(scratch: CodexScratch): readonly string[] {
  return slotsOf(scratch.echoDir, "mission-", ".txt");
}

/** The missions staffed onto one command kind, discriminated by the mission's own words. */
export function missionsOfKind(scratch: CodexScratch, kind: string): readonly string[] {
  return echoedMissions(scratch).filter((mission) => mission.includes(`(command kind ${kind})`));
}

function allDecisions(store: SqliteEventStore): readonly CommandDecisionRecord[] {
  const rows: CommandDecisionRecord[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    rows.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return rows;
}

/** Every durable decision of one command kind, read from the store FILE after the processes die. */
export function decisionsOfKind(
  scratch: CodexScratch, commandKind: string,
): readonly CommandDecisionRecord[] {
  return withStore(scratch, (store) =>
    allDecisions(store).filter((row) => row.commandKind === commandKind));
}

/**
 * THE DURABLE TRACE OF AN ACCEPTED `planning.submit_decomposition`, and it is NOT a decision row
 * of that kind - MEASURED, not assumed.
 *
 * The MCP call answers `{outcome: "ACCEPTED", resultCode: "PLAN_COMPILED"}`, but what the ledger
 * records is the COMPILED PLANNING CHAIN the daemon drives inside `runSubmitDecomposition`: a
 * `plan.propose` pair whose command ids come from production's own derived identity family,
 * `compile-<revisionDigest12>-<runHash8>-{propose,finalize}` (`compile-run-resolution.ts` idsOf).
 * A `decisionsOfKind("planning.submit_decomposition")` assertion answers `[]` on a journey where
 * the submit DID commit - vacuously green as a negative and impossible as a positive - so both
 * directions are stated through this one predicate instead.
 *
 * The prefix filter is what separates the chain from the seeded `plan.propose@run-live-1` step,
 * which an unrelated seat can be staffed onto in the same pass.
 */
export function compiledPlanDecisions(scratch: CodexScratch): readonly CommandDecisionRecord[] {
  return decisionsOfKind(scratch, PLAN_PROPOSE_KIND)
    .filter((row) => row.key.commandId.startsWith(COMPILE_COMMAND_PREFIX));
}

/**
 * THE DELIVERY VERDICTS, every one of them durable.
 *
 * The verifier receipt id and the landing sha are folded through the daemon's OWN read models
 * (`readReviewLedger`, `readLandingReceipt`) rather than recomputed here: a view that redid the
 * fold would let a broken production fold and a broken test agree. A node that was never sealed
 * has no execution ref at all, which is why that lookup is allowed to answer null rather than
 * throwing - the negative arm asserts exactly that shape.
 */
export interface DeliveryView {
  readonly acceptedReceiptId: string | null;
  readonly executionRef: string | null;
  readonly landingOutcome: "COMMITTED" | "REFUSED" | null;
  readonly landingSha: string | null;
  readonly rounds: number;
}

export function readDeliveryView(scratch: CodexScratch, nodeKey: string): DeliveryView {
  let executionRef: string | null;
  try {
    executionRef = executionRefFor(scratch, nodeKey);
  } catch {
    // No active graph names this node: nothing was sealed, so nothing downstream can exist.
    return Object.freeze({
      acceptedReceiptId: null, executionRef: null, landingOutcome: null, landingSha: null,
      rounds: 0,
    });
  }
  return withStore(scratch, (store) => {
    const ledger = readReviewLedger(store, scratch.projectId, executionRef);
    const accepted = ledger.accepted?.verifierReceiptId ?? null;
    const landed = accepted === null ? null : readLandingReceipt(
      store, scratch.projectId, landingReceiptId(scratch.projectId, executionRef, accepted),
    );
    return Object.freeze({
      acceptedReceiptId: accepted,
      executionRef,
      landingOutcome: landed?.ok === true ? landed.receipt.outcome : null,
      landingSha: landed?.ok === true ? landed.receipt.commit?.sha ?? null : null,
      rounds: ledger.rounds.length,
    });
  });
}
