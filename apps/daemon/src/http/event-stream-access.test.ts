import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import {
  commitRaw, envelope, installTestRecoveryBinding, openPayload, send,
} from "../identity/session-test-fixtures.js";
import {
  createEventStreamAccessPort, createEventStreamSubscriberResolver,
} from "./event-stream-access.js";
import type { EventStreamPrincipal } from "./event-stream-access.js";

const PROJECT = "proj-event-stream-access";
const OPERATOR = "operator-local";
const CAPS = Object.freeze(["project.admin", "work.claim"]);
const DEFAULT_READER = "control-room-1";
const directories: string[] = [];

type SubscriberResolver = (principal: EventStreamPrincipal) => string | undefined;

function harness(resolveSubscriberId?: SubscriberResolver, now = Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), "moe-event-stream-access-"));
  directories.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  installTestRecoveryBinding(store);
  const resolver = resolveSubscriberId ?? createEventStreamSubscriberResolver({
    clock: () => now,
    operatorCapabilities: CAPS,
    operatorPrincipalId: OPERATOR,
    operatorSubscriberId: DEFAULT_READER,
    projectId: PROJECT,
    store,
  });
  const config = {
    operatorCapabilities: CAPS,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT,
    resolveSubscriberId: resolver,
    store,
  };
  const access = createEventStreamAccessPort(config);
  return { access, store };
}

