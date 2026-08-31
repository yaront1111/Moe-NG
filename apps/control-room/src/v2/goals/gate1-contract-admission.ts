import type { ProductContractRevisionV2 } from "@moe/core";

import { validGate1RevisionDigest } from "./gate1-contract-integrity.js";
import { validGate1RevisionSemantics } from "./gate1-contract-semantics.js";
import { validGate1RevisionShape } from "./gate1-contract-shape.js";
import { snapshotGate1Data } from "./gate1-data-snapshot.js";

/** Browser-side exact admission; durable authority remains exclusively the daemon's. */
export async function admitGate1ContractRevision(
  value: unknown,
): Promise<ProductContractRevisionV2 | null> {
  const snapshot = snapshotGate1Data(value);
  if (!snapshot.ok || !validGate1RevisionShape(snapshot.value)
    || !validGate1RevisionSemantics(snapshot.value)) return null;
  return await validGate1RevisionDigest(snapshot.value) ? snapshot.value : null;
}
