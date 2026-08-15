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
 * CHILD-PROCESS mode (`parentPort === null`) is the DoD 5 first-boot smoke: it
 * takes a store directory that has never been restored, builds the real
 * dependency provider, authenticates once and prints a JSON verdict. It resolves
 * `../daemon-store-dependencies.js` through Node's own resolver, so a broken
 * bridge or an undeclared dependency anywhere under the daemon's composition
 * root fails HERE and nowhere else.
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
} else {
  const report = (value) => { process.stdout.write(JSON.stringify(value)); };
  const storePath = process.env.MOE_STORE_PATH ?? "";
  const projectId = process.env.MOE_PROJECT_ID ?? "";
  const credential = process.env.MOE_DAEMON_CREDENTIAL ?? "";
  if (storePath === "" || projectId === "" || credential === "") {
    // Named rather than silent: a smoke that ran against no store at all would
    // otherwise exit 0 and read as a passing first boot.
    report({ ok: false, reason: "FIRST_BOOT_SMOKE_ENV_MISSING" });
    process.exitCode = 1;
  } else {
    const { createStoreDependencies } = await import("../daemon-store-dependencies.js");
    const provider = createStoreDependencies({
      credential,
      principalId: process.env.MOE_PRINCIPAL_ID ?? "operator-local",
      projectId,
      storePath,
    });
    try {
      const result = provider.provide().authenticator.authenticate(credential);
      const inspection = provider.restore().inspect();
      report({
        capabilities: result.principal === undefined ? null : [...result.principal.capabilities],
        ok: result.verdict === "AUTHENTICATED",
        principalId: result.principal === undefined ? null : result.principal.principalId,
        projectId: result.principal === undefined ? null : result.principal.projectId,
        restoreOutcome: inspection.ok ? inspection.outcome : inspection.code,
        verdict: result.verdict,
      });
      if (result.verdict !== "AUTHENTICATED") process.exitCode = 1;
    } finally {
      // Released before the process exits so the driver's rmSync cannot race a
      // live handle on Windows.
      provider.close();
    }
  }
}
