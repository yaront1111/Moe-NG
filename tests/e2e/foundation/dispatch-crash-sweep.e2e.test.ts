/**
 * A CLIENT-ORIGINATED `foundation.dispatch` against a LIVE daemon, killed mid-flight, and
 * the reconciliation sweep that finds what the crash left behind.
 *
 * WHY THIS SPEC EXISTS. J3's in-flight reconcile clause could only assert `classified: 0`
 * and said so in its own header: no journey reserved a Foundation attempt, because the
 * dispatch ingress was parked. This task lands the derivation that makes the payload
 * ORIGINABLE by a client — only `activationRequestBytesBase64` and `binding` cross the wire
 * now, and the graph snapshot, the input manifest and the launch template are all read or
 * assembled from the server's own durable world — so the swept set can finally be non-empty
 * from a real crash rather than from a seeded literal.
 *
 * WHAT IS REAL. A real daemon child process on an ephemeral port, a real HTTP POST to
 * `/command`, a real repository and workspace catalog, a durable world written through
 * production seams, a real `taskkill /T /F`, and the SHIPPED reconciliation port swept over
 * the bytes the crash actually left.
 *
 * THE WINDOW IS POLLED, NOT TIMED. The attempt is in flight between its RESERVED event and
 * its RECORDED one; the test polls the durable store for exactly that state and kills the
 * daemon the moment it sees it. A wall-clock sleep would be a guess about a machine, and
 * this harness directory is scanned for wall-clock needles anyway.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import { createStoreDependencies }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";
import type { BootReconciliationResult }
  from "../../../apps/daemon/src/recovery/boot-reconciliation.js";
import { PRINCIPAL_ID, PROJECT_ID }
  from "../../../apps/daemon/src/recovery/restore-test-harness.js";
import { readInFlightFoundationAttempts }
  from "../../../apps/daemon/src/work/in-flight-attempts.js";
import {
  CREDENTIAL, FOUNDATION_SEAM_CATALOG_PATH, cleanupSeamHarnesses, dispatchPayload,
  seedFoundationStore,
} from "../../../apps/daemon/src/http/foundation-registry-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";

import { CSRF_TOKEN, killTree, startDaemon } from "./j1-loop-harness.js";
import type { J1Scratch } from "./j1-loop-harness.js";
import { pidIsAlive } from "./j1-loop-harness.js";
import { pidReaped } from "./orphan-reap.js";

/** Poll budget in POLLS, paced by a fixed interval — no clock is READ here, and the
 *  bound is a count so a slow host waits longer rather than failing sooner. */
const RESERVED_POLLS = 600;
const POLL_INTERVAL_MS = 10;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

const scratchRoots: string[] = [];

function dispatchScratch(): J1Scratch {
  const root = mkdtempSync(join(tmpdir(), "moe-e2e-dispatch-"));
  scratchRoots.push(root);
  const specsDir = join(root, "specs");
  const workspace = join(root, "workspace");
  mkdirSync(specsDir);
  mkdirSync(workspace);
  return {
    agentPidFile: join(root, "agent.pid"),
    // The daemon's operator credential AND the credential the wire presents: the seam
    // authenticates before it reads a single payload field, so a mismatch here would be
    // refused as UNAUTHENTICATED and never reach the derivation at all.
    credential: CREDENTIAL,
    // The project the fixtures seed. It must be the daemon's own project id or the store
    // it opens is a different durable world from the one seeded below.
    projectId: PROJECT_ID,
    root,
    specsDir,
    storePath: join(root, "store.sqlite"),
    workspace,
  };
}

/** The client's envelope: the NARROWED payload, nothing derived, nothing smuggled. */
function dispatchEnvelope(): Record<string, unknown> {
  return {
    commandId: "cmd-dispatch-crash-sweep",
    commandKind: "foundation.dispatch",
    correlationId: "corr-dispatch-crash-sweep",
    expectedVersion: 0,
    payload: dispatchPayload(),
    requestDigest: "a".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL,
    targetAggregateId: "activation-target",
  };
}

/** Reads the durable in-flight set: RESERVED attempts with no RECORDED answer yet. */
function inFlightCount(storePath: string): number {
  let store: SqliteEventStore | null = null;
  try {
    store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    const sweep = readInFlightFoundationAttempts(store, PROJECT_ID);
    return sweep.ok ? sweep.attempts.length : 0;
  } catch {
    // A concurrent writer can hold the file for an instant. An unreadable poll is not
    // evidence of an empty set, so it counts as "not yet" rather than as zero.
    return 0;
  } finally {
    store?.close();
  }
}

/**
 * Sweeps the SHIPPED reconciliation port over the post-crash bytes, exactly as J3 does:
 * `createStoreDependencies` is the factory the daemon itself boots from, so a provider that
 * stopped wiring reconciliation is visible here rather than passing as a clean sweep.
 */
