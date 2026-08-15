import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * A store directory that has never served a workload.
 *
 * `restoreHarness` seeds four project commands, which is authoritative history —
 * and the store's genesis installer refuses to mint a FIRST binding over a store
 * that has already served one, because a deleted or corrupted binding row must
 * not let such a store silently re-fence itself. The two cases below never wanted
 * that history; they want the first-boot path, so they get a genuinely new
 * directory. Registered on `closers` BEFORE the provider so teardown pops the
 * SQLite handle first: on Windows an open handle makes rmSync throw EPERM.
 */
function pristineStorePath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `moe-reach-${label}-`));
  closers.push(() => rmSync(root, { force: true, recursive: true }));
  return join(root, "project.db");
}

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

  it("classifies a FRESH production store as genesis-fenced, not unreadable", async () => {
    // The task's original live symptom, reproduced through the exact surface
    // that produced it: a fresh createStoreDependencies followed by
    // provider.restore().inspect() returned RESTORE_RECORD_UNREADABLE, because
    // readInstalledRestore assumed every ACTIVE payload was a restore record.
    // Nothing here installs a row by hand — the provider's own genesis installer
    // writes it — so this proves the INSTALLER and the classifier agree, not
    // merely that the decoder can read bytes a fixture wrote.
    const h = await restoreHarness("reach-genesis");
    h.store.close();

    const provider = dependenciesFor(h.storePath);
    const inspection = provider.restore().inspect();

    expect(inspection).toMatchObject({ ok: true, outcome: "GENESIS_FENCED" });
    expect(inspection).not.toMatchObject({ code: "RESTORE_RECORD_UNREADABLE" });
    expect(inspection).not.toMatchObject({ outcome: "ABSENT" });
    provider.close();
    closers.pop();

    // And again on a second boot through a fresh provider: the genesis anchor is
    // re-offered, recognised as a repeat, and the classification stays stable.
    const reopened = dependenciesFor(h.storePath);
    expect(reopened.restore().inspect()).toMatchObject({
      ok: true,
      outcome: "GENESIS_FENCED",
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
