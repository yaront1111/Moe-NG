import { afterEach, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import {
  PROJECT_ID,
  anchorInto,
  cleanupRestoreHarnesses,
  committedEventTypes,

  restoreHarness,
  restoreRequest,
} from "./restore-test-harness.js";

/**
 * DoD 2: `recovery.restore_quiesce` must have a production caller reachable
 * from the daemon's own entry surface.
 *
 * This file deliberately imports NO module under `./restore-controller*`. An
 * `import { runRestoreQuiesce }` would prove the module exists, which was never
 * in doubt; it would prove nothing about anything IMPORTING it in production.
 * Everything below resolves the controller the way the daemon resolves it at
 * runtime — through `createStoreDependencies`, the factory the source-run bin's
 * `--dependencies=src/daemon-store-dependencies.ts` provider itself calls.
 *
 * Removing the wiring in that provider must turn THIS file red while a direct
 * import test would still pass. That asymmetry is the whole assertion.
 */

const closers: (() => void)[] = [];

afterEach(() => {
  while (closers.length > 0) {
    try {
      closers.pop()?.();
    } catch {
      /* a provider that already released its handles is still released */
    }
  }
  cleanupRestoreHarnesses();
});

function dependenciesFor(storePath: string): ReturnType<typeof createStoreDependencies> {
  const provider = createStoreDependencies({
    credential: "operator-secret-1",
    principalId: "principal-1",
    projectId: PROJECT_ID,
    storePath,
  });
  closers.push(() => provider.close());
  return provider;
}

describe("recovery.restore_quiesce reachability from the daemon entry surface", () => {
  it("exposes a restore port on the provider the daemon bin loads", async () => {
    const h = await restoreHarness("reach-port");
    h.store.close();

    const provider = dependenciesFor(h.storePath);
    const entryModule = await import("../daemon-store-dependencies." + "ts");

    expect(typeof entryModule.default.restore).toBe("function");
    expect(typeof provider.restore).toBe("function");
    // The command adapter surface is untouched: this is internal authority, and
    // the core contract is explicit that restore_quiesce is not a protocol command.
    expect([...provider.provide().registry.keys()]).not.toContain("recovery.restore_quiesce");
  });

  it("drives the core reducer through the provider, never through a direct import", async () => {
    const h = await restoreHarness("reach-drive");
    const binding = await h.mint(h.generationDigest, "restore-cmd-1");
    anchorInto(h.store, binding);
    h.store.close();

    const provider = dependenciesFor(h.storePath);
    const result = provider.restore().resume(restoreRequest(h, binding));

    if (!result.ok || result.disposition !== "QUIESCED") {
      throw new Error("expected the provider-resolved controller to quiesce");
    }
    expect(result.event).toMatchObject({
      commandId: "restore-cmd-1",
      kind: "ProjectQuiesced",
      witness: { recoveryIncarnationRef: binding.incarnationRef, truthClass: "DAEMON_VERIFIED" },
    });
    provider.close();
    closers.pop();

    // The durable proof, read back through a fresh handle: the reducer's event
    // and the installed binding are both on disk, committed by that one call.
    const reopened = dependenciesFor(h.storePath);
    expect(reopened.restore().inspect()).toMatchObject({
      ok: true,
      outcome: "INSTALLED",
      record: { incarnationRef: binding.incarnationRef, restoreCommandId: "restore-cmd-1" },
    });
  });

  it("surfaces a refusal through the provider with its code and its layer", async () => {
    const h = await restoreHarness("reach-refuse");
    const binding = await h.mint(h.generationDigest, "restore-cmd-1");
    anchorInto(h.store, binding);
    const eventsBefore = committedEventTypes(h.store);
    h.store.close();

    const provider = dependenciesFor(h.storePath);
    const result = provider
      .restore()
      .resume(restoreRequest(h, binding, { trust: { anchoredKeys: [] } }));

    expect(result).toMatchObject({
      authority: "NONE",
      code: "KEY_CHAIN_UNTRUSTED",
      layer: "BACKUP_GENERATION",
      ok: false,
      outcome: "REFUSED",
      truth: "UNKNOWN",
    });
    provider.close();
    closers.pop();

    const reopened = dependenciesFor(h.storePath);
    expect(reopened.restore().inspect()).toEqual({ ok: true, outcome: "ABSENT" });
    expect(eventsBefore).not.toContain("ProjectQuiesced");
  });
});
