import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { PROJECT_ID, closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";
import {
  createProductContractV2CurrentReadPort,
  handleProductContractV2CurrentReadRequest,
} from "./product-contract-v2-current-read.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const AUTHENTICATED_PROJECT_ID = "proj-0001";

describe("Product Contract /2 current read", () => {
  it("refuses the real durable reader at the /2 activation fence before cutover", () => {
    const store = openStore();
    try {
      expect(createProductContractV2CurrentReadPort({ projectId: PROJECT_ID, store })
        .readCurrent("contract-v2")).toEqual({
        code: "CUTOVER_V2_NOT_ACTIVE",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        outcome: "REFUSED",
      });
    } finally {
      closeStores();
    }
  });

  it("authenticates, authorizes planning, and forwards one exact contract id", () => {
    const seen: string[] = [];
    const result = handleProductContractV2CurrentReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Current: {
        boundProjectId: AUTHENTICATED_PROJECT_ID,
        readCurrent: (contractId) => {
          seen.push(contractId);
          return { code: "CURRENT_ABSENT", layer: "TEST_READER", outcome: "REFUSED" };
        },
      },
    }, {
      body: bytes({ contractId: "contract-v2" }),
      credential: GOOD_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(result).toEqual({
      body: { code: "CURRENT_ABSENT", layer: "TEST_READER", outcome: "REFUSED" },
      httpStatus: 200,
      kind: "REPLY",
    });
    expect(seen).toEqual(["contract-v2"]);
  });

  it("refuses absent capability, cross-project ports, and inexact bodies at their own layers", () => {
    const base = {
      body: bytes({ contractId: "contract-v2" }),
      credential: GOOD_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    };
    const readCurrent = () => ({
      code: "UNREACHABLE", layer: "TEST", outcome: "REFUSED" as const,
    });
    expect(handleProductContractV2CurrentReadRequest({
      authenticator: authenticator([]),
      productContractV2Current: { boundProjectId: AUTHENTICATED_PROJECT_ID, readCurrent },
    }, base)).toMatchObject({
      body: { code: "PRODUCT_CONTRACT_V2_CURRENT_READ_CAPABILITY_DENIED",
        layer: "PRODUCT_CONTRACT_V2_CURRENT_READ" },
      kind: "REPLY",
    });
    expect(handleProductContractV2CurrentReadRequest({
      authenticator: authenticator([CAPABILITIES.PLANNING]),
      productContractV2Current: { boundProjectId: "another-project", readCurrent },
    }, base)).toMatchObject({
      body: { code: "PRODUCT_CONTRACT_V2_CURRENT_READ_PROJECT_MISMATCH",
        layer: "PRODUCT_CONTRACT_V2_CURRENT_READ" },
      kind: "REPLY",
    });
    for (const body of [
      {}, { contractId: "" }, { contractId: "contract-v2", extra: true },
      { contractId: "é".repeat(300) },
    ]) {
      expect(handleProductContractV2CurrentReadRequest({
        authenticator: authenticator([CAPABILITIES.PLANNING]),
        productContractV2Current: { boundProjectId: AUTHENTICATED_PROJECT_ID, readCurrent },
      }, { ...base, body: bytes(body) })).toEqual({
        code: "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID",
        kind: "LISTENER_REFUSAL",
      });
    }
  });
});
