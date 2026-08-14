import { describe, expect, it, afterEach } from "vitest";

import { SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionRecord,
  CursorPage,
  RecoveryBindingReadResult,
  RecoveryInstallResult,
} from "@moe/store";

import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createSessionAuthenticator } from "./session-authenticator.js";
import {
  GENESIS_RECOVERY_ERROR_CODES,
  ensureGenesisRecoveryBinding,
} from "./genesis-recovery-binding.js";
import { readCurrentRecoveryAuthenticationBinding } from "./recovery-authentication-binding.js";
import {
  decodeBinding,
  encodeBinding,
} from "../recovery/recovery-incarnation-binding-codec.js";
import {
  readAnchoredGenesisIncarnation,
  readAnchoredIncarnation,
} from "../recovery/recovery-incarnation-anchor.js";
import { mintGenesisIncarnation } from "../recovery/recovery-incarnation-genesis.js";
import {
  PROJECT_ID,
  closeStores,
  installTestRecoveryBinding,
  openUnboundStore,
} from "./session-test-fixtures.js";

const CLOCK = (): string => "2026-08-14T00:00:00.000Z";
const OPERATOR_CREDENTIAL = "operator-first-boot-credential";

type DecisionPage = CursorPage<CommandDecisionRecord, bigint>;
const NO_DECISIONS: DecisionPage = Object.freeze({
  hasMore: false, items: [], nextCursor: null,
}) as unknown as DecisionPage;

const ABSENT_SLOT: RecoveryBindingReadResult = Object.freeze({
  ok: true as const, outcome: "ABSENT" as const, slot: "ACTIVE" as const,
}) as unknown as RecoveryBindingReadResult;

/** Anchor rows this project actually committed, read straight off the store. */
function anchorRowCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 100).items.filter(
    (decision) =>
      decision.commandKind === "recovery.incarnate" &&
      decision.effectDisposition === "EFFECTS_COMMITTED" &&
      decision.key.projectId === PROJECT_ID,
  ).length;
}

/**
 * The bytes the installer OFFERS, captured before the store accepts them. The
 * install is refused on purpose: the payload is what is under test, and
 * refusing keeps this helper on the pre-install path no matter what the
 * installer later does after a successful write.
 */
function capturedGenesisPayload(): Uint8Array | null {
  let payload: Uint8Array | null = null;
  const store = {
    installRecoveryBinding: (input: unknown): RecoveryInstallResult => {
      payload = (input as { payload: Uint8Array }).payload;
      return Object.freeze({
        ok: false as const, code: "RECOVERY_INSTALL_SCOPE_REQUIRED", layer: "STORE",
      }) as unknown as RecoveryInstallResult;
    },
    commitExpectedVersionDecision: (): never => {
      throw new Error("must not anchor");
    },
    readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
    readRecoveryBinding: (): RecoveryBindingReadResult => ABSENT_SLOT,
  };
  ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
  return payload;
}

function requireBinding(result: ReturnType<typeof ensureGenesisRecoveryBinding>) {
  if (!result.ok) throw new Error(`genesis refused: ${result.code}`);
  if (result.outcome === "DEFERRED") throw new Error("genesis unexpectedly deferred");
  return result;
}

afterEach(closeStores);

function operatorAuthenticator(store: SqliteEventStore) {
  return createSessionAuthenticator(store, {
    clock: () => Date.parse("2026-08-14T00:00:00.000Z"),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: OPERATOR_CREDENTIAL,
    operatorPrincipalId: "operator-local",
    projectId: PROJECT_ID,
  });
}

