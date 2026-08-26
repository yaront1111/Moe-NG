/**
 * PER-FIELD, PER-SOURCE refusal coverage for the server-built `ReleaseHandoff`
 * (task-a20e8ef668b54c3abbfce37a505252eb, DoD 3).
 *
 * ONE CASE PER FIELD, NOT ONE COMBINED CASE. A nine-key contract acquires a silently
 * unchecked member exactly when a single "something is wrong" arm passes on one field's
 * guard while another has none. Every case below drifts EXACTLY ONE source and asserts the
 * CODE, the SOURCE and the upstream reader's OWN code and layer — never merely that the
 * build refused.
 *
 * EVERY WORLD IS FILE-BACKED AND SEEDED THROUGH PRODUCTION. The activation comes from
 * `runEffectActivateCommand`, the resource terminality from `applyAttemptResourceReport`,
 * and the five handoff sources from `release-handoff-test-harness.ts`, whose three writer
 * paths are the production writers and whose two planted paths are named there with the
 * session fence that makes them necessary.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. `undrifted` builds successfully in the same world
 * shape every case below starts from, so a refusal here is the drift's answer and not a
 * fixture that quietly stopped reaching the builder at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import { buildReleaseHandoff } from "./release-handoff-builder.js";
import type { ReleaseHandoffIdentity } from "./release-handoff-contracts.js";
import {
  seedArtifactManifest, seedCaptureContext, seedContextManifest, seedJournal, seedStepRecord,
} from "./release-handoff-test-harness.js";
import type { HandoffSeedIdentity } from "./release-handoff-test-harness.js";

const SLUG = "relsrc";
const ATTEMPT = `attempt-${SLUG}`;
const INTENT = `intent-${SLUG}`;
const SESSION = `session-${SLUG}`;
const NODE_KEY = "dev-done";
const EPOCH = 41;
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const ACTIVATION_AGGREGATE = deriveActivationAggregateId(`agg-${SLUG}`, `idem-${SLUG}`);
const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(() => {
  cleanupRestoreHarnesses();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
});

function activationBytes(): Uint8Array {
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: EPOCH, kind: "ASSIGNMENT",
    leaseId: `lease-${SLUG}`, leaseToken: `token-${SLUG}`, monotonicObservation: 500,
    ownerSessionRef: SESSION, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: EPOCH, expectedVersion: 7,
    leaseToken: `token-${SLUG}`, ownerSessionRef: SESSION,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${SLUG}`, correlationId: `corr-${SLUG}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${SLUG}`, attemptId: ATTEMPT, intentId: INTENT,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${SLUG}`, claimedAt: DECIDED_AT, intentId: INTENT,
          lockIdentity: `lock-${SLUG}`, wrapperIdentity: `wrapper-${SLUG}`,
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${SLUG}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${SLUG}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${SLUG}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${SLUG}`, inputBinding: DIGEST, intentId: INTENT,
          leaseBinding: lease, predecessorCursor: `cursor-${SLUG}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: SLUG, slotRef: `held-${SLUG}`, state: "RESERVED" }],
      slot: {
        dimension: SLUG, requestId: `req-${SLUG}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: "intent-ref-res-a", epoch: 1, external: false,
          fenceable: true, resourceId: "res-a", state: "ACTIVE",
        }],
        slotRef: `slot-${SLUG}`,
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** What each case may bend. `skip` omits a source entirely; every other member drifts one
 *  record's fields through that source's production writer. */
interface Drift {
  readonly artifact?: Readonly<Record<string, unknown>>;
  readonly capture?: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly contextInputSha?: string;
  readonly journal?: Readonly<Record<string, unknown>>;
  readonly movableResources?: true;
  readonly skip?: "artifact" | "capture" | "context" | "journal" | "step";
  readonly step?: Readonly<Record<string, unknown>>;
}

interface World {
  readonly binding: FoundationAttemptBinding;
  readonly identity: ReleaseHandoffIdentity;
  readonly store: SqliteEventStore;
}

