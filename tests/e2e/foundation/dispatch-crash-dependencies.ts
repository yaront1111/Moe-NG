import { SqliteEventStore } from "@moe/store";
import { createDaemonCommandPorts } from "../../../apps/daemon/src/daemon-command-registry.js";
import { createDaemonFoundationWiring } from "../../../apps/daemon/src/daemon-context-seal-wiring.js";
import production, { readStoreDependencyEnv } from "../../../apps/daemon/src/daemon-store-dependencies.js";
import type { PrepareCaptureInput } from "../../../apps/daemon/src/work/foundation-capture-lifecycle.js";

/** Test-only pause after REAL workspace preparation. Neither reservation nor seal
 * authority is fabricated. The unconfigured seal still refuses when resumed.
 * This module is loaded only through this journey's explicit --dependencies path. */
function pausePrepared(input: PrepareCaptureInput): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error("DISPATCH_TEST_RESUME_TIMEOUT")), 30_000);
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off("message", resume);
      if (error === undefined) resolve(); else reject(error);
    }
    function resume(message: unknown): void {
      if (typeof message !== "object" || message === null) return;
      const value = message as Record<string, unknown>;
      if (value.kind !== "RESUME_PREPARED" || value.projectId !== input.projectId
        || value.attemptId !== input.attemptId || value.reservationDigest !== input.reservationDigest) return;
      finish();
    }
    process.on("message", resume);
    if (process.send === undefined) { finish(new Error("DISPATCH_TEST_IPC_ABSENT")); return; }
    process.send({ kind: "DISPATCH_PREPARED", projectId: input.projectId,
      attemptId: input.attemptId, reservationDigest: input.reservationDigest }, error => {
      if (error) finish(error);
    });
  });
}

// A parent that dies cannot leave this paused test daemon and its listener behind.
process.once("disconnect", () => { process.exit(1); });
const config = readStoreDependencyEnv(process.env);
const deps = production.provide();
const store = SqliteEventStore.openForProject(config.storePath, config.projectId);
const foundation = createDaemonFoundationWiring({ ...config, store });
const ports = createDaemonCommandPorts({
  ...foundation, projectId: config.projectId, operatorPrincipalId: config.principalId, store,
  // The Foundation handler takes its decision instant from the activation, not this clock.
  clock: () => { throw new Error("DISPATCH_TEST_UNRELATED_COMMAND"); },
  foundationLifecycle: {
    ...foundation.foundationLifecycle,
    prepareCapture: async input => {
      const result = await foundation.foundationLifecycle.prepareCapture(input);
      if (result.ok) await pausePrepared(input);
      return result;
    },
  },
});
const entry = ports.registry.get("foundation.dispatch");
if (entry === undefined) throw new Error("DISPATCH_TEST_ENTRY_ABSENT");
const registry = new Map(deps.registry);
registry.set("foundation.dispatch", entry);

export default Object.freeze({
  ...production,
  provide: () => Object.freeze({ ...deps, registry }),
});
