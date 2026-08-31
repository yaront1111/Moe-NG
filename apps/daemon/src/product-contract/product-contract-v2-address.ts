import { createHash } from "node:crypto";

const REVISION_DOMAIN = "moe-product-contract-revision-address/2";
const SLOT_DOMAIN = "moe-product-contract-current-slot-address/2";
const COMMAND_DOMAIN = "moe-product-contract-revision-command/2";

export const PRODUCT_CONTRACT_REVISION_V2_COMMAND_KIND =
  "product-contract.revision.commit_v2" as const;

function digest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update(Uint8Array.of(0)).update(part, "utf8");
  return hash.digest("hex");
}

export function deriveProductContractRevisionV2AggregateId(
  projectId: string,
  contractId: string,
  revisionId: string,
): string {
  return `product-contract-revision.v2:${digest(REVISION_DOMAIN, [projectId, contractId, revisionId])}`;
}

export function deriveProductContractCurrentRevisionSlotV2AggregateId(
  projectId: string,
  contractId: string,
): string {
  return `product-contract-current-slot.v2:${digest(SLOT_DOMAIN, [projectId, contractId])}`;
}

export function deriveProductContractRevisionV2CommandId(
  projectId: string,
  contractId: string,
  revisionId: string,
): string {
  return `product-contract-revision-v2-command:${digest(
    COMMAND_DOMAIN, [projectId, contractId, revisionId],
  )}`;
}
