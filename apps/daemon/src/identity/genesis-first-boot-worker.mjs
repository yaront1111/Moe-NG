import { parentPort, workerData } from "node:worker_threads";

import { SqliteEventStore } from "@moe/store";

import { ensureGenesisRecoveryBinding } from "./genesis-recovery-binding.js";

/**
 * Genesis first-boot machinery that CANNOT run inside vitest.
 *
 * vitest rewrites a `./foo.js` specifier back to `foo.ts` and resolves workspace
 * packages through its own aliasing; Node does neither. A missing `.js` bridge or
 * an undeclared workspace dependency is therefore invisible to every in-repo
 * suite and only a real Node runtime sees it. Both entry modes below reach
 * production through the bare `@moe/store` specifier and the `.js` bridges for
 * exactly that reason.
 *
 * WORKER-THREAD mode (`parentPort !== null`) serves the concurrent-install race.
 * The store handle is wrapped so the FIRST `readRecoveryBinding` reports what it
 * observed and then blocks on a shared gate; both handles are released only once
 * both have observed the same absent slot. That turns a probabilistic collision
 * into a deterministic one without reimplementing one line of the production
 * flow — every call still lands on the real `SqliteEventStore`. The wrapper also
 * ECHOES what the store's own installer answered, so the driver can assert on
 * the durable commits rather than on genesis's summary of them.
 */

const CLOCK_ISO = "2026-08-15T00:00:00.000Z";

/** What the store's installer actually answered, echoed for the driver. */
function newInstallLog() {
  return { digest: null, outcome: null };
}

function recordInstall(log, result) {
  log.outcome = result.ok ? result.outcome : "REFUSED";
  log.digest = result.ok && result.bindingDigest !== undefined ? result.bindingDigest : null;
  return result;
}

/** Genesis calls the slot twice: the pre-mint read and the post-install read-back. */
function gatedStore(store, gate, log) {
  let reads = 0;
  return {
    commitExpectedVersionDecision: (input) => store.commitExpectedVersionDecision(input),
    installInitialRecoveryBinding: (input) =>
      recordInstall(log, store.installInitialRecoveryBinding(input)),
    installRecoveryBinding: (input) => recordInstall(log, store.installRecoveryBinding(input)),
    readCommandDecisionsAfter: (cursor, limit) => store.readCommandDecisionsAfter(cursor, limit),
    readRecoveryBinding: (slot) => {
      const read = store.readRecoveryBinding(slot);
      reads += 1;
      if (reads > 1) return read;
      // Reported BEFORE blocking so the driver can prove both handles really did
      // observe an absent slot; a collision nobody can see is not a race test.
      parentPort.postMessage({ kind: "OBSERVED", observed: read.ok ? read.outcome : read.code });
      Atomics.wait(gate, 1, 0);
      return read;
    },
  };
}

function reportOf(result, label, log) {
  const base = { installDigest: log.digest, installOutcome: log.outcome, kind: "RESULT", label };
  if (!result.ok) {
    return Object.freeze({ ...base, code: result.code, ok: false, outcome: "REFUSED",
      storeCode: result.storeCode });
  }
  const bound = result.outcome === "DEFERRED" ? null : result.binding;
  return Object.freeze({
    ...base,
    incarnationRef: bound === null ? null : bound.recoveryIncarnationRef,
    keyEpochRef: bound === null ? null : bound.keyEpochRef,
    ok: true,
    outcome: result.outcome,
  });
}

if (parentPort !== null) {
  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage({ kind: "PREOPEN_READY" });
  Atomics.wait(gate, 0, 0);
  const store = SqliteEventStore.openForProject(workerData.databasePath, workerData.projectId);
  const log = newInstallLog();
  let report;
  try {
    report = reportOf(
      ensureGenesisRecoveryBinding(gatedStore(store, gate, log), {
        clock: () => CLOCK_ISO,
        projectId: workerData.projectId,
      }),
      workerData.label,
      log,
    );
  } catch (error) {
    report = Object.freeze({
      installDigest: log.digest,
      installOutcome: log.outcome,
      kind: "RESULT",
      label: workerData.label,
      outcome: "THREW",
      reason: String(error),
    });
  } finally {
    // Closed BEFORE the result is posted: a still-open SQLite handle makes the
    // driver's rmSync fail with EPERM on Windows and kills the vitest worker
    // outright, with zero output, reading as a native crash rather than a leak.
    store.close();
  }
  parentPort.postMessage(report);
}
