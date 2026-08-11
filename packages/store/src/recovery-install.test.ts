import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DurableStoreError, SqliteEventStore, encodeRecoveryBinding } from "./index.js";
import {
  RECOVERY_BINDING_CODEC_LAYER,
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_INSTALL_LAYERS,
  RECOVERY_INSTALL_REASON_CODES,
  RECOVERY_INSTALL_TRANSACTION_LAYER,
} from "./recovery-install-contracts.js";
import type { RecoveryBindingReadResult, RecoveryInstallResult } from "./recovery-install-contracts.js";

const encoder = new TextEncoder();
const REF_X = "1a".repeat(32);
const REF_Y = "2b".repeat(32);
const REF_Z = "3c".repeat(32);
const KEY_EPOCH = "4d".repeat(32);
const PROJECT_ID = "recovery-install-project";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `moe-recovery-install-${label}-`));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

function binding(
  slot: string,
  incarnationRef: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt: "2026-08-11T09:00:00.000Z",
    keyEpochRef: KEY_EPOCH,
    payload: encoder.encode(`binding-for-${incarnationRef}`),
    slot,
    ...overrides,
  };
}

function installed(result: RecoveryInstallResult): { readonly digest: string } {
  expect(result.ok, result.ok ? "installed" : `${result.layer}/${result.code}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return { digest: result.bindingDigest };
}

function found(result: RecoveryBindingReadResult): {
  readonly digest: string;
  readonly incarnationRef: string;
  readonly payload: Uint8Array;
} {
  expect(result.ok).toBe(true);
  if (!result.ok || result.outcome !== "FOUND") throw new Error(`expected FOUND, got ${result.outcome}`);
  return {
    digest: result.bindingDigest,
    incarnationRef: result.binding.incarnationRef,
    payload: result.binding.payload,
  };
}

describe("recovery install transaction surface", () => {
  it("publishes exactly two layers and a closed reason-code registry", () => {
    expect(RECOVERY_INSTALL_LAYERS).toEqual([
      RECOVERY_BINDING_CODEC_LAYER,
      RECOVERY_INSTALL_TRANSACTION_LAYER,
    ]);
    expect(RECOVERY_INSTALL_REASON_CODES).toContain("RECOVERY_INSTALL_SCOPE_REQUIRED");
    expect(RECOVERY_INSTALL_REASON_CODES).toContain("RECOVERY_INSTALL_INCARNATION_CONFLICT");
    expect(RECOVERY_INSTALL_REASON_CODES).toContain("RECOVERY_BINDING_ROW_DIVERGED");
    expect(new Set(RECOVERY_INSTALL_REASON_CODES).size).toBe(RECOVERY_INSTALL_REASON_CODES.length);
  });

  it("commits a binding into each slot and reads it back durably", () => {
    const path = databasePath("durable");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    let activeDigest: string;
    try {
      activeDigest = installed(store.installRecoveryBinding(binding("ACTIVE", REF_X))).digest;
      installed(store.installRecoveryBinding(binding("PENDING", REF_Y)));
      expect(found(store.readRecoveryBinding("ACTIVE")).incarnationRef).toBe(REF_X);
    } finally {
      store.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const active = found(reopened.readRecoveryBinding("ACTIVE"));
      expect(active.incarnationRef).toBe(REF_X);
      expect(active.digest).toBe(activeDigest);
      expect(active.payload).toEqual(encoder.encode(`binding-for-${REF_X}`));
      expect(found(reopened.readRecoveryBinding("PENDING")).incarnationRef).toBe(REF_Y);
    } finally {
      reopened.close();
    }
  });

  it("replaces the occupant of one slot without disturbing the other", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      installed(store.installRecoveryBinding(binding("ACTIVE", REF_X)));
      installed(store.installRecoveryBinding(binding("PENDING", REF_Y)));
      installed(store.installRecoveryBinding(binding("ACTIVE", REF_Z)));
      expect(found(store.readRecoveryBinding("ACTIVE")).incarnationRef).toBe(REF_Z);
      expect(found(store.readRecoveryBinding("PENDING")).incarnationRef).toBe(REF_Y);
    } finally {
      store.close();
    }
  });

  it("leaves the prior binding intact when an install fails mid-transaction", () => {
    const path = databasePath("interrupted");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    let priorDigest: string;
    try {
      priorDigest = installed(store.installRecoveryBinding(binding("ACTIVE", REF_X))).digest;
      installed(store.installRecoveryBinding(binding("PENDING", REF_Y)));

      // REF_Y is already held by PENDING, so the row insert fails AFTER the slot
      // has been cleared. Nothing here injects the failure: the store's own
      // uniqueness constraint is what interrupts the install half-way.
      const refused = store.installRecoveryBinding(binding("ACTIVE", REF_Y));
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("RECOVERY_INSTALL_INCARNATION_CONFLICT");
      expect(refused.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      expect(refused.truth).toBe("UNKNOWN");

      const active = found(store.readRecoveryBinding("ACTIVE"));
      expect(active.incarnationRef).toBe(REF_X);
      expect(active.digest).toBe(priorDigest);
    } finally {
      store.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const active = found(reopened.readRecoveryBinding("ACTIVE"));
      expect(active.incarnationRef).toBe(REF_X);
      expect(active.digest).toBe(priorDigest);
      expect(active.payload).toEqual(encoder.encode(`binding-for-${REF_X}`));
      expect(found(reopened.readRecoveryBinding("PENDING")).incarnationRef).toBe(REF_Y);
    } finally {
      reopened.close();
    }
  });

  it("refuses at the transaction layer before the codec ever sees an unscoped install", () => {
    const store = SqliteEventStore.open(databasePath("unscoped"));
    try {
      for (const [name, input] of [
        ["well-formed binding", binding("ACTIVE", REF_X)],
        ["malformed binding", { slot: "ARCHIVE" }],
      ] as const) {
        const refused = store.installRecoveryBinding(input);
        expect(refused.ok, name).toBe(false);
        if (refused.ok) continue;
        expect(refused.code, name).toBe("RECOVERY_INSTALL_SCOPE_REQUIRED");
        expect(refused.layer, name).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      }
    } finally {
      store.close();
    }
  });

  it("refuses a malformed binding at the codec layer once the handle is scoped", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      for (const [name, input, code] of [
        ["unknown slot", binding("ARCHIVE", REF_X), "RECOVERY_BINDING_FIELD_INVALID"],
        ["extra key", binding("ACTIVE", REF_X, { authority: "GRANTED" }), "RECOVERY_BINDING_SHAPE_INVALID"],
        [
          "unsupported codec version",
          binding("ACTIVE", REF_X, { bindingCodecVersion: "moe-recovery-binding/9" }),
          "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED",
        ],
      ] as const) {
        const refused = store.installRecoveryBinding(input);
        expect(refused.ok, name).toBe(false);
        if (refused.ok) continue;
        expect(refused.code, name).toBe(code);
        expect(refused.layer, name).toBe(RECOVERY_BINDING_CODEC_LAYER);
      }
      expect(store.readRecoveryBinding("ACTIVE").outcome).toBe("ABSENT");
    } finally {
      store.close();
    }
  });

  it("answers an empty slot as ABSENT and an unknown slot as a codec refusal", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const absent = store.readRecoveryBinding("PENDING");
      expect(absent.ok).toBe(true);
      expect(absent.outcome).toBe("ABSENT");

      const refused = store.readRecoveryBinding("ARCHIVE");
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("RECOVERY_BINDING_FIELD_INVALID");
      expect(refused.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
    } finally {
      store.close();
    }
  });

  it("refuses a tampered stored row rather than repairing it", () => {
    const path = databasePath("tampered");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      installed(store.installRecoveryBinding(binding("ACTIVE", REF_X)));
    } finally {
      store.close();
    }

    const tamper = new DatabaseSync(path);
    try {
      const changed = tamper
        .prepare("UPDATE recovery_bindings SET binding_bytes = ? WHERE slot = ?")
        .run(encoder.encode("not-a-binding"), "ACTIVE");
      expect(Number(changed.changes)).toBe(1);
    } finally {
      tamper.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const refused = reopened.readRecoveryBinding("ACTIVE");
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");
      expect(refused.layer).toBe(RECOVERY_BINDING_CODEC_LAYER);
    } finally {
      reopened.close();
    }
  });

  it("refuses a row whose indexed columns diverge from the bytes they index", () => {
    const drifts: readonly (readonly [string, string, string])[] = [
      ["incarnation ref", "incarnation_ref", REF_Z],
      ["key epoch ref", "key_epoch_ref", "5e".repeat(32)],
      ["codec version", "binding_codec_version", "moe-recovery-binding/9"],
    ];
    expect(drifts.length).toBe(3);

    for (const [name, column, value] of drifts) {
      const path = databasePath(`diverged-${column}`);
      const store = SqliteEventStore.openForProject(path, PROJECT_ID);
      try {
        installed(store.installRecoveryBinding(binding("ACTIVE", REF_X)));
      } finally {
        store.close();
      }

      // Only the COLUMN moves. binding_bytes and binding_digest still agree
      // with each other, so the codec's own integrity gate cannot see this.
      const tamper = new DatabaseSync(path);
      try {
        const changed = tamper
          .prepare(`UPDATE recovery_bindings SET ${column} = ? WHERE slot = ?`)
          .run(value, "ACTIVE");
        expect(Number(changed.changes), name).toBe(1);
      } finally {
        tamper.close();
      }

      const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
      try {
        const refused = reopened.readRecoveryBinding("ACTIVE");
        expect(refused.ok, name).toBe(false);
        if (refused.ok) continue;
        expect(refused.code, name).toBe("RECOVERY_BINDING_ROW_DIVERGED");
        expect(refused.layer, name).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
      } finally {
        reopened.close();
      }
    }
  });

  it("refuses a row whose stored bytes name a slot other than the one it is filed under", () => {
    const path = databasePath("diverged-slot");
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      installed(store.installRecoveryBinding(binding("ACTIVE", REF_X)));
    } finally {
      store.close();
    }

    // The bytes of a record identical to the stored one EXCEPT its slot.
    const foreign = encodeRecoveryBinding(binding("PENDING", REF_X));
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error(`expected encoded bytes, got ${foreign.layer}/${foreign.code}`);

    // POSITIVE CONTROL, so the refusal below cannot be an earlier layer
    // answering: filed under the slot they name, these exact bytes are what
    // production itself writes, and they read back FOUND.
    const control = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      expect(installed(control.installRecoveryBinding(binding("PENDING", REF_X))).digest).toBe(
        foreign.digest,
      );
      expect(found(control.readRecoveryBinding("PENDING")).incarnationRef).toBe(REF_X);
    } finally {
      control.close();
    }

    // Bytes AND digest move together, so they still agree; incarnation_ref,
    // key_epoch_ref and binding_codec_version are untouched and still agree with
    // the bytes too. Nothing but the slot cross-check can see this row: the
    // decoded bytes are the authority, not the key the row is filed under.
    const tamper = new DatabaseSync(path);
    try {
      const changed = tamper
        .prepare("UPDATE recovery_bindings SET binding_bytes = ?, binding_digest = ? WHERE slot = ?")
        .run(foreign.bytes, foreign.digest, "ACTIVE");
      expect(Number(changed.changes)).toBe(1);
    } finally {
      tamper.close();
    }

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      const refused = reopened.readRecoveryBinding("ACTIVE");
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("RECOVERY_BINDING_ROW_DIVERGED");
      expect(refused.layer).toBe(RECOVERY_INSTALL_TRANSACTION_LAYER);
    } finally {
      reopened.close();
    }
  });

  it("raises a durable store fault, not a refusal, once the handle is closed", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    store.close();
    for (const run of [
      () => store.installRecoveryBinding(binding("ACTIVE", REF_X)),
      () => store.readRecoveryBinding("ACTIVE"),
    ]) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DurableStoreError);
      expect((caught as DurableStoreError).code).toBe("STORE_CLOSED");
    }
  });
});
