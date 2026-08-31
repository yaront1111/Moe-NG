import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  runProductContractGate1Command,
  type ProductContractGate1Authority,
  type ProductContractGate1CommitExtension,
} from "./product-contract-gate-1-command.js";
import { productContractGate1Refusal,
  type ProductContractGate1Outcome,
  type ProductContractGate1Request }
  from "./product-contract-gate-1-contract.js";
import type { BearerSessionWitness } from "./product-contract-gate-1-bearer.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";
import { prepareProductContractV2GateWorkflow }
  from "./product-contract-v2-workflow-transition.js";
import { resolveProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";
import { readCurrentProductContractRevisionV2 }
  from "./product-contract-v2-reader.js";

type TransportWitness = BearerSessionWitness & { readonly transportOrigin?: unknown };
const refused = (code: string, layer: string) => productContractGate1Refusal({
  code, reason: "The durable v2 workflow authority refused this approval.", refusedBy: layer,
});
const v2Ref = (ref: ProductContractRevisionRef) => Object.freeze({ ...ref,
  version: "moe-product-contract-revision/2" as const });

function extension(store: SqliteEventStore): ProductContractGate1CommitExtension {
  return Object.freeze({
    prepare: (request: ProductContractGate1Request, ref: ProductContractRevisionRef) => {
      const current = readCurrentProductContractRevisionV2(store, {
        contractId: ref.contractId, projectId: request.projectId,
      });
      if (!current.ok) return refused(current.code, current.layer);
      const clarifications = resolveProductContractClarificationV2Authority(store, {
        committedRefs: Object.freeze([...current.slot.revisionHistory,
          current.slot.currentRevision]), contractId: ref.contractId,
        goalRef: null, projectId: request.projectId,
      });
      if (clarifications.status === "INVALID" || clarifications.status === "UNREADABLE") {
        return refused(clarifications.code, clarifications.layer);
      }
      if (clarifications.status !== "SATISFIED") {
        return refused("PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_UNSATISFIED",
          "PRODUCT_CONTRACT_V2_WORKFLOW");
      }
      const workflow = prepareProductContractV2GateWorkflow(store, {
        commandId: request.commandId, contractId: ref.contractId,
        projectId: request.projectId, ref: v2Ref(ref),
      });
      return workflow.ok ? Object.freeze({ legs: Object.freeze([workflow.leg]), ok: true as const })
        : refused(workflow.code, workflow.layer);
    },
    verifyReplay: (request: ProductContractGate1Request) => {
      if (typeof request.contractId !== "string") {
        return refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID", "PRODUCT_CONTRACT_V2_WORKFLOW");
      }
      const workflow = readProductContractV2WorkflowHead(store, {
        contractId: request.contractId, projectId: request.projectId,
        requiredCause: Object.freeze({ commandId: request.commandId, kind: "GATE_1" }),
      });
      if (!workflow.ok) return refused(workflow.code, workflow.layer);
      return workflow.companionFound ? null
        : refused("PRODUCT_CONTRACT_V2_WORKFLOW_INVALID", "PRODUCT_CONTRACT_V2_WORKFLOW");
    },
  });
}

/** V2-only writer: its workflow companion is required for commit and replay. */
export function runProductContractGate1V2Command(
  store: SqliteEventStore,
  input: unknown,
  authority: ProductContractGate1Authority,
  bearerWitness?: TransportWitness,
): ProductContractGate1Outcome {
  return runProductContractGate1Command(
    store, input, authority, bearerWitness, extension(store),
  );
}