function mintSession(
  store: SqliteEventStore, sessionId: string, capabilities: readonly string[] = CAPS,
): void {
  const minted = createOperatorSessionHandshakePort({
    capabilities,
    clock: () => Date.now(),
    mintCredential: () => `${sessionId}-credential`,
    mintSessionId: () => sessionId,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT,
    sessionTtlMs: 60_000,
    store,
  }).mint();
  if (!minted.ok) throw new Error(`session mint refused: ${minted.code}`);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("createEventStreamAccessPort", () => {
  it("binds the configured operator to the daemon-owned reader", () => {
    const { access, store } = harness();
    try {
      expect(access.authorize({
        capabilities: CAPS,
        principalId: OPERATOR,
        projectId: PROJECT,
      })).toEqual({ ok: true, subscriberId: "control-room-1" });
    } finally {
      store.close();
    }
  });

  it("refuses a capability-subset session even when the operator durably opened it", () => {
    const { access, store } = harness();
    try {
      const minted = createOperatorSessionHandshakePort({
        capabilities: ["work.claim"],
        clock: () => Date.now(),
        mintCredential: () => "weak-credential",
        mintSessionId: () => "weak-session",
        operatorPrincipalId: OPERATOR,
        projectId: PROJECT,
        sessionTtlMs: 60_000,
        store,
      }).mint();
      if (!minted.ok) throw new Error(`session mint refused: ${minted.code}`);
      expect(access.authorize({
        capabilities: ["work.claim"],
        principalId: "weak-session",
        projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED",
        httpStatus: 403,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("admits only a real OPEN full-capability pairing session", () => {
    const { access, store } = harness();
    try {
      const forged = access.authorize({
        capabilities: CAPS,
        principalId: "full-session",
        projectId: PROJECT,
      });
      expect(forged.ok).toBe(false);

      const minted = createOperatorSessionHandshakePort({
        capabilities: CAPS,
        clock: () => Date.now(),
        mintCredential: () => "full-credential",
        mintSessionId: () => "full-session",
        operatorPrincipalId: OPERATOR,
        projectId: PROJECT,
        sessionTtlMs: 60_000,
        store,
      }).mint();
      if (!minted.ok) throw new Error(`session mint refused: ${minted.code}`);
      expect(access.authorize({
        capabilities: CAPS,
        principalId: "full-session",
        projectId: PROJECT,
      })).toEqual({ ok: true, subscriberId: DEFAULT_READER });
    } finally {
      store.close();
    }
  });
});

describe("task-3a39bcd4 principal-bound event subscriber grants", () => {
  it("resolves different subscribers for two authorized principals", () => {
    const { access, store } = harness();
    try {
      mintSession(store, "session-a");
      mintSession(store, "session-b");
      const first = access.authorize({
        capabilities: CAPS, principalId: "session-a", projectId: PROJECT,
      });
      const second = access.authorize({
        capabilities: CAPS, principalId: "session-b", projectId: PROJECT,
      });

      expect(first).toEqual({ ok: true, subscriberId: DEFAULT_READER });
      expect(second).toEqual({ ok: true, subscriberId: "reader:session-b" });
      if (!first.ok || !second.ok) throw new Error("authorized principals were refused");
      expect(first.subscriberId).not.toBe(second.subscriberId);
    } finally {
      store.close();
    }
  });

  it("distinguishes a missing grant from missing operator authority", () => {
    const { access, store } = harness((principal) =>
      principal.principalId === OPERATOR ? DEFAULT_READER : undefined);
    try {
      mintSession(store, "ungranted-session");
      expect(access.authorize({
        capabilities: CAPS, principalId: "ungranted-session", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("fails a missing daemon-owned binding closed with authority unavailable", () => {
    const { store } = harness();
    const access = createEventStreamAccessPort({
      operatorCapabilities: CAPS,
      operatorPrincipalId: OPERATOR,
      projectId: PROJECT,
      resolveSubscriberId: createEventStreamSubscriberResolver({
        clock: () => Date.now(),
        operatorCapabilities: CAPS,
        operatorPrincipalId: OPERATOR,
        operatorSubscriberId: undefined,
        projectId: PROJECT,
        store,
      }),
      store,
    });
    try {
      expect(access.authorize({
        capabilities: CAPS, principalId: OPERATOR, projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("fails an empty authenticated principal binding closed as unavailable", () => {
    const { access, store } = harness();
    try {
      expect(access.authorize({
        capabilities: CAPS, principalId: "", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("preserves the configured operator default reader", () => {
    const { access, store } = harness();
    try {
      expect(access.authorize({
        capabilities: CAPS, principalId: OPERATOR, projectId: PROJECT,
      })).toEqual({ ok: true, subscriberId: DEFAULT_READER });
    } finally {
      store.close();
    }
  });

  it("preserves the exact operator-authority refusal", () => {
    const { access, store } = harness();
    try {
      expect(access.authorize({
        capabilities: ["work.claim"], principalId: "weak-session", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_OPERATOR_AUTHORITY_REQUIRED",
        httpStatus: 403,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("fails an expired durable session closed instead of deriving a reader", () => {
    const now = Date.now();
    const { access, store } = harness(undefined, now + 120_000);
    try {
      mintSession(store, "expired-session");
      expect(access.authorize({
        capabilities: CAPS, principalId: "expired-session", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("preserves a renewed session grant and fails closed after past-expiry renewal", () => {
    const now = Date.now();
    const { access, store } = harness(undefined, now);
    try {
      mintSession(store, "renewed-session");
      const principal = {
        capabilities: CAPS, principalId: "renewed-session", projectId: PROJECT,
      };
      const initial = access.authorize(principal);
      const renewed = send(store, envelope(
        "session.renew", 1,
        { expiresAt: new Date(now + 180_000).toISOString(), sessionId: "renewed-session" },
        "renew-event-reader", { principalId: OPERATOR, projectId: PROJECT },
      ));
      expect(renewed.ok).toBe(true);
      expect(access.authorize(principal)).toEqual(initial);
      const expired = send(store, envelope(
        "session.renew", 2,
        { expiresAt: new Date(now - 1).toISOString(), sessionId: "renewed-session" },
        "expire-event-reader", { principalId: OPERATOR, projectId: PROJECT },
      ));
      expect(expired.ok).toBe(true);
      expect(access.authorize(principal)).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("returns authority unavailable after a durable session is closed", () => {
    const { access, store } = harness();
    try {
      mintSession(store, "closed-session");
      const closed = send(store, envelope(
        "session.close", 1, { sessionId: "closed-session" }, "close-event-reader",
        { principalId: OPERATOR, projectId: PROJECT },
      ));
      expect(closed.ok).toBe(true);
      expect(access.authorize({
        capabilities: CAPS, principalId: "closed-session", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });

  it("returns authority unavailable when the durable session ledger is unreadable", () => {
    const { access, store } = harness();
    try {
      const corrupted = commitRaw(store, envelope(
        "session.open", 0, openPayload({ sessionId: "corrupt-session" }),
        "corrupt-event-reader", { principalId: OPERATOR, projectId: PROJECT },
      ), "garbage", "corrupt-session");
      expect(corrupted.ok).toBe(true);
      expect(access.authorize({
        capabilities: CAPS, principalId: "corrupt-session", projectId: PROJECT,
      })).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
    } finally {
      store.close();
    }
  });
});
