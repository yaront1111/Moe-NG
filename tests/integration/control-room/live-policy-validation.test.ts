import { decodeBoundedJsonBytes } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import {
  BOOTSTRAP_SCHEMA_VERSION,
} from "../../../apps/daemon/src/bootstrap/bootstrap-contracts.js";
import {
  BOOTSTRAP_HANDLERS, runBootstrapCommand,
} from "../../../apps/daemon/src/bootstrap/bootstrap-services.js";
import { DEV_PAYLOADS } from "../../../apps/control-room/src/live/live-dispatch.js";

const PROJECT_ID = "project-live-policy-integration";
const PRINCIPAL_ID = "operator-local";
const encoder = new TextEncoder();
const stores: SqliteEventStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function send(
  store: SqliteEventStore, kind: "policy.install" | "policy.validate", expectedVersion: number,
) {
  return runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-live-${kind}`,
    correlationId: `corr-live-${kind}`,
    decidedAt: "2026-08-24T00:00:00.000Z",
    expectedVersion,
    kind,
    payload: DEV_PAYLOADS[kind],
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  })), BOOTSTRAP_HANDLERS);
}

it("the shipped policy payload reaches an honest durable HOLD_UNKNOWN decision", () => {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  stores.push(store);

  expect(send(store, "policy.install", 0).ok).toBe(true);
  const validated = send(store, "policy.validate", 1);
  expect(validated.ok).toBe(true);

  const evaluated = store.readEvents(`${PROJECT_ID}-policy`)
    .filter((event) => event.eventType === "PolicyEvaluated");
  expect(evaluated).toHaveLength(1);
  const decoded = decodeBoundedJsonBytes(evaluated[0]!.payload);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value).toMatchObject({
    decision: "HOLD_UNKNOWN",
    policyRef: expect.any(String),
    principalId: PRINCIPAL_ID,
  });
});