describe("genesis recovery binding — first boot", () => {
  it("a fresh store refuses the operator until genesis installs the binding", () => {
    const store = openUnboundStore();
    const authenticator = operatorAuthenticator(store);

    // The deadlock this module exists to break: valid operator credential,
    // fresh store, no restore has ever run — authentication is impossible.
    expect(authenticator.authenticate(OPERATOR_CREDENTIAL).verdict).toBe("UNAUTHENTICATED");

    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
    if (!result.ok) throw new Error(`genesis refused: ${result.code}`);
    expect(result.outcome).toBe("INSTALLED");

    expect(authenticator.authenticate(OPERATOR_CREDENTIAL).verdict).toBe("AUTHENTICATED");
  });

  it("installs exactly the binding the authenticator reads back", () => {
    const store = openUnboundStore();
    const result = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    const current = readCurrentRecoveryAuthenticationBinding(store);
    expect(current).not.toBeNull();
    expect(current?.recoveryIncarnationRef).toBe(result.binding.recoveryIncarnationRef);
    expect(current?.keyEpochRef).toBe(result.binding.keyEpochRef);
  });

  it("a second boot keeps the installed binding instead of re-minting", () => {
    // Re-minting on reboot would silently revoke every outstanding session.
    const store = openUnboundStore();
    const first = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    const second = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    expect(second.outcome).toBe("PRESENT");
    expect(second.binding.recoveryIncarnationRef).toBe(first.binding.recoveryIncarnationRef);
    expect(second.binding.keyEpochRef).toBe(first.binding.keyEpochRef);
  });

  it("never overwrites a restore-installed binding", () => {
    const store = openUnboundStore();
    installTestRecoveryBinding(store);
    const result = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    expect(result.outcome).toBe("PRESENT");
    expect(result.binding.recoveryIncarnationRef).toBe("71".repeat(32));
    expect(result.binding.keyEpochRef).toBe("72".repeat(32));
  });

  it("persists the SHARED mint's full canonical binding, not a bare digest", () => {
    // A 64-hex context digest carries no signature, no public key and no origin
    // tag, so no later reader could ever VERIFY the fence — it could only take
    // the row's word for it. The canonical codec is what makes the installed
    // bytes checkable evidence rather than an assertion.
    const independent = mintGenesisIncarnation(PROJECT_ID);
    if (!independent.ok) throw new Error(`the shared mint must succeed: ${independent.code}`);
    const payload = capturedGenesisPayload();
    expect(payload).not.toBeNull();

    const decoded = decodeBinding(payload!);
    if (decoded === null) throw new Error("the persisted payload must decode canonically");
    expect(decoded.origin).toBe("GENESIS");
    if (decoded.origin !== "GENESIS") throw new Error("unreachable");
    // Stable across boots — derived from the project, not from this mint.
    expect(decoded.storeContextDigest).toBe(independent.binding.storeContextDigest);
    expect(decoded.projectId).toBe(PROJECT_ID);
    // The proof itself is on disk, which is the whole point of the change.
    expect(decoded.proof.verified).toBe(true);
    expect(decoded.proof.signatureHex).toMatch(/^[0-9a-f]{2,}$/);
    expect(decoded.publicKeySpkiHex).toMatch(/^[0-9a-f]{2,}$/);
    expect(decoded.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists no private key, key handle or raw nonce", () => {
    const payload = capturedGenesisPayload();
    if (payload === null) throw new Error("the installer must have offered a payload");
    const text = new TextDecoder().decode(payload);
    for (const forbidden of [
      "privateKey", "PRIVATE KEY", "pkcs8", "PKCS8", "keyHandle", "handle", "entropy", "nonce",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // Exact key set, so a future field cannot smuggle secret material in
    // without this assertion noticing it.
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "bindingDigest", "incarnationDigest", "incarnationRef", "keyEpochRef", "origin",
      "projectId", "proof", "publicKeyAlgorithm", "publicKeySpkiHex", "schemaVersion",
      "storeContextDigest", "verificationKeyFingerprint",
    ]);
  });

  it("anchors the installed genesis incarnation durably, under its OWN reader", () => {
    // DoD-1 requires the persisted fence to agree with a durable anchor. Without
    // this write the row is a claim nobody ever observed the daemon make.
    const store = openUnboundStore();
    const result = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    const ref = result.binding.recoveryIncarnationRef;

    const anchored = readAnchoredGenesisIncarnation(store, PROJECT_ID, ref);
    expect(anchored).not.toBeNull();
    expect(anchored?.origin).toBe("GENESIS");
    // Byte-equal to the row, which is exactly what the classifier will compare.
    const row = store.readRecoveryBinding("ACTIVE");
    if (!row.ok || row.outcome !== "FOUND") throw new Error("the ACTIVE slot must be FOUND");
    expect([...encodeBinding(anchored!)]).toEqual([...row.binding.payload]);

    // The RESTORE reader stays blind to it: one origin per reader, so no restore
    // caller can read genesis facts off an answer it did not ask for.
    expect(readAnchoredIncarnation(store, PROJECT_ID, ref)).toBeNull();
  });

  it("re-anchoring on a second boot is idempotent, not a conflict", () => {
    const store = openUnboundStore();
    const first = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    const second = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );
    expect(second.outcome).toBe("PRESENT");
    expect(anchorRowCount(store)).toBe(1);
    expect(readAnchoredGenesisIncarnation(store, PROJECT_ID, first.binding.recoveryIncarnationRef))
      .not.toBeNull();
  });

  it("DEFERS rather than re-minting once its own anchor exists and the slot is cleared", () => {
    // A DELIBERATE consequence of anchoring genesis, not an accident: after this
    // change hasAnchoredIncarnation is true for a genesis store, so a cleared
    // ACTIVE slot reads as recovery history rather than as a fresh store. That is
    // correct — a store that has been fenced once must not be silently re-fenced,
    // which would revoke every outstanding session — but it must be recorded.
    const store = openUnboundStore();
    requireBinding(ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }));

    // The REAL anchor rows, read by the real reader; only the slot is cleared.
    let installs = 0;
    const cleared = {
      commitExpectedVersionDecision: (): never => {
        throw new Error("must not anchor while deferring");
      },
      installRecoveryBinding: (): RecoveryInstallResult => {
        installs += 1;
        throw new Error("must not re-mint over recovery history");
      },
      readCommandDecisionsAfter: (cursor: bigint, limit: number): DecisionPage =>
        store.readCommandDecisionsAfter(cursor, limit),
      readRecoveryBinding: (): RecoveryBindingReadResult => ABSENT_SLOT,
    };
    const result = ensureGenesisRecoveryBinding(cleared, { clock: CLOCK, projectId: PROJECT_ID });
    expect(installs).toBe(0);
    if (!result.ok) throw new Error(`expected DEFERRED, got ${result.code}`);
    expect(result.outcome).toBe("DEFERRED");
  });

  it("two fresh stores mint distinct incarnations", () => {
    const a = requireBinding(ensureGenesisRecoveryBinding(openUnboundStore(), {
      clock: CLOCK, projectId: PROJECT_ID,
    }));
    const b = requireBinding(ensureGenesisRecoveryBinding(openUnboundStore(), {
      clock: CLOCK, projectId: PROJECT_ID,
    }));
    expect(a.binding.recoveryIncarnationRef).not.toBe(b.binding.recoveryIncarnationRef);
    expect(a.binding.keyEpochRef).not.toBe(b.binding.keyEpochRef);
  });
});

