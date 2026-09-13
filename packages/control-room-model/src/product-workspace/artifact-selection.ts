import type { ProductArtifactSelection, ProductArtifactSelectionInput } from "./contracts.js";
import { sameProductScope } from "./identity.js";

/** A retained selection is an identity, including when its current read is unavailable. */
export function selectProductArtifact(input: ProductArtifactSelectionInput): ProductArtifactSelection {
  const artifacts = input.artifacts.filter((item) => sameProductScope(input.scope, item.scope));
  const selectedId = input.selectedId ?? input.preferredId ?? artifacts[0]?.id ?? null;
  if (selectedId === null) return Object.freeze({ status: "EMPTY", selectedId, artifact: null });
  const matches = artifacts.filter((item) => item.id === selectedId);
  const artifact = matches.length === 1 ? matches[0]! : null;
  return Object.freeze({
    status: artifact === null || artifact.availability !== "PRESENT" ? "UNAVAILABLE" : "SELECTED",
    selectedId,
    artifact: artifact === null ? null : Object.freeze({ ...artifact,
      scope: Object.freeze({ ...artifact.scope }),
      contractRef: artifact.contractRef === null ? null : Object.freeze({ ...artifact.contractRef }),
    }),
  });
}
