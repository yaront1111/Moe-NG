import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { createEventStreamAccessPort } from "./event-stream-access.js";

const PROJECT = "proj-event-stream-access";
const OPERATOR = "operator-local";
const CAPS = Object.freeze(["project.admin", "work.claim"]);
const directories: string[] = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "moe-event-stream-access-"));
  directories.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  installTestRecoveryBinding(store);
  const access = createEventStreamAccessPort({
    operatorCapabilities: CAPS,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT,
    store,
    subscriberId: "control-room-1",
  });
  return { access, store };
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
      })).toEqual({ ok: true, subscriberId: "control-room-1" });
    } finally {
      store.close();
    }
  });
});
