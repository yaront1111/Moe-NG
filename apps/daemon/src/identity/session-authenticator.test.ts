import { afterEach, describe, expect, it } from "vitest";

import { createSessionAuthenticator } from "./session-authenticator.js";
import type { SessionAuthenticatorConfig } from "./session-authenticator.js";
import {
  CREDENTIAL,
  EXPIRES_AT_MS,
  PROJECT_ID,
  SESSION_ID,
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
 * The HTTP seam's credential authenticator over the durable session ledger.
 *
 * Unknown and structurally invalid credentials remain indistinguishable. Recovery replay is the
 * one typed refusal so HTTP can preserve the stable identity-layer reason. Expiry cases pin the
 * EXCLUSIVE boundary (unusable at exactly `expiresAt`), matching `@moe/core` semantics.
 */

afterEach(closeStores);

const OPERATOR_CREDENTIAL = "operator-bootstrap-credential";

interface Harness {
  readonly authenticate: (credential: string | null) => ReturnType<
    ReturnType<typeof createSessionAuthenticator>["authenticate"]
  >;
  readonly setNow: (epochMs: number) => void;
  readonly store: SqliteEventStore;
}

function harness(overrides: Partial<SessionAuthenticatorConfig> = {}): Harness {
  const store = openStore();
  let now = EXPIRES_AT_MS - 60_000;
  const authenticator = createSessionAuthenticator(store, {
    clock: () => now,
    operatorCapabilities: ["admin.bootstrap"],
    operatorCredential: OPERATOR_CREDENTIAL,
    operatorPrincipalId: "principal-operator",
    projectId: PROJECT_ID,
    ...overrides,
  });
  return {
    authenticate: (credential) => authenticator.authenticate(credential),
    setNow: (epochMs) => {
      now = epochMs;
    },
    store,
  };
}

describe("operator credential", () => {
  it("authenticates the exact operator credential to the operator principal", () => {
    const { authenticate } = harness();
    expect(authenticate(OPERATOR_CREDENTIAL)).toEqual({
      principal: {
        capabilities: ["admin.bootstrap"],
        principalId: "principal-operator",
        projectId: PROJECT_ID,
      },
      verdict: "AUTHENTICATED",
    });
  });

  it("refuses null, empty, near-miss and wrong-length credentials as UNAUTHENTICATED", () => {
    const { authenticate } = harness();
    for (const bad of [null, "", "operator-bootstrap-credentiaL", `${OPERATOR_CREDENTIAL}x`]) {
      expect(authenticate(bad)).toEqual({ verdict: "UNAUTHENTICATED" });
    }
  });
});

describe("session credentials over the durable ledger", () => {
  it("open -> authenticate roundtrip yields the SESSION as the working principal", () => {
    const { authenticate, store } = harness();
    openDefaultSession(store);
    // The working principal is the session id, never the opener: two sessions
    // opened by one operator must stay distinct identities or per-agent fences
    // (work claims, decision keys) collapse into one. The opener remains on the
    // durable session record for audit.
    expect(authenticate(CREDENTIAL)).toEqual({
      principal: {
        capabilities: ["review.submit", "work.claim"],
        principalId: "session-alpha",
        projectId: PROJECT_ID,
      },
      verdict: "AUTHENTICATED",
    });
  });

  it("refuses a credential whose hash was never bound (wrong hash)", () => {
    const { authenticate, store } = harness();
    openDefaultSession(store);
    expect(authenticate("some-other-credential")).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("refuses the credential of a CLOSED session", () => {
    const { authenticate, store } = harness();
    openDefaultSession(store);
    const closed = send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-c"));
    if (!closed.ok) throw new Error(`close setup failed: ${closed.code}`);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("expiry is exclusive: usable one millisecond before, refused at and after expiresAt", () => {
    const { authenticate, setNow, store } = harness();
    openDefaultSession(store);
    setNow(EXPIRES_AT_MS - 1);
    expect(authenticate(CREDENTIAL).verdict).toBe("AUTHENTICATED");
    setNow(EXPIRES_AT_MS);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
    setNow(EXPIRES_AT_MS + 1);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("renew extends expiry: a session refused as expired authenticates again after renew", () => {
    const { authenticate, setNow, store } = harness();
    openDefaultSession(store);
    setNow(EXPIRES_AT_MS + 5_000);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });

    const later = new Date(EXPIRES_AT_MS + 3_600_000).toISOString();
    const renewed = send(
      store,
      envelope("session.renew", 1, { expiresAt: later, sessionId: SESSION_ID }, "cmd-r"),
    );
    if (!renewed.ok) throw new Error(`renew setup failed: ${renewed.code}`);
    expect(authenticate(CREDENTIAL).verdict).toBe("AUTHENTICATED");
  });

  it("scopes the fold to the configured project", () => {
    const { authenticate, store } = harness({ projectId: "some-other-project" });
    openDefaultSession(store);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("fails closed on an unreadable ledger", () => {
    const { authenticate, store } = harness();
    commitRaw(store, envelope("session.open", 0, openPayload(), "cmd-bad"), "garbage", SESSION_ID);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("fails closed when two sessions share one credential hash", () => {
    const { authenticate, store } = harness();
    openDefaultSession(store);
    const second = send(
      store,
      envelope(
        "session.open",
        0,
        openPayload({ sessionId: "session-beta" }),
        "cmd-open-beta",
      ),
    );
    if (!second.ok) throw new Error(`second open setup failed: ${second.code}`);
    expect(authenticate(CREDENTIAL)).toEqual({ verdict: "UNAUTHENTICATED" });
  });

  it("never stores or returns credential plaintext: the ledger holds only the hash", () => {
    const { store } = harness();
    const outcome = openDefaultSession(store);
    if (!outcome.ok) throw new Error("expected acceptance");
    const stored = Buffer.from(outcome.decision.resultBytes).toString("utf8");
    expect(stored).toContain(hashOf(CREDENTIAL));
    expect(stored).not.toContain(CREDENTIAL);
  });
});
