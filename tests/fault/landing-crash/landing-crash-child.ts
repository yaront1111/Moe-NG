/**
 * ONE DAEMON LANDING PASS, IN A REAL PROCESS THAT CAN REALLY DIE.
 *
 * The crash this row has to prove happens between the Git commit and the journal
 * completion that records it. That window is microseconds wide and has no externally
 * observable edge, so an outside `kill` cannot aim at it — only the process running the
 * write can die there. This module is therefore a REAL process: `node` runs it, the
 * DEVELOPMENT-ONLY knob inside `landing-fault-injection.ts` SIGKILLs it from the inside,
 * and the parent lane then restarts it against the SAME store and the SAME repository.
 *
 * NOTHING HERE DECIDES ANYTHING. The gate is production `landingJournalGate`, the write is
 * production `commitJournaledLanding`, the Git effect is the production verified-workspace
 * port against a real `git` executable, and the store is the real `SqliteEventStore` on a
 * real file. A pass that re-derived any of those would prove only that this file agrees
 * with itself.
 *
 * ARMING IS PURELY ENVIRONMENTAL. The crash pass and the control pass execute BYTE
 * IDENTICAL code; the only difference between them is `MOE_FAULT_INJECT_LANDING` and
 * `MOE_DEVELOPMENT_ONLY` in the environment the parent hands this process. That is what
 * makes the control a control: if this file branched on a mode argument, the two passes
 * would be different programs and the comparison would be worthless.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteEventStore } from "@moe/store";

import { commitJournaledLanding, landingJournalGate } from "../../../apps/daemon/src/orchestrator/node-lander-journal.js";
import { createVerifiedWorkspacePort } from "../../../apps/daemon/src/repository/git-verified-workspace-port.js";
import { validExecutionOwner } from "../../../apps/daemon/src/repository/repository-execution-record.js";
import type { RepositoryExecutionHandle } from "../../../apps/daemon/src/repository/repository-execution-contracts.js";

/** The single env variable that carries the world. Named once, read once. */
export const LANDING_PASS_WORLD_ENV = "MOE_LANDING_PASS_WORLD";
/** Every terminal line this process prints starts with this. Absence means it died. */
export const LANDING_PASS_RESULT_PREFIX = "MOE_LANDING_PASS_RESULT ";

/**
 * What the parent hands over. The HANDLE ARRIVES WHOLE, as JSON, rather than being rebuilt
 * here from parts: the parent and this child must address the same landing intent across
 * two process lifetimes, and two independent constructions of the same literal are exactly
 * the kind of drift that would make a restart address a different aggregate and report a
 * clean world that was never the crashed one.
 */
export interface LandingPassWorld {
  readonly storePath: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly paths: readonly string[];
  readonly message: string;
  readonly verifierReceiptId: string;
  readonly handle: RepositoryExecutionHandle;
}

export type LandingPassResult =
  | { readonly outcome: "COMMITTED"; readonly sha: string; readonly branch: string }
  | { readonly outcome: "REFUSED"; readonly code: string; readonly gate: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decodes the world, refusing rather than coercing.
 *
 * `validExecutionOwner` is production's own owner check — the same one
 * `recordRepositoryLandingIntent` applies — so a world this child accepts is a world the
 * journal will also accept, and a malformed one fails here with a readable message instead
 * of surfacing later as a recovery refusal that would be mistaken for the thing under test.
 */
export function readLandingPassWorld(raw: string | undefined): LandingPassWorld {
  if (raw === undefined || raw === "") throw new Error(`${LANDING_PASS_WORLD_ENV} is not set`);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed["handle"])) throw new Error("world is not an object");
  const handle = parsed["handle"];
  if (!validExecutionOwner(handle["owner"]) || !isRecord(handle["reservation"])) {
    throw new Error("world carries no valid execution owner");
  }
  const paths = parsed["paths"];
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw new Error("world carries no path list");
  }
  for (const key of ["storePath", "projectId", "workspace", "message", "verifierReceiptId"]) {
    if (typeof parsed[key] !== "string") throw new Error(`world is missing ${key}`);
  }
  return {
    handle: handle as unknown as RepositoryExecutionHandle,
    message: parsed["message"] as string,
    paths: paths as readonly string[],
    projectId: parsed["projectId"] as string,
    storePath: parsed["storePath"] as string,
    verifierReceiptId: parsed["verifierReceiptId"] as string,
    workspace: parsed["workspace"] as string,
  };
}

/**
 * The pass, in production's order: the recovery gate first, then the journaled write.
 *
 * `node-lander.ts:176` consults `landingJournalGate` before it looks at the workspace at
 * all, so a restarted daemon that finds a half-written landing refuses BEFORE it can mint a
 * second Git effect. Running the gate anywhere else here would prove a different program.
 */
export async function runLandingPass(world: LandingPassWorld): Promise<LandingPassResult> {
  const store = SqliteEventStore.openForProject(world.storePath, world.projectId);
  try {
    const gate = landingJournalGate(store, world.handle);
    if (gate !== null) return { code: gate, gate, outcome: "REFUSED" };
    const port = createVerifiedWorkspacePort();
    const captured = await port.capture(world.workspace);
    if (!captured.ok) return { code: captured.code, gate: null, outcome: "REFUSED" };
    const landed = await commitJournaledLanding({
      binding: captured.binding,
      handle: world.handle,
      message: world.message,
      paths: world.paths,
      port,
      store,
      verifierReceiptId: world.verifierReceiptId,
      workspace: world.workspace,
    });
    if (!landed.ok) return { code: landed.code, gate: null, outcome: "REFUSED" };
    return { branch: landed.receipt.branch, outcome: "COMMITTED", sha: landed.receipt.sha };
  } finally {
    store.close();
  }
}

/**
 * The entry runs ONLY when `node` was pointed at this file.
 *
 * The parent lane imports this module for its two constants and its types, and an
 * unconditional entry would run a landing pass inside the test worker the moment the
 * import resolved. The guard compares argv against this module's own path rather than
 * sniffing the environment, so a child that was started correctly but handed a broken
 * world still fails LOUDLY in `readLandingPassWorld` instead of exiting quietly and
 * looking, from outside, exactly like the crash this lane is trying to observe.
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const world = readLandingPassWorld(process.env[LANDING_PASS_WORLD_ENV]);
  const result = await runLandingPass(world);
  process.stdout.write(`${LANDING_PASS_RESULT_PREFIX}${JSON.stringify(result)}\n`);
}
