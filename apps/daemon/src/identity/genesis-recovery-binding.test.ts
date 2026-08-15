import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it, afterEach } from "vitest";

import { SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionRecord,
  CursorPage,
  RecoveryBindingReadResult,
  RecoveryInitialInstallResult,
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
  const capture = (input: unknown): { code: string; layer: string; ok: false } => {
    payload = (input as { payload: Uint8Array }).payload;
    return Object.freeze({
      code: "RECOVERY_INSTALL_SCOPE_REQUIRED", layer: "STORE", ok: false as const,
    });
  };
  const store = {
    installInitialRecoveryBinding: (input: unknown): RecoveryInitialInstallResult =>
      capture(input) as unknown as RecoveryInitialInstallResult,
    installRecoveryBinding: (input: unknown): RecoveryInstallResult =>
      capture(input) as unknown as RecoveryInstallResult,
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
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        throw new Error("must not re-mint over recovery history");
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
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        throw new Error("must not install over a corrupt slot");
      },
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
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        return refused as unknown as RecoveryInitialInstallResult;
      },
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
      installInitialRecoveryBinding: (input: unknown): RecoveryInitialInstallResult =>
        store.installInitialRecoveryBinding(input),
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

  it("accepts a LOST anchor race whose winner landed byte-identical evidence", () => {
    // anchorIncarnation reads-then-writes, so two daemons opening one store can
    // both see no anchor and both attempt one. The loser is refused by the
    // expectedVersion-0 conflict — and must NOT fail startup over an anchor that
    // did land. Only byte-identical evidence is accepted.
    const store = openUnboundStore();
    let conflicted = false;
    const racing = {
      commitExpectedVersionDecision: (input: unknown): unknown => {
        // The rival commits the SAME anchor first; this call then loses.
        if (!conflicted) {
          conflicted = true;
          store.commitExpectedVersionDecision(input as never);
        }
        return Object.freeze({ decision: Object.freeze({ effectDisposition: "NO_BUSINESS_EFFECT" }) });
      },
      installInitialRecoveryBinding: (input: unknown): RecoveryInitialInstallResult =>
        store.installInitialRecoveryBinding(input),
      installRecoveryBinding: (input: unknown): RecoveryInstallResult =>
        store.installRecoveryBinding(input),
      readCommandDecisionsAfter: (cursor: bigint, limit: number): DecisionPage =>
        store.readCommandDecisionsAfter(cursor, limit),
      readRecoveryBinding: (slot: unknown): RecoveryBindingReadResult =>
        store.readRecoveryBinding(slot),
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];

    const result = ensureGenesisRecoveryBinding(racing, { clock: CLOCK, projectId: PROJECT_ID });

    expect(conflicted).toBe(true);
    const settled = requireBinding(result);
    expect(settled.outcome).toBe("INSTALLED");
    expect(anchorRowCount(store)).toBe(1);
    expect(readAnchoredGenesisIncarnation(store, PROJECT_ID, settled.binding.recoveryIncarnationRef))
      .not.toBeNull();
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
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        throw new Error("must not install while a restore is pending");
      },
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

/**
 * The store publishes TWO installers. `installRecoveryBinding` replaces — its
 * transaction DELETEs the slot and then INSERTs — which is correct for a restore
 * succeeding a known incumbent and wrong for genesis, where two handles that both
 * observed an absent slot would both commit and the second would destroy the
 * first. `installInitialRecoveryBinding` proves the store pristine and INSERTs
 * under one write lock, answering INSTALLED, CURRENT (the exact valid winner) or
 * REFUSED, and never deleting. Genesis must route through the second one.
 */
describe("genesis recovery binding — atomic first install", () => {
  const CURRENT_WINNER_INCARNATION = "8a".repeat(32);
  const CURRENT_WINNER_KEY_EPOCH = "8b".repeat(32);

  const foundWinner: RecoveryBindingReadResult = Object.freeze({
    binding: Object.freeze({
      bindingCodecVersion: 1,
      incarnationRef: CURRENT_WINNER_INCARNATION,
      installedAt: "2026-08-15T00:00:00.000Z",
      keyEpochRef: CURRENT_WINNER_KEY_EPOCH,
      payload: new TextEncoder().encode("installed-by-a-rival-handle"),
      slot: "ACTIVE",
    }),
    bindingDigest: "8c".repeat(32),
    ok: true as const,
    outcome: "FOUND" as const,
  }) as unknown as RecoveryBindingReadResult;

  /**
   * Real durable history through the store's OWN decision seam, and deliberately
   * NOT a `recovery.incarnate` anchor: an anchored incarnation would make genesis
   * DEFER before it ever reached the installer, so the guard under test would go
   * silently unexercised. The commit is asserted, because a seed that quietly
   * committed nothing makes the refusal below unreachable and the test vacuous.
   */
  function seedAuthoritativeHistory(store: SqliteEventStore): void {
    const bytes = new TextEncoder().encode(JSON.stringify({ owner: "operator-local" }));
    const response = store.commitExpectedVersionDecision({
      commandKind: "project.register",
      committedResultBytes: bytes,
      correlationId: "corr-genesis-history",
      decidedAt: "2026-08-15T00:00:00.000Z",
      events: [
        { eventId: "evt-genesis-history", eventType: "ProjectRegistered", payload: bytes },
      ],
      expectedVersion: 0,
      key: {
        commandId: "cmd-genesis-history",
        principalId: "operator-local",
        projectId: PROJECT_ID,
      },
      requestBytes: bytes,
      targetAggregateId: "agg-genesis-history",
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
  }

  interface InstallerCounts {
    initial: number;
    replacing: number;
  }

  /** The REAL store, with only a call counter interposed on the two installers. */
  function countingStore(store: SqliteEventStore, counts: InstallerCounts) {
    return {
      commitExpectedVersionDecision: (input: unknown): unknown =>
        store.commitExpectedVersionDecision(input as never),
      installInitialRecoveryBinding: (input: unknown): RecoveryInitialInstallResult => {
        counts.initial += 1;
        return store.installInitialRecoveryBinding(input);
      },
      installRecoveryBinding: (input: unknown): RecoveryInstallResult => {
        counts.replacing += 1;
        return store.installRecoveryBinding(input);
      },
      readCommandDecisionsAfter: (cursor: bigint, limit: number): DecisionPage =>
        store.readCommandDecisionsAfter(cursor, limit),
      readRecoveryBinding: (slot: unknown): RecoveryBindingReadResult =>
        store.readRecoveryBinding(slot),
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];
  }

  it("installs a pristine store through the ATOMIC installer, never the replacing one", () => {
    const store = openUnboundStore();
    const counts: InstallerCounts = { initial: 0, replacing: 0 };

    const result = requireBinding(
      ensureGenesisRecoveryBinding(countingStore(store, counts), {
        clock: CLOCK, projectId: PROJECT_ID,
      }),
    );

    expect(result.outcome).toBe("INSTALLED");
    // Which installer, not merely that one ran: the replacing installer would
    // produce exactly this outcome while leaving the clobber window open.
    expect(counts).toEqual({ initial: 1, replacing: 0 });
    expect(readCurrentRecoveryAuthenticationBinding(store)?.recoveryIncarnationRef)
      .toBe(result.binding.recoveryIncarnationRef);
  });

  it("settles a FOUND slot as PRESENT without reaching either installer", () => {
    const store = openUnboundStore();
    installTestRecoveryBinding(store);
    const counts: InstallerCounts = { initial: 0, replacing: 0 };

    const result = requireBinding(
      ensureGenesisRecoveryBinding(countingStore(store, counts), {
        clock: CLOCK, projectId: PROJECT_ID,
      }),
    );

    expect(result.outcome).toBe("PRESENT");
    expect(counts).toEqual({ initial: 0, replacing: 0 });
    expect(result.binding.recoveryIncarnationRef).toBe("71".repeat(32));
  });

  it("maps the store's CURRENT answer onto PRESENT carrying the WINNER's binding", () => {
    // The loser's arm. `ok` is true because nothing went wrong, but `outcome` is
    // CURRENT and `authority` is NONE: a handle that lost the install must never
    // report itself as the minter, and must adopt the winner rather than its own
    // discarded mint.
    let installs = 0;
    let reads = 0;
    const store = {
      commitExpectedVersionDecision: (): never => {
        throw new Error("must not anchor a slot this handle did not write");
      },
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        return Object.freeze({
          authority: "NONE" as const,
          binding: (foundWinner as unknown as { binding: unknown }).binding,
          bindingDigest: "8c".repeat(32),
          code: "RECOVERY_INITIAL_INSTALL_ALREADY_BOUND" as const,
          layer: "RECOVERY_INSTALL_TRANSACTION",
          ok: true as const,
          outcome: "CURRENT" as const,
        }) as unknown as RecoveryInitialInstallResult;
      },
      installRecoveryBinding: (): RecoveryInstallResult => {
        throw new Error("the replacing installer must never be reached");
      },
      readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult => {
        reads += 1;
        return reads === 1 ? ABSENT_SLOT : foundWinner;
      },
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];

    const result = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );

    expect(installs).toBe(1);
    expect(result.outcome).toBe("PRESENT");
    expect(result.binding.recoveryIncarnationRef).toBe(CURRENT_WINNER_INCARNATION);
    expect(result.binding.keyEpochRef).toBe(CURRENT_WINNER_KEY_EPOCH);
  });

  it("adopts the winner when a refusal coincides with an already-bound slot", () => {
    // The loser's SECOND door. The winner anchors its incarnation right after
    // installing, that anchor is authoritative history, and the pristine guard
    // reads history before it reads the slot — so a handle that installs a moment
    // later is refused for a condition the winner created, over a store that is
    // perfectly well fenced. Refusing there would fail daemon startup outright.
    let installs = 0;
    let reads = 0;
    const store = {
      commitExpectedVersionDecision: (): never => {
        throw new Error("must not anchor a slot this handle did not write");
      },
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        return Object.freeze({
          authority: "NONE" as const,
          code: "RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT" as const,
          layer: "RECOVERY_INSTALL_TRANSACTION",
          ok: false as const,
          outcome: "REFUSED" as const,
          reason: "The store already carries authoritative history.",
          truth: "UNKNOWN" as const,
        }) as unknown as RecoveryInitialInstallResult;
      },
      installRecoveryBinding: (): RecoveryInstallResult => {
        throw new Error("the replacing installer must never be reached");
      },
      readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult => {
        reads += 1;
        return reads === 1 ? ABSENT_SLOT : foundWinner;
      },
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];

    const result = requireBinding(
      ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID }),
    );

    expect(installs).toBe(1);
    expect(result.outcome).toBe("PRESENT");
    expect(result.binding.recoveryIncarnationRef).toBe(CURRENT_WINNER_INCARNATION);
  });

  it("refuses UNVERIFIED when a committed install will not read back", () => {
    // The read-back is a SECOND, independent check, not a leftover: the store's
    // transaction says the row landed, and this asks the row itself. Trusting the
    // install result alone would report an INSTALLED fence over a slot that
    // cannot be read — which is the one state where the daemon must not boot.
    let installs = 0;
    const store = {
      commitExpectedVersionDecision: (): never => {
        throw new Error("must not anchor a fence that never read back");
      },
      installInitialRecoveryBinding: (): RecoveryInitialInstallResult => {
        installs += 1;
        return Object.freeze({
          binding: Object.freeze({ slot: "ACTIVE" }),
          bindingDigest: "8d".repeat(32),
          ok: true as const,
          outcome: "INSTALLED" as const,
        }) as unknown as RecoveryInitialInstallResult;
      },
      installRecoveryBinding: (): RecoveryInstallResult => {
        throw new Error("the replacing installer must never be reached");
      },
      readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult => ABSENT_SLOT,
    } as unknown as Parameters<typeof ensureGenesisRecoveryBinding>[0];

    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });

    expect(installs).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GENESIS_INSTALL_UNVERIFIED");
    expect(result.storeCode).toBe("READ_BACK_FAILED");
    expect(GENESIS_RECOVERY_ERROR_CODES).toContain(result.code);
  });

  it("refuses a store carrying authoritative history with the store's OWN code", () => {
    // Hardening, and deliberate: a deleted or corrupted binding row must not let
    // a store that has already served a workload silently re-genesis itself,
    // which would revoke every outstanding session and mint a fresh fence over
    // real history. The store answers; genesis carries that answer verbatim.
    const store = openUnboundStore();
    seedAuthoritativeHistory(store);
    expect(store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });

    const result = ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("GENESIS_INSTALL_REFUSED");
    // Never flattened into a generic code: the store's own reason survives.
    expect(result.storeCode).toBe("RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT");
    expect(GENESIS_RECOVERY_ERROR_CODES).toContain(result.code);
    // And nothing was written: a refusal that still bound the store would be the
    // exact failure this guard exists to prevent.
    expect(store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });
  });
});

