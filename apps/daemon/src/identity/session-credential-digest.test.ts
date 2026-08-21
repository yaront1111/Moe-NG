import { afterEach, describe, expect, it } from "vitest";

import { readSessionCredentialDigest } from "./session-credential-digest.js";
import type { SessionCredentialDigestResult } from "./session-credential-digest.js";
import {
  CAPABILITIES,
  CREDENTIAL,
  EXPIRES_AT,
  OPENER,
  PROJECT_ID,
  SESSION_ID,
  TEST_RECOVERY_INCARNATION_REF,
  TEST_RECOVERY_KEY_EPOCH_REF,
  closeStores,
  commitRaw,
  envelope,
  hashOf,
  openDefaultSession,
  openPayload,
  openStore,
  send,
} from "./session-test-fixtures.js";
import type { SqliteEventStore } from "@moe/store";

/**
 * The scoped read of `SessionRecord.credentialSha256` that Foundation dispatch composes
 * (task-fc9660b0) instead of trusting a caller-carried `bootstrapCredentialDigest`.
 *
 * Every arm drives the PRODUCTION reader over state seeded through the PRODUCTION session
 * command path, so a green here is a statement about shipped code. Each refusal pins the exact
 * code AND the layer that answered AND asserts the digest did not travel with the refusal: a
 * reader that leaks the hash on the way to saying "unavailable" has defeated its own purpose.
 */

afterEach(closeStores);

const FOREIGN_PROJECT = "project-session-2";
const ANY_SHA256 = /[0-9a-f]{64}/u;

/** The exact fact set `openSession` commits, so a raw-seeded record differs in ONE field. */
function storedFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: [...CAPABILITIES],
    credentialSha256: hashOf(CREDENTIAL),
    expiresAt: EXPIRES_AT,
    keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
    principalId: OPENER,
    recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/**
 * Asserts a refusal's full identity: code, layer, ok-flag, frozen-ness, and that no digest rode
 * along. The hex sweep is over the SERIALISED refusal, so a digest hidden in `detail` — or in a
 * field nobody thought to name — still reddens.
 */
function expectRefusal(result: SessionCredentialDigestResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable: ok-flag asserted false above");
  expect(result.code).toBe(code);
  expect(result.refusedBy).toBe("DAEMON_PREREQUISITE");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.hasOwn(result, "credentialSha256")).toBe(false);
  expect(ANY_SHA256.test(JSON.stringify(result))).toBe(false);
}

/** Only `readCommandDecisionsAfter` is reachable from the fold, so only it needs to exist. */
function throwingStore(): SqliteEventStore {
  return {
    readCommandDecisionsAfter: (): never => {
      throw new Error("sqlite handle is closed");
    },
  } as unknown as SqliteEventStore;
}

describe("readSessionCredentialDigest", () => {
  it("returns the exact stored digest for an OPEN session in the named project", () => {
    const store = openStore();
    openDefaultSession(store);

    const result = readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a digest, refused ${result.code}`);
    // Byte equality against the production hash of the known plaintext, not a shape check: a
    // reader returning SOME 64-hex value would satisfy a shape assertion and still be useless.
    expect(result.credentialSha256).toBe(hashOf(CREDENTIAL));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("refuses an absent session id without revealing whether it ever existed", () => {
    const store = openStore();
    openDefaultSession(store);

    expectRefusal(
      readSessionCredentialDigest(store, PROJECT_ID, "session-never-opened"),
      "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE",
    );
  });

  it("refuses a foreign project with the SAME code as an absent session", () => {
    const store = openStore();
    openDefaultSession(store);

    // DELIBERATELY undifferentiated. Distinct codes here would make the reader a cross-project
    // session-existence oracle: a caller in project Q could enumerate live ids in project P by
    // reading which refusal came back. The project filter lives inside `readSessionLedger`, so
    // a foreign project observes exactly what an absent id observes — one code, by construction.
    expectRefusal(
      readSessionCredentialDigest(store, FOREIGN_PROJECT, SESSION_ID),
      "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE",
    );
  });

  it("refuses a CLOSED session, so a revoked credential cannot be re-read", () => {
    const store = openStore();
    openDefaultSession(store);
    const closed = send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-c1"));
    expect(closed.ok).toBe(true);

    expectRefusal(
      readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID),
      "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE",
    );
  });

  it("fails closed on a malformed stored hash, which the FOLD refuses on read", () => {
    // POSITIVE CONTROL FIRST: the same raw-seeded fact set, unmodified, must READ BACK. Without
    // it the malformed arm below could be red because `commitRaw` produced a shape the fold
    // rejects for some other reason, and would keep passing after the hash check was deleted.
    const control = openStore();
    commitRaw(
      control,
      envelope("session.open", 0, openPayload(), "cmd-raw-control"),
      storedFacts(),
      SESSION_ID,
    );
    const readBack = readSessionCredentialDigest(control, PROJECT_ID, SESSION_ID);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error(`control fixture unreadable: ${readBack.code}`);
    expect(readBack.credentialSha256).toBe(hashOf(CREDENTIAL));

    // ONE field differs. `parseOpened` re-checks `isCredentialSha256` on READ because the store
    // accepts arbitrary bytes, so this folds to `unreadable` and never reaches a record — which
    // is why the reader must NOT re-check the hash itself: that guard would be unreachable.
    const store = openStore();
    commitRaw(
      store,
      envelope("session.open", 0, openPayload(), "cmd-raw-bad-hash"),
      storedFacts({ credentialSha256: "not-a-lowercase-64-hex-digest" }),
      SESSION_ID,
    );

    expectRefusal(
      readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID),
      "SESSION_LEDGER_UNREADABLE",
    );
  });

  it("fails closed on an unreadable ledger rather than reporting no such session", () => {
    const store = openStore();
    commitRaw(
      store,
      envelope("session.open", 0, openPayload(), "cmd-corrupt"),
      "garbage",
      SESSION_ID,
    );

    // Distinct from the UNAVAILABLE arms on purpose: answering "no such session" over corrupt
    // bytes would let a spent id look free, which is the same fail-open the fold exists to stop.
    expectRefusal(
      readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID),
      "SESSION_LEDGER_UNREADABLE",
    );
  });

  it("contains a throwing store instead of propagating the throw to its caller", () => {
    // The fold does not wrap its own store call, so containment is this reader's job. The
    // assertion is that the reader RETURNED: a test written as `expect(...).toThrow()` inverted
    // would pass on a crash, and a crash is not a refusal.
    const result = readSessionCredentialDigest(throwingStore(), PROJECT_ID, SESSION_ID);

    expectRefusal(result, "SESSION_LEDGER_UNREADABLE");
    if (result.ok) throw new Error("unreachable");
    // No store error text may ride out: `sqlite handle is closed` is host detail, and a detail
    // that echoes the throw is one refactor away from echoing bytes.
    expect(result.detail).not.toContain("sqlite");
  });
});
