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

  it("installs the SHARED mint's store context, not a locally invented one", () => {
    // Delegation is the point of this rewire: the installed payload must be the
    // context digest the shared genesis mint derives for this project, and it
    // must be stable across boots while the identity itself stays fresh.
    const independent = mintGenesisIncarnation(PROJECT_ID);
    if (!independent.ok) throw new Error(`the shared mint must succeed: ${independent.code}`);
    let payload: Uint8Array | null = null;
    const store = {
      installRecoveryBinding: (input: unknown): RecoveryInstallResult => {
        payload = (input as { payload: Uint8Array }).payload;
        return Object.freeze({
          ok: false as const, code: "RECOVERY_INSTALL_SCOPE_REQUIRED", layer: "STORE",
        }) as unknown as RecoveryInstallResult;
      },
      readCommandDecisionsAfter: (): DecisionPage => NO_DECISIONS,
      readRecoveryBinding: (): RecoveryBindingReadResult =>
        Object.freeze({ ok: true as const, outcome: "ABSENT" as const, slot: "ACTIVE" as const }),
    };
    ensureGenesisRecoveryBinding(store, { clock: CLOCK, projectId: PROJECT_ID });
    expect(payload).not.toBeNull();
    expect(new TextDecoder().decode(payload!)).toBe(independent.binding.storeContextDigest);
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