const RACE_DEADLINE_MILLISECONDS = 30_000;

/** Bounded: a worker that never reports fails BY NAME instead of stalling the suite. */
function withDeadline<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`genesis race worker never reported: ${label}`));
    }, RACE_DEADLINE_MILLISECONDS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface RaceReport {
  readonly incarnationRef?: string | null;
  readonly installDigest?: string | null;
  readonly installOutcome?: string | null;
  readonly keyEpochRef?: string | null;
  readonly label: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly storeCode?: string;
}

interface RaceHandle {
  readonly observed: Promise<string>;
  readonly preOpenReady: Promise<void>;
  readonly result: Promise<RaceReport>;
}

function startGenesisWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  label: string,
): RaceHandle {
  const worker = new Worker(new URL("./genesis-first-boot-worker.mjs", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: { databasePath, gate, label, projectId: PROJECT_ID },
  });
  let resolvePreOpen!: () => void;
  let resolveObserved!: (value: string) => void;
  let resolveResult!: (value: RaceReport) => void;
  const rejecters: ((error: Error) => void)[] = [];
  const promised = <Value>(assign: (resolve: (value: Value) => void) => void): Promise<Value> =>
    new Promise<Value>((resolve, reject) => { assign(resolve); rejecters.push(reject); });

  const preOpenReady = promised<void>((resolve) => { resolvePreOpen = resolve; });
  const observed = promised<string>((resolve) => { resolveObserved = resolve; });
  const result = promised<RaceReport>((resolve) => { resolveResult = resolve; });
  const rejectAll = (error: Error): void => { for (const reject of rejecters) reject(error); };

  worker.on("message", (message: { kind: string; observed?: string } & RaceReport) => {
    if (message.kind === "PREOPEN_READY") resolvePreOpen();
    else if (message.kind === "OBSERVED") resolveObserved(message.observed ?? "MISSING");
    else if (message.kind === "RESULT") resolveResult(message);
  });
  worker.on("error", (error) => rejectAll(error));
  worker.on("exit", (code) => {
    if (code !== 0) rejectAll(new Error(`${label} worker exited with ${code}`));
  });
  return {
    observed: withDeadline(observed, `${label} OBSERVED`),
    preOpenReady: withDeadline(preOpenReady, `${label} PREOPEN_READY`),
    result: withDeadline(result, `${label} RESULT`),
  };
}