function world(label: string, drift: Drift = {}): World {
  const root = mkdtempSync(join(tmpdir(), `moe-handoff-src-${label}-`));
  roots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const activated = runEffectActivateCommand(store, activationBytes());
  if (!activated.ok) throw new Error(`activation refused: ${JSON.stringify(activated)}`);
  if (drift.movableResources !== true) {
    const reported = applyAttemptResourceReport(store, {
      activationAggregateId: ACTIVATION_AGGREGATE, commandId: `cmd-res-${label}`,
      correlationId: `corr-res-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-a" });
    if (!reported.ok) throw new Error(`resource report refused: ${reported.code}`);
  }
  const bound = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT);
  if (bound.status !== "BOUND") throw new Error(`binding refused: ${JSON.stringify(bound)}`);
  const seed: HandoffSeedIdentity = {
    activationDigest: bound.activationDigest, attemptAggregateId: bound.activationAggregateId,
    attemptRef: ATTEMPT, effectId: bound.effectIntentId, leaseRef: `lease-${SLUG}`,
    nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION,
  };
  if (drift.skip !== "step") seedStepRecord(store, seed, drift.step ?? {});
  if (drift.skip !== "journal") seedJournal(store, seed, drift.journal ?? {});
  let inputSha = "b".repeat(64);
  if (drift.skip !== "capture") inputSha = seedCaptureContext(store, seed, drift.capture ?? {});
  if (drift.skip !== "context") {
    seedContextManifest(store, seed, drift.contextInputSha ?? inputSha, drift.context ?? {});
  }
  if (drift.skip !== "artifact") seedArtifactManifest(store, seed, inputSha, drift.artifact ?? {});
  return {
    binding: bound,
    identity: Object.freeze({
      attemptRef: ATTEMPT, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION,
    }),
    store,
  };
}

interface Refusal {
  readonly code: string;
  readonly source: string | null;
  readonly upstream: { readonly code: string; readonly layer: string } | null;
}

function refusalOf(label: string, drift: Drift): Refusal {
  const built = buildReleaseHandoff(world(label, drift).store, {
    attemptRef: ATTEMPT, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION,
  });
  if (built.ok) throw new Error(`expected a refusal, the builder returned a handoff`);
  return { code: built.code, source: built.source, upstream: built.upstream };
}

/**
 * ONE CASE PER HANDOFF FIELD, plus the two cross-source disagreements no single reader can
 * see. `fields` names which of the nine this case is the guard for, so the coverage check
 * below is against the SCHEDULER'S ROSTER rather than against this table's own length.
 */
const CASES = [
  {
    drift: { skip: "step" }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "step-record",
      upstream: { code: "STEP_RECORD_ABSENT", layer: "DAEMON_STEP_LIFECYCLE" },
    },
    fields: ["completedSteps", "nextSafeAction"], label: "step-absent",
  },
  {
    drift: { step: { checkpointRef: null } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "step-record",
      upstream: { code: "STEP_CHECKPOINT_TARGET_UNKNOWN", layer: "DURABLE_STEP_RECORD" },
    },
    fields: ["nextSafeAction"], label: "no-checkpoint",
  },
  {
    drift: { step: { completedSteps: ["never-a-started-step"] } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_MALFORMED", source: "step-record",
      upstream: { code: "STEP_RECORD_MALFORMED", layer: "DAEMON_STEP_LIFECYCLE" },
    },
    fields: ["completedSteps"], label: "unstarted-completed-step",
  },
  {
    drift: { step: { truthClass: "AGENT_REPORTED" } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_MALFORMED", source: "step-record",
      upstream: { code: "STEP_RECORD_MALFORMED", layer: "DAEMON_STEP_LIFECYCLE" },
    },
    fields: ["truthClass"], label: "weaker-truth-class",
  },
  {
    drift: { skip: "journal" }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "attempt-journal",
      upstream: { code: "JOURNAL_RECORD_ABSENT", layer: "DAEMON_JOURNAL_APPEND" },
    },
    fields: ["journalDigest"], label: "journal-absent",
  },
  {
    drift: { journal: { effectId: "intent-somebody-else" } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_CONFLICTING", source: "attempt-journal",
      upstream: {
        code: "JOURNAL_AND_STEP_RECORD_DISAGREE", layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
      },
    },
    fields: ["journalDigest"], label: "journal-disagrees-with-step",
  },
  {
    drift: { skip: "capture" }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "capture-context",
      upstream: {
        code: "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT",
        layer: "DAEMON_FOUNDATION_CAPTURE_READER",
      },
    },
    fields: ["inputDigest", "worktreeDigest"], label: "capture-absent",
  },
  {
    drift: { skip: "context" }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "context-manifest",
      upstream: { code: "FOUNDATION_CONTEXT_READER_ABSENT", layer: "FOUNDATION_CONTEXT_READER" },
    },
    fields: ["contextDigest"], label: "context-absent",
  },
  {
    drift: { contextInputSha: "c".repeat(64) }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_CONFLICTING", source: "context-manifest",
      upstream: {
        code: "CONTEXT_AND_CAPTURE_INPUT_MANIFESTS_DISAGREE",
        layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
      },
    },
    fields: ["contextDigest", "inputDigest"], label: "context-binds-another-input-manifest",
  },
  {
    drift: { context: { nodeKey: "some-other-node" } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_FOREIGN", source: "context-manifest",
      upstream: {
        code: "CONTEXT_MANIFEST_NAMES_ANOTHER_SLOT",
        layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
      },
    },
    fields: ["contextDigest"], label: "context-names-another-node",
  },
  {
    drift: { skip: "artifact" }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_ABSENT", source: "artifact-manifest",
      upstream: {
        code: "FOUNDATION_ARTIFACT_LEDGER_ABSENT", layer: "DAEMON_FOUNDATION_ARTIFACT_LEDGER",
      },
    },
    fields: ["artifactDigest"], label: "artifact-absent",
  },
  {
    drift: { artifact: { attemptRef: "attempt-somebody-else" } }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_FOREIGN", source: "artifact-manifest",
      upstream: {
        code: "FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH",
        layer: "DAEMON_FOUNDATION_ARTIFACT_LEDGER",
      },
    },
    fields: ["artifactDigest"], label: "artifact-names-another-attempt",
  },
  {
    drift: { movableResources: true }, expected: {
      code: "RELEASE_HANDOFF_SOURCE_STALE", source: "terminal-evidence",
      upstream: {
        code: "RELEASE_TERMINAL_RESOURCES_MOVABLE", layer: "RELEASE_TERMINAL_EVIDENCE",
      },
    },
    fields: ["activeProcessResourceFacts"], label: "movable-resources",
  },
] as const;

describe("release handoff sources — per-field refusal (task-a20e8ef6)", () => {
  it("covers every one of the scheduler's nine fields, with a nonzero case count", () => {
    // BOTH DIRECTIONS. The union of the cases' `fields` must be exactly the nine, so a
    // field nobody drifted is reported here rather than shipping unguarded, and a name
    // this table invented is reported too.
    const covered = new Set(CASES.flatMap((entry) => entry.fields as readonly string[]));
    expect(CASES.length).toBe(13);
    expect([...covered].sort()).toEqual([
      "activeProcessResourceFacts", "artifactDigest", "completedSteps", "contextDigest",
      "inputDigest", "journalDigest", "nextSafeAction", "truthClass", "worktreeDigest",
    ]);
    expect(new Set(CASES.map((entry) => entry.label)).size).toBe(CASES.length);
  });

  it("THE POSITIVE CONTROL: the undrifted world builds a handoff", () => {
    const built = buildReleaseHandoff(world("control").store, {
      attemptRef: ATTEMPT, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION,
    });
    if (!built.ok) {
      throw new Error(`control refused ${built.code}/${String(built.source)}`);
    }
    expect(built.handoff.truthClass).toBe("DAEMON_VERIFIED");
  });

  it.each(CASES)("$label refuses with its own code, source and upstream", (entry) => {
    expect(refusalOf(entry.label, entry.drift as Drift)).toEqual(entry.expected);
  });
});

describe("release handoff sources — identity is never the caller's (task-a20e8ef6)", () => {
  it("refuses FOREIGN when the caller names a session the activation does not own", () => {
    const built = buildReleaseHandoff(world("foreign-session").store, {
      attemptRef: ATTEMPT, nodeKey: NODE_KEY, projectId: PROJECT_ID,
      sessionId: "session-somebody-else",
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    // The DURABLE activation's own `ownerSessionRef` is what disagreed, so this is a
    // two-authority comparison and not the caller checked against itself.
    expect(built.code).toBe("RELEASE_HANDOFF_SOURCE_FOREIGN");
    expect(built.upstream).toEqual({
      code: "FOUNDATION_BINDING_SESSION_MISMATCH",
      layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
    });
  });

  it("refuses ABSENT when the caller names an attempt no activation bound", () => {
    const built = buildReleaseHandoff(world("foreign-attempt").store, {
      attemptRef: "attempt-never-activated", nodeKey: NODE_KEY, projectId: PROJECT_ID,
      sessionId: SESSION,
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_SOURCE_ABSENT");
    expect(built.source).toBeNull();
  });
});