function sweepShippedReconciliation(
  storePath: string,
): { readonly result: BootReconciliationResult | null; readonly wired: boolean } {
  const provider = createStoreDependencies({
    clock: () => "2026-01-01T00:00:00.000Z",
    credential: CREDENTIAL,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    storePath,
  });
  try {
    const factory = provider.reconciliation;
    if (typeof factory !== "function") return { result: null, wired: false };
    return { result: factory.call(provider).sweep(), wired: true };
  } finally {
    provider.close();
  }
}

afterAll(() => {
  cleanupSeamHarnesses();
  for (const root of [...scratchRoots]) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    scratchRoots.splice(scratchRoots.indexOf(root), 1);
  }
});

it("leaves a reserved attempt the restart sweep classifies, and no orphan behind", async () => {
  const scratch = dispatchScratch();
  // GENESIS FIRST, on a store with no history at all — `ensureGenesisRecoveryBinding`
  // refuses to install onto a store that already carries history, and a daemon booted
  // against a pre-seeded store answers DAEMON_ENTRY_PROVIDER_THREW. Measured, not assumed.
  const installer = createStoreDependencies({
    clock: () => "2026-01-01T00:00:00.000Z", credential: CREDENTIAL,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, storePath: scratch.storePath,
  });
  try {
    seedFoundationStore(scratch.storePath);
  } finally {
    installer.close();
  }
  const daemon = await startDaemon(scratch, {
    MOE_FOUNDATION_WORKSPACE_CATALOG: FOUNDATION_SEAM_CATALOG_PATH,
  });
  const daemonPid = daemon.pid;
  let restarted: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    // The control that keeps the poll below honest: nothing is in flight before the client
    // dispatches, so a non-empty set afterwards can only be this dispatch's own reservation.
    expect(inFlightCount(scratch.storePath)).toBe(0);

    // Fired, NOT awaited: awaiting it would let the dispatch finish and leave nothing in
    // flight to reconcile. The rejection is swallowed on purpose — the daemon is about to
    // die under it, and a dead socket is the expected end of this request.
    const pending = fetch(`${daemon.origin}/command`, {
      body: JSON.stringify(dispatchEnvelope()),
      headers: {
        "content-type": "application/json",
        origin: daemon.origin,
        "x-moe-csrf": CSRF_TOKEN,
        "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": CREDENTIAL,
      },
      method: "POST",
    }).then(async (response) => JSON.stringify(await response.json()))
      .catch((error: unknown) => `transport ended: ${String(error)}`);

    let reserved = false;
    for (let poll = 0; poll < RESERVED_POLLS && !reserved; poll += 1) {
      reserved = inFlightCount(scratch.storePath) > 0;
      if (!reserved) await sleep(POLL_INTERVAL_MS);
    }
    // The window is the whole point: without a reserved-but-unrecorded attempt this case
    // would sweep an empty set and assert nothing J3 has not already asserted.
    // The answer is carried into the message so a dispatch that REFUSED instead of
    // reserving names its own code here rather than reading as a timing miss.
    const answer = reserved ? "(still in flight)" : await pending;
    expect(reserved, `answer: ${answer} | daemon: ${daemon.output()}`).toBe(true);

    await killTree(daemon.child);
    await pending;

    // The crash left work behind, read from the durable store rather than inferred.
    const store = SqliteEventStore.openForProject(scratch.storePath, PROJECT_ID);
    try {
      const sweep = readInFlightFoundationAttempts(store, PROJECT_ID);
      expect(sweep.ok).toBe(true);
      if (!sweep.ok) return;
      // EXACTLY one in-flight attempt: the dispatch reserved once and never recorded.
      expect(sweep.attempts.length).toBe(1);
    } finally {
      store.close();
    }

    // The SHIPPED sweep over those same bytes, and the count is the assertion: `wired` and
    // `result` stay separate so "the port was deleted" cannot pass for "the sweep was clean".
    const swept = sweepShippedReconciliation(scratch.storePath);
    expect(swept.wired).toBe(true);
    expect(swept.result).toMatchObject({ ok: true });
    if (swept.result === null || !swept.result.ok) return;
    // EXACTLY one: the crash left one reserved attempt, so the sweep classifies one
    // record. A `> 0` bound would also pass if a later change started classifying
    // unrelated work, which is the drift this count exists to catch.
    expect(swept.result.classified).toBe(1);

    // The daemon comes back on the SAME store after the sweep classified the crash.
    restarted = await startDaemon(scratch, {
      MOE_FOUNDATION_WORKSPACE_CATALOG: FOUNDATION_SEAM_CATALOG_PATH,
    });
    expect(restarted.origin).toMatch(/^http:\/\//u);
  } finally {
    if (restarted !== null) await killTree(restarted.child);
    await killTree(daemon.child);
  }

  // No orphan: the reap is waited for, never sampled — `taskkill /T /F` returns once the
  // kill is REQUESTED and the pid stays visible for a moment afterwards.
  expect(await pidReaped(daemonPid)).toBe(true);
  expect(pidIsAlive(process.pid)).toBe(true);
}, 180_000);