function release(gate: SharedArrayBuffer, index: number, waiters: number): void {
  const view = new Int32Array(gate);
  Atomics.store(view, index, 1);
  Atomics.notify(view, index, waiters);
}

describe("genesis recovery binding — concurrent first boot", () => {
  it("lets two racing handles commit exactly ONE binding, with no clobber", async () => {
    // Two real file-backed handles on one genuinely new store directory, held at
    // a shared gate until BOTH have observed the same absent slot. Without that
    // hold the collision is probabilistic; with it, this is the exact interleaving
    // a replacing installer cannot survive — both handles mint, both commit, and
    // the second destroys the binding the first already reported as INSTALLED,
    // orphaning every session credential bound to it.
    const directory = mkdtempSync(join(tmpdir(), "moe-genesis-race-"));
    const databasePath = join(directory, "store.db");
    const gate = new SharedArrayBuffer(8);
    const workers = [
      startGenesisWorker(databasePath, gate, "alpha"),
      startGenesisWorker(databasePath, gate, "beta"),
    ];
    try {
      await Promise.all(workers.map((worker) => worker.preOpenReady));
      release(gate, 0, workers.length);

      // The collision is PROVEN, not assumed. A sweep that silently produced a
      // sequential run would pass while testing nothing at all.
      expect(await Promise.all(workers.map((worker) => worker.observed)))
        .toEqual(["ABSENT", "ABSENT"]);
      release(gate, 1, workers.length);
      const reports = await Promise.all(workers.map((worker) => worker.result));

      expect(reports.map((report) => report.label).sort()).toEqual(["alpha", "beta"]);
      const reopened = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      try {
        const row = reopened.readRecoveryBinding("ACTIVE");
        if (!row.ok || row.outcome !== "FOUND") throw new Error("the ACTIVE slot must be FOUND");

        // THE CLOBBER DETECTOR, and the assertion the swap exists to satisfy:
        // every binding this store ever committed is STILL the binding on disk.
        // A replacing installer commits twice with two different digests here, so
        // this fails on the committed bytes rather than on a downstream symptom.
        expect(
          reports.filter((report) => report.installOutcome === "INSTALLED")
            .map((report) => report.installDigest),
        ).toEqual([row.bindingDigest]);

        // Exactly one minter, and the loser was told so by the store's own
        // transaction rather than by a post-hoc read-back heuristic.
        // Mapped rather than counted, so a failure NAMES what each handle
        // actually reported instead of printing a count that could mean anything.
        // The loser's outcome is deterministic even though its internal path is
        // not: it is told CURRENT if it installs before the winner anchors, and
        // refused for the winner's own anchor history if it installs after. Both
        // doors must settle PRESENT on the winner's fence.
        expect(reports.map((report) => report.outcome).sort())
          .toEqual(["INSTALLED", "PRESENT"]);

        // Both handles adopt the SAME fence, so no credential is orphaned.
        expect(reports[0]?.incarnationRef).toBe(reports[1]?.incarnationRef);
        expect(reports[0]?.keyEpochRef).toBe(reports[1]?.keyEpochRef);
        expect(row.binding.incarnationRef).toBe(reports[0]?.incarnationRef);
      } finally {
        reopened.close();
      }
    } finally {
      // Every store handle is closed before this runs — on Windows a live SQLite
      // handle makes rmSync throw EPERM and kills the vitest worker outright.
      rmSync(directory, { force: true, recursive: true });
    }
  }, RACE_DEADLINE_MILLISECONDS + 15_000);
});