describe("genesis recovery binding — fail closed", () => {
  const FOUND_GARBAGE: RecoveryBindingReadResult = Object.freeze({
    code: "RECOVERY_BINDING_DIGEST_MISMATCH",
    layer: "STORE",
    ok: false,
  }) as unknown as RecoveryBindingReadResult;

  it("refuses to mint over an unreadable slot", () => {
    // A slot that refuses to decode is corruption, not absence: minting a fresh
    // incarnation on top of it would convert an integrity fault into authority.
    const store = {
      installRecoveryBinding: (): RecoveryInstallResult => {
        throw new Error("must not install over a corrupt slot");
      },
      commitExpectedVersionDecision: (): never => {
      throw new Error("must not anchor");
    },
    readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult => FOUND_GARBAGE,
    };
    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GENESIS_SLOT_UNREADABLE");
    // Which layer refused, not merely that something did: the store's own code
    // is carried through rather than collapsed into the genesis code.
    expect(result.storeCode).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");
    expect(GENESIS_RECOVERY_ERROR_CODES).toContain(result.code);
  });

  it("surfaces an install refusal instead of claiming authority", () => {
    const refused = Object.freeze({
      code: "RECOVERY_INSTALL_SCOPE_REQUIRED", layer: "STORE", ok: false,
    }) as unknown as RecoveryInstallResult;
    let installs = 0;
    const store = {
      installRecoveryBinding: (): RecoveryInstallResult => {
        installs += 1;
        return refused;
      },
      commitExpectedVersionDecision: (): never => {
      throw new Error("must not anchor");
    },
    readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult =>
        Object.freeze({ ok: true as const, outcome: "ABSENT" as const, slot: "ACTIVE" as const }),
    };
    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
    expect(installs).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GENESIS_INSTALL_REFUSED");
    expect(result.storeCode).toBe("RECOVERY_INSTALL_SCOPE_REQUIRED");
  });

  it("refuses instead of claiming an INSTALLED fence its anchor never committed", () => {
    // An unanchored genesis row is exactly what the classifier must refuse, so
    // reporting INSTALLED here would hand the daemon a fence that boots and then
    // fails every restore inspection with no explanation at the failure site.
    const store = openUnboundStore();
    const blocked = {
      // The documented false path: the store RETURNS the version conflict as a
      // NO_BUSINESS_EFFECT decision rather than throwing.
      commitExpectedVersionDecision: (): unknown =>
        Object.freeze({ decision: Object.freeze({ effectDisposition: "NO_BUSINESS_EFFECT" }) }),
      installRecoveryBinding: (input: unknown): RecoveryInstallResult =>
        store.installRecoveryBinding(input),
      readCommandDecisionsAfter: (cursor: bigint, limit: number): DecisionPage =>
        store.readCommandDecisionsAfter(cursor, limit),
      readRecoveryBinding: (slot: unknown): RecoveryBindingReadResult =>
        store.readRecoveryBinding(slot),
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];
    const result = ensureGenesisRecoveryBinding(blocked, { clock: CLOCK, projectId: PROJECT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GENESIS_ANCHOR_REFUSED");
    expect(result.storeCode).toBe("ANCHOR_NOT_COMMITTED");
    expect(GENESIS_RECOVERY_ERROR_CODES).toContain(result.code);
  });

  it("defers to a restore waiting to quiesce instead of stealing the slot", () => {
    // An anchored incarnation with an empty ACTIVE slot is recovery history:
    // the restore controller owns that install, and a genesis mint here would
    // fence the store against the very incarnation the restore is proving.
    const anchorRow = {
      commandKind: "recovery.incarnate",
      effectDisposition: "EFFECTS_COMMITTED",
      key: { projectId: PROJECT_ID },
    } as unknown as CommandDecisionRecord;
    const anchoredPage = Object.freeze({
      hasMore: false, items: [anchorRow], nextCursor: null,
    }) as unknown as DecisionPage;
    let installs = 0;
    const store = {
      installRecoveryBinding: (): RecoveryInstallResult => {
        installs += 1;
        throw new Error("must not install while a restore is pending");
      },
      commitExpectedVersionDecision: (): never => {
        throw new Error("must not anchor");
      },
      readCommandDecisionsAfter: (): DecisionPage => anchoredPage,
      readRecoveryBinding: (): RecoveryBindingReadResult =>
        Object.freeze({ ok: true as const, outcome: "ABSENT" as const, slot: "ACTIVE" as const }),
    };
    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
    expect(installs).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.outcome).toBe("DEFERRED");
  });
});
