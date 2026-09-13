import type { ProductContractRef, ProductScope } from "./contracts.js";

export function sameProductScope(left: ProductScope, right: ProductScope): boolean {
  return left.connectionId === right.connectionId && left.projectId === right.projectId
    && left.goalId === right.goalId && left.plane === right.plane;
}

export function sameProductContract(left: ProductContractRef | null, right: ProductContractRef | null): boolean {
  return left !== null && right !== null && left.plane === right.plane
    && left.contractId === right.contractId && left.revisionId === right.revisionId
    && left.revisionDigest === right.revisionDigest;
}
