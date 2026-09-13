import { sameProductContract, sameProductScope } from "@moe/control-room-model";
import type { ProductArtifact, ProductScope } from "@moe/control-room-model";
import type { ProductWorkspaceInput, ProductWorkspaceModel } from "./product-model-adapter.js";
import { createProductWorkspaceModel } from "./product-model-adapter.js";

export type ProductArtifactReads = Pick<ProductWorkspaceInput, "source" | "design" | "preview" | "release">;
export interface ProductArtifactSnapshot {
  readonly artifact: ProductArtifact;
  readonly model: ProductWorkspaceModel;
  readonly reads: ProductArtifactReads;
  readonly observedAt: string;
}
export interface ProductArtifactHistory {
  readonly scope: ProductScope;
  readonly snapshots: readonly ProductArtifactSnapshot[];
  readonly lastReleasedId: string | null;
}
export interface ProductArtifactHistoryView {
  readonly model: ProductWorkspaceModel;
  readonly reads: ProductArtifactReads;
  readonly historical: boolean;
  readonly observedAt: string | null;
}

/** In-memory observations only. Keep selected/released records plus the most recent 24 observations. */
const RECENT_OBSERVATIONS = 24;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function readsFor(input: ProductWorkspaceInput, artifact?: ProductArtifact): ProductArtifactReads {
  return {
    source: artifact === undefined || artifact.kind === "SOURCE" ? input.source : null,
    design: artifact === undefined || artifact.kind === "DESIGN" ? input.design : null,
    preview: artifact === undefined || artifact.kind === "PREVIEW" ? input.preview : null,
    release: artifact === undefined || artifact.kind === "RELEASE" ? input.release : null,
  };
}

function bindingChanged(before: ProductArtifact, after: ProductArtifact): boolean {
  return before.kind !== after.kind || before.sha !== after.sha
    || before.contractRef !== null && !sameProductContract(before.contractRef, after.contractRef)
    || before.planningRunRef !== null && before.planningRunRef !== after.planningRunRef;
}

export function reconcileProductArtifactHistory(previous: ProductArtifactHistory | null,
  input: ProductWorkspaceInput, observedAt: string,
): ProductArtifactHistory {
  const compatible = input.scope.goalId === input.goalRef && previous !== null && sameProductScope(previous.scope, input.scope);
  const snapshots = new Map((compatible ? previous.snapshots : []).map((item) => [item.artifact.id, item]));
  const current = createProductWorkspaceModel(input);
  for (const artifact of current.artifacts) {
    if (artifact.availability !== "PRESENT") continue;
    const old = snapshots.get(artifact.id);
    // A stable artifact id cannot silently acquire another recorded contract or plan binding.
    if (old !== undefined && bindingChanged(old.artifact, artifact)) continue;
    snapshots.delete(artifact.id);
    snapshots.set(artifact.id, freeze(structuredClone({ artifact, observedAt,
      model: createProductWorkspaceModel({ ...input, selectedArtifactId: artifact.id }), reads: readsFor(input, artifact),
    })));
  }
  const lastReleasedId = current.delivered?.id ?? (compatible ? previous.lastReleasedId : null);
  const protectedIds = new Set([input.selectedArtifactId, lastReleasedId]);
  const ordered = [...snapshots.values()];
  const retained = ordered.filter((item, index) => index >= ordered.length - RECENT_OBSERVATIONS || protectedIds.has(item.artifact.id));
  return Object.freeze({ scope: Object.freeze({ ...input.scope }), snapshots: Object.freeze(retained), lastReleasedId });
}

function withObservedRelease(current: ProductWorkspaceModel, history: ProductArtifactHistory): ProductWorkspaceModel {
  const retained = history.snapshots.filter((snapshot) => !current.artifacts.some((item) => item.id === snapshot.artifact.id))
    .map((snapshot): ProductArtifact => Object.freeze({ ...snapshot.artifact, availability: "STALE" }));
  const artifacts = Object.freeze([...current.artifacts, ...retained]);
  const released = history.snapshots.find((snapshot) => snapshot.artifact.id === history.lastReleasedId)?.artifact ?? null;
  if (current.delivered !== null || released === null) return Object.freeze({ ...current, artifacts });
  return Object.freeze({ ...current, artifacts, delivered: Object.freeze({ ...released, availability: "STALE" }),
    deliveryState: "STALE", deliveryNote: `Previously observed released version retained. ${current.deliveryNote}`,
  });
}

/** Saved decoded records remain inspectable; remote captures retain URLs, not image bytes. Freshness never carries forward. */
export function selectProductArtifactHistory(history: ProductArtifactHistory, input: ProductWorkspaceInput): ProductArtifactHistoryView {
  const current = createProductWorkspaceModel(input);
  if (!sameProductScope(history.scope, input.scope) || input.scope.goalId !== input.goalRef) {
    return Object.freeze({ model: current, reads: readsFor(input), historical: false, observedAt: null });
  }
  const model = withObservedRelease(current, history);
  const stored = history.snapshots.find((item) => item.artifact.id === current.selection.selectedId);
  if (stored === undefined || current.selection.status === "SELECTED" && current.selection.artifact !== null
    && !bindingChanged(stored.artifact, current.selection.artifact)) {
    return Object.freeze({ model, reads: readsFor(input), historical: false, observedAt: stored?.observedAt ?? null });
  }
  const requirements = Object.freeze(stored.model.requirements.map((requirement) => Object.freeze({ ...requirement,
    state: "UNKNOWN" as const, criteria: Object.freeze(requirement.criteria.map((criterion) => Object.freeze({ ...criterion, state: "UNKNOWN" as const }))),
  })));
  const historicalModel: ProductWorkspaceModel = Object.freeze({ ...model, requirements,
    selection: Object.freeze({ status: "SELECTED", selectedId: stored.artifact.id, artifact: stored.artifact }),
    contractRef: stored.model.contractRef,
    readiness: Object.freeze({ state: "UNKNOWN", passed: 0, failed: 0, total: stored.model.readiness.total,
      label: "Historical artifact; applicable checks need a fresh read." }),
    scopeNote: `Showing a saved observation from ${stored.observedAt}. Current applicability has not been established.`,
  });
  return Object.freeze({ model: historicalModel, reads: stored.reads, historical: true, observedAt: stored.observedAt });
}
