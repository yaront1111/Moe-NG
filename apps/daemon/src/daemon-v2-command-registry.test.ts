import { describe, expect, it } from "vitest";

import {
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
} from "./product-contract/product-contract-v2-propose-service.js";
import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { createDaemonV2CommandPorts } from "./daemon-v2-command-registry.js";
import {
  PROJECT_ID,
  closeStores,
  openStore,
} from "./bootstrap/bootstrap-test-fixtures.js";

describe("daemon /2 command registry", () => {
  it("serves the /2 Product Contract writer from an exact planning entry", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", projectId: PROJECT_ID, store,
    });
    try {
      expect([...ports.registry.keys()]).toEqual([
        PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
      ]);
      const entry = ports.registry.get(PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND);
      expect(entry).toMatchObject({
        kind: "product_contract.propose_revision",
        payloadKeys: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
        requiredCapability: CAPABILITIES.PLANNING,
      });
    } finally {
      closeStores();
    }
  });

  it("refuses at the named /2 activation fence before the writer can touch storage", () => {
    const store = openStore();
    const ports = createDaemonV2CommandPorts({
      clock: () => "2026-08-31T14:30:00.000Z", projectId: PROJECT_ID, store,
    });
    try {
      const entry = ports.registry.get(PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND);
      if (entry === undefined) throw new Error("missing v2 Product Contract entry");
      const result = ports.decisions.decide(
        { commandId: "command-v2-inactive", principalId: "agent-v2", projectId: PROJECT_ID },
        "a".repeat(64),
        () => entry.handler({
          envelope: {
            commandId: "command-v2-inactive",
            commandKind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
            correlationId: "correlation-v2-inactive",
            expectedVersion: 0,
            payload: { draft: {}, goalRef: "goal-v2" },
            requestDigest: "a".repeat(64),
            schemaVersion: "moe-runtime-command/1",
            sessionCredential: "credential-v2",
            targetAggregateId: "goal-v2",
          },
          principal: {
            capabilities: [CAPABILITIES.PLANNING],
            principalId: "agent-v2",
            projectId: PROJECT_ID,
          },
        }),
      );
      expect(result).toEqual({
        outcome: "REFUSED",
        refusal: {
          code: "CUTOVER_V2_NOT_ACTIVE",
          detail: "CUTOVER_V2_NOT_ACTIVE",
          httpStatus: 422,
          layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        },
      });
      expect(store.getAggregateVersion("goal-v2")).toBe(0);
    } finally {
      closeStores();
    }
  });
});
