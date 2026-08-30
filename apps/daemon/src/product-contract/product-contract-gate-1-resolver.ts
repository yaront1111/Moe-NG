import type { ProductContractGate1Result, ProductContractRevisionRef } from "@moe/core";
import { validateProductContractGate1 } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import type {
  ProductContractGate1ApprovalReadRefusal,
} from "./product-contract-gate-1-reader.js";
import { readProductContractGate1Approval } from "./product-contract-gate-1-reader.js";
import type {
  ProductContractRevisionReadRefusal,
} from "./product-contract-revision-reader.js";
import { readProductContractRevision } from "./product-contract-revision-reader.js";

/**
 * Resolves Product Contract Gate 1 from durable state alone.
 *
 * COMPOSITION ONLY, AND DELIBERATELY SO. Three questions already have owners:
 * whether an approval was written by this daemon's own command
 * (`readProductContractGate1Approval`), whether the approved revision really
 * exists (`readProductContractRevision`), and whether the human authority in it
 * satisfies the gate (`validateProductContractGate1`). Each answer travels out
 * VERBATIM — code and layer untouched — because collapsing an upstream defect
 * into a local GATE_1 code is indistinguishable from not detecting it, which is
 * core's own documented reason at product-contract-acceptance-binding.ts:87-92.
 *
 * NO DIGEST OR TRIPLE IS RE-COMPARED HERE. `readProductContractRevision`
 * already refuses PRODUCT_CONTRACT_REVISION_IDENTITY_MISMATCH on a triple
 * divergence (product-contract-revision-reader.ts:66-72) and core re-verifies
 * the CONTENT digest inside `admitProductContractRevision`
 * (product-contract-codec.ts:120) on the path `validateProductContractGate1` ->
 * `admittedRevision`. A third copy would trip on exactly the same inputs as
 * those two and would pass a mutation drill for the wrong reason.
 */

export interface ProductContractGate1ResolveInput {
  readonly projectId: string;
  readonly ref: ProductContractRevisionRef;
}

export type ProductContractGate1ResolveResult =
  | ProductContractGate1ApprovalReadRefusal
  | ProductContractGate1Result
  | ProductContractRevisionReadRefusal;

/**
 * The signature is the fence. A caller supplies a store, a project and a
 * revision ref — never a gate, a grant, a principal or a moment — so DoD 3's
 * "no caller can invoke a public minter to satisfy the gate" is UNREPRESENTABLE
 * rather than merely refused at runtime, and survives a refactor that a runtime
 * check would not. The gate handed to core is the one the WRITER stored.
 */
export function resolveProductContractGate1(
  store: SqliteEventStore, input: ProductContractGate1ResolveInput,
): ProductContractGate1ResolveResult {
  const approval = readProductContractGate1Approval(store, {
    projectId: input.projectId, ref: input.ref,
  });
  if (!approval.ok) return approval;
  // The ref comes from the DURABLE APPROVAL, not from the caller: that is what
  // makes the resolved revision, and therefore the verdict, caller-independent.
  const revision = readProductContractRevision(store, {
    projectId: input.projectId, ref: approval.ref,
  });
  if (!revision.ok) return revision;
  return validateProductContractGate1(revision.revision, approval.gate);
}
