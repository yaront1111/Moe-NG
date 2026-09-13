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
 * DISCLOSED TEST PAUSE. An explicit --dependencies fixture delegates production ports and
 * pauses only after the real workspace preparation. The production reservation therefore
 * remains readable until the parent kills the child, even if its first read is delayed.
 * The old 10ms poll sometimes missed the whole RESERVED-to-refusal interval on POSIX.
 * Controls below prove normal completion and a resumed pause both retain the exact seal
 * refusal: this crash journey does not configure a provider or claim a successful launch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  CREDENTIAL, DISPATCH_AGGREGATE, FOUNDATION_SEAM_CATALOG_PATH, cleanupSeamHarnesses, dispatchPayload,
  seedFoundationStore,
} from "../../../apps/daemon/src/http/foundation-registry-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";

import { CSRF_TOKEN, killTree, startDaemon } from "./j1-loop-harness.js";
import type { J1Scratch } from "./j1-loop-harness.js";
import { pidIsAlive } from "./j1-loop-harness.js";
import { pidReaped } from "./orphan-reap.js";
import { startCrashDaemon } from "./dispatch-crash-harness.js";

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
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    const sweep = readInFlightFoundationAttempts(store, PROJECT_ID);
    expect(sweep.ok).toBe(true);
    if (!sweep.ok) throw new Error(`${sweep.code}@${sweep.refusedBy}`);
    return sweep.attempts.length;
  } finally {
    store.close();
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

function seededScratch(): J1Scratch & { readonly catalogPath: string } {
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
  // Each run uses the real fixture repository but owns its worktree parent. The
  // crashed run cannot leave a prepared tree at a later control's attempt path.
  const worktreeParent = join(scratch.root, "worktrees");
  mkdirSync(worktreeParent);
  const catalog = JSON.parse(readFileSync(FOUNDATION_SEAM_CATALOG_PATH, "utf8")) as {
    catalogVersion: string; entries: Array<Record<string, unknown>>;
  };
  const catalogPath = join(scratch.root, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ ...catalog,
    entries: catalog.entries.map(entry => ({ ...entry, worktreeParent })) }));
  return { ...scratch, catalogPath };
}

function postDispatch(origin: string): Promise<Response> {
  return fetch(`${origin}/command`, {
    body: JSON.stringify(dispatchEnvelope()),
    headers: { "content-type": "application/json", origin, "x-moe-csrf": CSRF_TOKEN,
      "x-moe-protocol-version": WIRE_PROTOCOL_VERSION, "x-moe-session-credential": CREDENTIAL },
    method: "POST",
  });
}

it("leaves a reserved attempt the restart sweep classifies, and no orphan behind", async () => {
  const scratch = seededScratch();
  const daemon = await startCrashDaemon(scratch, scratch.catalogPath);
  const daemonPid = daemon.pid;
  let restarted: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    // The control that keeps the poll below honest: nothing is in flight before the client
    // dispatches, so a non-empty set afterwards can only be this dispatch's own reservation.
    expect(inFlightCount(scratch.storePath)).toBe(0);

    // Fired, NOT awaited: awaiting it would let the dispatch finish and leave nothing in
    // flight to reconcile. The rejection is swallowed on purpose — the daemon is about to
    // die under it, and a dead socket is the expected end of this request.
    const pending = postDispatch(daemon.origin).then(async (response) => JSON.stringify(await response.json()))
      .catch((error: unknown) => `transport ended: ${String(error)}`);
    const prepared = await daemon.prepared();
    expect(prepared).toMatchObject({ attemptId: "attempt-1", projectId: PROJECT_ID });
    // Let the daemon serve another round trip before this first observation. The
    // reservation is held by the explicit pause, independent of process scheduling.
    await fetch(`${daemon.origin}/bootstrap`);
    expect(inFlightCount(scratch.storePath)).toBe(1);

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
      expect(sweep.attempts).toMatchObject([{ attemptRef: DISPATCH_AGGREGATE,
        situation: { attemptId: prepared.attemptId } }]);
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
      MOE_FOUNDATION_WORKSPACE_CATALOG: scratch.catalogPath,
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

it.each(["production", "paused"] as const)(
  "%s completion records the real seal refusal instead of an in-flight attempt", async mode => {
    const scratch = seededScratch();
    const paused = mode === "paused" ? await startCrashDaemon(scratch, scratch.catalogPath) : null;
    const daemon = paused ?? await startDaemon(scratch, { MOE_FOUNDATION_WORKSPACE_CATALOG: scratch.catalogPath });
    let settled = false;
    const pending = postDispatch(daemon.origin).then(response => { settled = true; return response; });
    // Preserve rejection for the awaited assertion, while teardown may close the
    // socket before that assertion is reached on an earlier failure.
    void pending.catch(() => undefined);
    try {
      if (paused !== null) {
        const prepared = await paused.prepared();
        paused.resume({ ...prepared, attemptId: "another-attempt" });
        await fetch(`${daemon.origin}/bootstrap`);
        expect(settled).toBe(false);
        expect(inFlightCount(scratch.storePath)).toBe(1);
        paused.resume(prepared);
        paused.resume(prepared);
      }
      const answer = await pending;
      expect(answer.status).toBe(422);
      expect(await answer.json()).toMatchObject({ ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
        refusal: { code: "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED", layer: "FOUNDATION_CONTEXT_SEAL" } });
      // Deliberately inspect only AFTER completion: the former polling test missed
      // this interval and incorrectly expected one still-reserved attempt.
      expect(inFlightCount(scratch.storePath)).toBe(0);
      const store = SqliteEventStore.openForProject(scratch.storePath, PROJECT_ID);
      try {
        expect(store.readEvents(DISPATCH_AGGREGATE).map(event => event.eventType))
          .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
      } finally { store.close(); }
    } finally {
      await killTree(daemon.child);
      await pending.catch(() => undefined);
    }
    expect(await pidReaped(daemon.pid)).toBe(true);
  }, 180_000,
);
