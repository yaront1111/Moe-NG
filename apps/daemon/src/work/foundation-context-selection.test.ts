import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationLimitKey } from "@moe/contracts";
import { selectContext } from "@moe/context";
import {
  createProjectConfigurationManifest,
  encodeProjectConfigurationManifest,
} from "@moe/core";
import { buildInputManifest, observeScope } from "@moe/runner";
import type {
  GitObserver, ScopeObservation, ScopePathObserver, WorkspaceInputEntry, WorkspaceInputManifest,
} from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
  EFFECT_ACTIVATE_PAYLOAD_KEYS,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  GOAL_ID, RUN_ID, SEALED_SUBMISSION_HASH, approvalPayload, approvalRecord, envelope,
  finalizeChain, hex64, sealedPlanningChain, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetCoverage } from "../budget/budget-coverage-reader.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION }
  from "../journal/journal-contracts.js";
import { runJournalAppendCommand } from "../journal/journal-append.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { readCurrentNodeClosure } from "../planning/node-closure-reader.js";
import { readApprovedCriteria, readApprovedPlan } from "../planning/planning-authority-reader.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import { PRINCIPAL_ID, PROJECT_ID, seedReadyProject } from "../recovery/restore-test-harness.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { finding, packageItems } from "../review/review-test-fixtures.js";
import { runReviewCommand } from "../review/review-services.js";
import { deriveDispatchAggregateId, encodeFoundationPayload } from "./foundation-attempt-codec.js";
import { FOUNDATION_RESERVATION_VERSION } from "./foundation-attempt-contracts.js";
import { commitFoundationPhase } from "./foundation-attempt-store.js";
import { deriveFoundationCaptureContextRecordDigest } from "./foundation-capture-context-contract.js";
import {
  commitFoundationCaptureContext, deriveFoundationCaptureRef, readFoundationCaptureContext,
} from "./foundation-capture-context-ledger.js";
import { createFoundationContextAuthority } from "./foundation-context-selection.js";
import type { FoundationContextSelectionResult } from "./foundation-context-selection.js";

/**
 * THE INTEGRATED FOUNDATION CONTEXT WORLD, seeded through PRODUCTION WRITERS ONLY.
 *
 * Nothing here hand-builds a durable record: the planning chain, the approval, the activation,
 * the dispatch reservation, the capture context, the project configuration, the provider profile,
 * the attempt journal and both review rounds are committed by the same code the daemon runs, and
 * every assertion reads them back through the same readers the composer uses. A world assembled
 * any other way would only prove the composer can copy a fixture.
 *
 * The accepted control is ONE world; every refusal arm is its OWN world, seeded short of exactly
 * the one fact the arm is about. No mock reader, no hand-built authority object, no raw accepted
 * event, no `NodeMission` spec file and no live-filesystem re-observation appears anywhere.
 */

const DECIDED_AT = "2026-08-22T00:00:00.000Z";
const ATTEMPT_ID = "attempt-1";
const SESSION_ID = "session-1";
const NODE_KEY = "dev-solo";
const HEAD_COMMIT = "9".repeat(40);
const OBSERVER_VERSION = "moe-scope-observer/1";
const DECLARED_PATHS = Object.freeze(["src/0.ts", "src/1.ts"]);
const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";
const CONTEXT_LIMIT_BYTES = 400_000;
const CONTEXT_LIMIT_SOURCE = "model card: claude-opus-5 200k window, output reserved";
const SLUG = "fctx";
const DIGEST = "a".repeat(64);
const LAYER = "FOUNDATION_CONTEXT_SELECTION";
const FINDING_DETAIL = "The completion node ships without the receipt its criterion requires.";
/** LIVE, not the epoch-1970 value the resource harness uses: the effect-session binding the
 *  journal append needs judges the lease deadline against `decidedAt`, so a stale deadline makes
 *  that one cell unreachable while every other reader still answers. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const ACTIVATION_AGGREGATE = deriveActivationAggregateId(`agg-${SLUG}`, `idem-${SLUG}`);

/** The frozen `foundation-context-matrix/1` roster, HAND-WRITTEN here rather than imported from
 *  the module under test: an expectation derived from its subject cannot constrain it. */
const MANDATORY_MATRIX: readonly (readonly [string, string])[] = Object.freeze([
  ["foundation.activation", "authority"],
  ["foundation.approved-plan", "plan"],
  ["foundation.budget-coverage", "budget"],
  ["foundation.criteria", "criteria"],
  ["foundation.graph", "graph"],
  ["foundation.input-tree", "input"],
  ["foundation.legal-next-commands", "commands"],
  ["foundation.node-closure", "node-authority"],
  ["foundation.objective", "objective"],
  ["foundation.policy", "policy"],
  ["foundation.workspace-scope", "scope"],
]);

const SELECTION = Object.freeze({
  modelRef: "model-ref-1",
  profileRef: PROFILE_REF,
  providerRef: "provider-ref-1",
  reasoningEffortRef: "reasoning-effort-ref-1",
  runtimeRef: "runtime-ref-1",
  snapshotRef: "snapshot-ref-1",
  structuredOutputSchemaRef: "structured-output-schema-ref-1",
});

/** This world's OWN activation envelope: this world's node/session identity and a LIVE lease
 *  deadline, with its sections FILTERED THROUGH THE PRODUCTION ROSTER rather than a hand-copied
 *  key list — the `effect.activate` payload shape is mid-migration, and a test that spelled the
 *  roster itself would police its own copy of a contract in motion. */
function activationBytes(): Uint8Array {
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${SLUG}`, leaseToken: `token-${SLUG}`, monotonicObservation: 500,
    ownerSessionRef: SESSION_ID, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: `token-${SLUG}`,
    ownerSessionRef: SESSION_ID,
  } as const;
  const claim = {
    claimId: `claim-${SLUG}`, claimedAt: DECIDED_AT, intentId: `intent-${SLUG}`,
    lockIdentity: `lock-${SLUG}`, wrapperIdentity: `wrapper-${SLUG}`,
  } as const;
  const sections: Record<string, unknown> = {
    activation: {
      attempt: {
        aggregateId: `agg-${SLUG}`, attemptId: ATTEMPT_ID, intentId: `intent-${SLUG}`,
        state: "LAUNCH_REQUESTED", version: 0,
      },
      claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
      lockIdentity: `lock-${SLUG}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
      tombstone: null, wrapperIdentity: `wrapper-${SLUG}`,
    },
    budget: { reservation: null },
    effect: {
      command: { kind: "claim" },
      intent: {
        aggregateId: `agg-${SLUG}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
        idempotencyKey: `idem-${SLUG}`, inputBinding: DIGEST, intentId: `intent-${SLUG}`,
        leaseBinding: lease, predecessorCursor: `cursor-${SLUG}`,
        protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
        state: "PENDING", version: 0,
      },
    },
    lease: { proof, record: lease },
    liveClaims: [{ dimension: SLUG, slotRef: `held-${SLUG}`, state: "RESERVED" }],
    slot: {
      dimension: SLUG, requestId: `req-${SLUG}`, slotRef: `slot-${SLUG}`,
      rows: [{
        capacityUnits: 1, effectIntentRef: `intent-ref-${SLUG}`, epoch: 1, external: false,
        fenceable: true, resourceId: `res-${SLUG}`, state: "ACTIVE",
      }],
    },
  };
  const payload: Record<string, unknown> = {};
  for (const key of EFFECT_ACTIVATE_PAYLOAD_KEYS) payload[key] = sections[key];
  return new TextEncoder().encode(JSON.stringify({
    commandId: `cmd-activate-${SLUG}`, correlationId: `corr-${SLUG}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND, payload,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const roots: string[] = [];
const stores: SqliteEventStore[] = [];

afterAll(() => {
  while (stores.length > 0) {
    try { stores.pop()?.close(); } catch { /* cleanup must not mask a failure */ }
  }
  for (const root of roots) rmSync(root, { force: true, maxRetries: 5, recursive: true });
});

const limitValue = (key: ProjectConfigurationLimitKey): number =>
  PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;

const CONSERVATIVE = Object.freeze({
  bytes: CONTEXT_LIMIT_BYTES, kind: "CONSERVATIVE_INPUT_BYTES", source: CONTEXT_LIMIT_SOURCE,
});

/** The probed provider profile. `contextLimit` is the ONE durable source of the byte budget. */
const profileBody = (contextLimit: Record<string, unknown> | null): Record<string, unknown> => ({
  capabilitySchemaDigest: hex64("ca9ab111"),
  concurrencyCeiling: limitValue("activeProviderSessions"),
  ...(contextLimit === null ? {} : { contextLimit }),
  limits: {
    stderrBytes: limitValue("capturedOutputBytes"),
    stdoutBytes: limitValue("capturedOutputBytes"),
    tailBytes: limitValue("uiTailBytes"),
    timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
  },
  modelSnapshotEvidence: "claude-cli-2.0.30-2026-05-01",
  modelSnapshotKind: "DATED_SNAPSHOT",
  profileRevisionId: PROFILE_REF,
  provider: "claude",
  providerMinimumProfileRef: MINIMUM_REF,
  reasoningEffort: "high",
  selectedModelId: "claude-opus-5",
  selection: SELECTION,
});

const settingsBody = (): Record<string, unknown> => ({
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({ key, value: limitValue(key) })),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: hex64("0c5") },
  policy: {
    acceptanceGate: "MANUAL_HUMAN_APPROVAL",
    autoApprovalOptInDigest: null,
    evaluatorVersion: "policy-evaluator-v1",
    expansionGate: "MANUAL_HUMAN_APPROVAL",
    planningGate: "MANUAL_HUMAN_APPROVAL",
    policyRevisionId: "policy-revision-1",
    revision: 1,
  },
  schemaVersions: {
    commandSchemaVersion: "moe-command-1",
    errorSchemaVersion: "moe-error-1",
    querySchemaVersion: "moe-query-1",
  },
  selection: SELECTION,
});

/** A REAL sealed manifest and a REAL scope observation, both from @moe/runner's own producers. */
function manifestFor(): WorkspaceInputManifest {
  const entries: WorkspaceInputEntry[] = DECLARED_PATHS.map((path, index) => ({
    byteLength: 8,
    path,
    producer: { kind: "BASE" as const },
    sha256: index.toString(16).padStart(64, "0"),
  }));
  const built = buildInputManifest({ baseIdentity: HEAD_COMMIT, entries });
  if (!built.ok) throw new Error(`manifest refused: ${built.code}`);
  return built.manifest;
}

function observationFor(root: string): ScopeObservation {
  const gitObserver: GitObserver = {
    headCommit: () => HEAD_COMMIT,
    lsFilesIgnored: () => [],
    lsFilesTracked: () => [...DECLARED_PATHS],
    statusPorcelainV2: () => new TextEncoder().encode(`# branch.oid ${HEAD_COMMIT}\0`),
    submodulePaths: () => [],
  };
  const pathObserver: ScopePathObserver = { exists: () => true, realpath: (path) => path };
  const result = observeScope({
    baseIdentity: HEAD_COMMIT,
    declaredScopePaths: [...DECLARED_PATHS],
    gitObserver,
    observedAt: DECIDED_AT,
    observerVersion: OBSERVER_VERSION,
    pathObserver,
    worktreeRoot: root,
  });
  if (!result.ok) throw new Error(`observation refused: ${result.code}`);
  return result.observation;
}

/** The capture candidate, bound to THIS world's attempt/session/node. `recordDigest` is derived,
 *  never spelled; `realSourceRepositoryRoot` and `realWorktreeParent` are seeded precisely so the
 *  rendered scope item can be asserted NOT to carry them. */
function captureCandidate(worktreeRoot: string): Record<string, unknown> {
  const manifest = manifestFor();
  const body: Record<string, unknown> = {
    artifactDeclaration: "NONE",
    assignment: {
      adopted: false,
      assignmentVersion: "moe-worktree-assignment/1",
      attemptId: ATTEMPT_ID,
      baseIdentity: HEAD_COMMIT,
      leaf: "proj-foundation-context-attempt-1",
      projectId: PROJECT_ID,
      realSourceRepositoryRoot: join("fixture-source", "repo"),
      realWorktreeParent: "fixture-parent",
      realWorktreePath: worktreeRoot,
      worktreePath: worktreeRoot,
    },
    attemptAggregateId: ACTIVATION_AGGREGATE,
    attemptId: ATTEMPT_ID,
    baselineDigest: manifest.sha256,
    catalogAuthority: {
      baseRevisionHash: HEAD_COMMIT,
      catalogDigest: "c".repeat(64),
      declaredPaths: [...DECLARED_PATHS],
      projectId: PROJECT_ID,
      repositoryRef: "repo-main",
      scopeRef: "scope-default",
      sourceRepositoryRoot: join("fixture-source", "repo"),
      worktreeParent: "fixture-parent",
    },
    inputManifest: manifest,
    nodeKey: NODE_KEY,
    observation: observationFor(worktreeRoot),
    observedAt: DECIDED_AT,
    projectId: PROJECT_ID,
    recordVersion: "moe-foundation-capture-context/1",
    requestDigest: "d".repeat(64),
    reservationDigest: "e".repeat(64),
    sessionId: SESSION_ID,
  };
  return { ...body, recordDigest: deriveFoundationCaptureContextRecordDigest(body) };
}

interface WorldOptions {
  readonly contextLimit?: Record<string, unknown> | null;
  readonly withApproval?: boolean;
  readonly withCapture?: boolean;
  readonly withJournal?: boolean;
  readonly reviewRounds?: number;
}

interface World {
  readonly configurationDigest: string;
  readonly captureRef: string;
  readonly path: string;
  readonly store: SqliteEventStore;
  readonly worktreeRoot: string;
}

const captureRefOf = (): string => deriveFoundationCaptureRef({
  attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: ATTEMPT_ID,
  nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

function seedReview(store: SqliteEventStore, rounds: number): void {
  for (let round = 1; round <= rounds; round += 1) {
    const request = {
      commandId: `cmd-review-round-${round}`, correlationId: "corr-foundation-context",
      decidedAt: DECIDED_AT, expectedVersion: round - 1, kind: "review.submit",
      payload: {
        findings: [finding({
          ruleId: `rule-round-${round}`, subject: { kind: "NODE", locator: NODE_KEY },
        })],
        packageItems: packageItems(), round, subjectRef: NODE_KEY,
      },
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID, schemaVersion: REVIEW_SCHEMA_VERSION,
    };
    const outcome = runReviewCommand(store, new TextEncoder().encode(JSON.stringify(request)));
    if (!outcome.ok) throw new Error(`review round ${round} refused: ${outcome.code}`);
  }
}

/** ONE store, every production writer, in the only order that admits them all. */
function world(label: string, options: WorldOptions = {}): World {
  const {
    contextLimit = { ...CONSERVATIVE }, reviewRounds = 2,
    withApproval = true, withCapture = true, withJournal = true,
  } = options;
  const root = mkdtempSync(join(tmpdir(), `moe-foundation-context-${label}-`));
  roots.push(root);
  const path = join(root, "project.db");
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  stores.push(store);
  // This world sends its own sealed plan and approval below. Seed the funded HUMAN graph first,
  // but leave the approval uncommitted so its command bytes and authority remain this world's.
  seedReadyProject(store, { approval: "DEFER" });
  const chain = [
    // A SECOND probe with its own command id and the next expected version: `seedReadyProject`
    // already sent one, and reusing its key is a command-bytes conflict, not a new observation.
    envelope("provider.probe", 1, {
      observation: {
        profile: profileBody(contextLimit), providerMinimumProfileRef: MINIMUM_REF,
        truthClass: "DAEMON_VERIFIED",
      },
    }, "cmd-provider-probe-context"),
    ...(withApproval ? [
      envelope("plan.propose", 0, { commands: sealedPlanningChain(), runId: RUN_ID }),
      envelope("plan.propose", 0, { commands: finalizeChain(), runId: RUN_ID }, "cmd-finalize"),
      envelope("approval.decide", 0, approvalPayload({
        record: {
          ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [NODE_KEY],
        },
      })),
    ] : []),
  ];
  for (const step of chain) {
    const outcome = send(store, step);
    if (!outcome.ok) throw new Error(`world seed refused at ${step.kind}: ${outcome.code}`);
  }
  const created = createProjectConfigurationManifest(PROJECT_ID, settingsBody());
  if (!created.ok) throw new Error(`manifest refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`manifest encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: "configuration-command-1", correlationId: "correlation-configuration-1",
    decidedAt: DECIDED_AT, expectedVersion: 0, manifestBytes: encoded.bytes,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  });
  if (!selected.ok) throw new Error(`configuration refused: ${selected.code}`);

  // The explicit missing-plan world must stop before activation: HUMAN_APPROVAL cannot admit an
  // activation without first creating the very approved plan this negative arm omits.
  if (!withApproval) {
    return {
      captureRef: captureRefOf(), configurationDigest: created.manifest.settingsDigest, path, store,
      worktreeRoot: join(root, "worktree"),
    };
  }

  const activated = runEffectActivateCommand(store, activationBytes());
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);

  // THE DISPATCH RESERVATION, exactly the body `foundation-attempt-service.ts` commits: the
  // journal writer reads the node key off it, so without this row the append refuses before any
  // entry is judged.
  const history = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const record = history.history.record;
  const reservation = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: ACTIVATION_AGGREGATE,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: NODE_KEY,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: DIGEST, sessionId: SESSION_ID,
  });
  if (!reservation.ok) throw new Error(`reservation refused: ${reservation.code}`);
  const reserved = commitFoundationPhase(store, Object.freeze({
    aggregateId: ACTIVATION_AGGREGATE, claim: {}, commandId: `cmd-dispatch-${SLUG}`,
    correlationId: `corr-dispatch-${SLUG}`, nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: SESSION_ID,
    target: deriveDispatchAggregateId(ACTIVATION_AGGREGATE),
  }), "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
  if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation was not committed");
  }

  if (withJournal) {
    // ONE REAL JOURNAL APPEND through the production command: the principal IS the attempt's
    // owner session, which is what the effect-session binding equality demands.
    const appended = runJournalAppendCommand(store, new TextEncoder().encode(JSON.stringify({
      commandId: `cmd-journal-${SLUG}`, correlationId: `corr-journal-${SLUG}`,
      decidedAt: DECIDED_AT, expectedVersion: 0, kind: JOURNAL_APPEND_COMMAND_KIND,
      payload: {
        attemptAggregateId: ACTIVATION_AGGREGATE,
        effectId: `intent-${SLUG}`,
        entries: [{
          actorId: SESSION_ID, baseDigest: DIGEST, environmentDigest: DIGEST,
          failureCode: "CONTEXT_WORLD_SEED_FAILED", id: "journal-entry-1", kind: "FAILED_APPROACH",
          occurredAt: DECIDED_AT, primaryScope: "src/0.ts", recipeDigest: DIGEST,
          retryPredicate: {
            expectedValue: "ready", factId: "fact-context-world",
            kind: "FACT_VALUE", operator: "EQUALS",
          },
          text: "The caller budget section is dead input and cannot be revived.",
        }],
      },
      principalId: SESSION_ID, projectId: PROJECT_ID,
      schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
    })));
    if (!appended.ok) throw new Error(`journal append refused: ${appended.code}`);
  }
  seedReview(store, reviewRounds);
  if (withCapture) {
    const sealed = commitFoundationCaptureContext(store, {
      candidate: captureCandidate(join(root, "worktree")), decidedAt: DECIDED_AT,
    });
    if (!sealed.ok) throw new Error(`capture refused: ${sealed.code}`);
  }
  return {
    captureRef: captureRefOf(), configurationDigest: created.manifest.settingsDigest, path, store,
    worktreeRoot: join(root, "worktree"),
  };
}

const IDENTITY = Object.freeze({
  attemptRef: ATTEMPT_ID, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

const authorityFor = (given: World, digest = given.configurationDigest) =>
  createFoundationContextAuthority({ expectedConfigurationDigest: digest, store: given.store });

const assembleFrom = (
  given: World, request: unknown = { ...IDENTITY }, digest = given.configurationDigest,
): FoundationContextSelectionResult =>
  authorityFor(given, digest).assembleFoundationContextSelection(request);

/** The raw durable position: the store's event horizon plus every recorded command decision,
 *  successful or refused. A read that appended anything moves one of the two. */
const rawCounts = (store: SqliteEventStore): { events: number; decisions: number } => ({
  decisions: readReviewLedger(store, PROJECT_ID, NODE_KEY).decisionCount,
  events: Number(store.readEventHorizon()),
});

function contentOf(result: FoundationContextSelectionResult, id: string): string {
  if (!result.ok) throw new Error(`expected an admitted selection, got ${result.code}`);
  const item = [...result.selection.mandatory, ...result.selection.optional]
    .find((held) => held.id === id);
  if (item === undefined) throw new Error(`no item ${id} in the selection`);
  return item.content;
}

/** Asserts a refusal WHOLE: exact code, exact layer, no selection or provenance leaked, and no
 *  durable write. Returns the refusal so an arm can go on to pin its upstream chain. */
function expectRefusal(
  store: SqliteEventStore, before: { events: number; decisions: number },
  result: FoundationContextSelectionResult, code: string, layer: string = LAYER,
): Extract<FoundationContextSelectionResult, { ok: false }> {
  expect(`${result.ok ? "admitted" : `${result.code}@${result.layer}`}`).toBe(`${code}@${layer}`);
  if (result.ok) throw new Error("unreachable: the refusal assertion above must have failed");
  expect("selection" in result).toBe(false);
  expect("provenance" in result).toBe(false);
  expect(rawCounts(store)).toEqual(before);
  return result;
}

describe("the server-derived Foundation context selection — accepted control", () => {
  it("admits every mandatory matrix item, both optional items, and a bound provenance", () => {
    const built = world("accepted");
    const { store } = built;
    const before = rawCounts(store);
    expect(before.events).toBeGreaterThan(0);
    expect(before.decisions).toBeGreaterThan(0);

    const result = assembleFrom(built);
    if (!result.ok) throw new Error(`assembly refused: ${result.code} (${result.detail})`);

    // BOTH DIRECTIONS against a hand-written roster: served-set equality, not a subset check.
    const served = result.selection.mandatory.map((item) => [item.id, item.section]).sort();
    expect(served).toEqual([...MANDATORY_MATRIX].map(([id, section]) => [id, section]).sort());
    expect(result.selection.mandatory.every((item) => item.kind === "MANDATORY")).toBe(true);
    expect(result.selection.optional.map((item) => [item.id, item.section, item.priority]))
      .toEqual([
        ["foundation.attempt-journal", "journal", 200],
        ["foundation.prior-findings", "findings", 100],
      ]);
    // Both optional cells are PRESENT, so neither exclusion may be claimed.
    expect(result.selection.exclusions).toEqual([]);
    expect(result.selection.ordering)
      .toBe("MANDATORY_ID_SECTION_CONTENT_ASC_OPTIONAL_PRIORITY_DESC_ID_SECTION_CONTENT_ASC");

    // BOTH review rounds' FULL finding bodies, not only the newest and not only a digest.
    const findings = contentOf(result, "foundation.prior-findings");
    for (const round of ["rule-round-1", "rule-round-2"]) expect(findings).toContain(round);
    expect(findings).toContain(FINDING_DETAIL);
    expect(findings).toContain('"highestRound":2');
    expect(findings).toContain(readReviewLedger(store, PROJECT_ID, NODE_KEY).lineage.digest);

    // The sealed capture manifest digest, and the real journal digest, both bound in provenance.
    const capture = readFoundationCaptureContext(store, built.captureRef);
    if (!capture.ok) throw new Error(`capture unreadable: ${capture.code}`);
    const bound = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT_ID);
    if (bound.status !== "BOUND") throw new Error("activation not bound");
    const journal = readCurrentAttemptJournal(store, bound.activationDigest, PROJECT_ID);
    if (!journal.ok) throw new Error(`journal unreadable: ${journal.code}`);
    const graph = readCurrentActiveGraph(store, PROJECT_ID);
    if (!graph.ok) throw new Error(`graph unreadable: ${graph.code}`);
    expect(result.provenance).toEqual({
      attemptRef: ATTEMPT_ID,
      configurationDigest: built.configurationDigest,
      contextLimitBytes: CONTEXT_LIMIT_BYTES,
      graphContentHash: graph.graphContentHash,
      graphEpoch: graph.graphEpoch,
      graphRevisionId: graph.revisionId,
      inputManifestSha256: capture.record.inputManifest.sha256,
      journalDigest: journal.journalDigest,
      journalHorizon: String(before.events),
      matrixVersion: "foundation-context-matrix/1",
      nodeKey: NODE_KEY,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });

    // The EXACT conservative limit object AND its source, from the durable profile — never a
    // default, never a capture ceiling, never a token count.
    const profile = resolveCurrentProviderProfile(store, {
      expectedConfigurationDigest: built.configurationDigest, projectId: PROJECT_ID,
    });
    if (!profile.ok) throw new Error(`profile unreadable: ${profile.code}`);
    expect(profile.contextLimit).toEqual(CONSERVATIVE);
    expect(result.selection.byteBudget).toBe(CONTEXT_LIMIT_BYTES);
    expect(result.selection.selectedBytes).toBeLessThanOrEqual(CONTEXT_LIMIT_BYTES);

    // DEEP FREEZE, all the way into an item, and ZERO writes from the whole read.
    expect(Object.isFrozen(result.selection)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
    const [first] = result.selection.mandatory;
    if (first === undefined) throw new Error("no mandatory item to freeze-check");
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { content: string }).content = "tampered";
    }).toThrow(TypeError);
    expect(rawCounts(store)).toEqual(before);
  });

  it("renders the same durable snapshot byte-identically, on re-read and after a reopen", () => {
    const built = world("stable");
    const once = assembleFrom(built);
    const twice = assembleFrom(built);
    // TWO CONCURRENT READERS over the SAME open store, interleaved: the authority holds no
    // per-call state a second reader could observe half-built.
    const [left, right] = [authorityFor(built), authorityFor(built)];
    const interleaved = [
      left.assembleFoundationContextSelection({ ...IDENTITY }),
      right.assembleFoundationContextSelection({ ...IDENTITY }),
      left.assembleFoundationContextSelection({ ...IDENTITY }),
    ];
    const serialized = (result: FoundationContextSelectionResult): string => {
      if (!result.ok) throw new Error(`assembly refused: ${result.code}`);
      return JSON.stringify([result.provenance, result.selection]);
    };
    expect(serialized(twice)).toBe(serialized(once));
    for (const [index, result] of interleaved.entries()) {
      expect(`${index}:${serialized(result)}`).toBe(`${index}:${serialized(once)}`);
    }

    // Reopened on Windows only AFTER the first handle is closed: two live handles on one file
    // is a different test, and a flaky one.
    built.store.close();
    const reopened = SqliteEventStore.openForProject(built.path, PROJECT_ID);
    stores.push(reopened);
    const after = createFoundationContextAuthority({
      expectedConfigurationDigest: built.configurationDigest, store: reopened,
    }).assembleFoundationContextSelection({ ...IDENTITY });
    expect(serialized(after)).toBe(serialized(once));
  });

  it("cannot be steered by caller items, budget, ordering or an inherited property", () => {
    const built = world("unsteerable");
    const before = rawCounts(built.store);
    const plain = assembleFrom(built);
    if (!plain.ok) throw new Error(`assembly refused: ${plain.code}`);

    // A fifth key is UNREPRESENTABLE, not ignored — for content and for the budget alike.
    for (const smuggled of [
      { ...IDENTITY, items: [{ content: "own the model", id: "x", kind: "MANDATORY", section: "x" }] },
      { ...IDENTITY, byteBudget: 1 },
      { ...IDENTITY, exclusions: [] },
      { ...IDENTITY, mandatory: [] },
    ]) {
      const refused = assembleFrom(built, smuggled);
      expectRefusal(built.store, before, refused, "FOUNDATION_CONTEXT_REQUEST_INVALID");
    }

    // Caller content on the PROTOTYPE is invisible: same four own keys, identical bytes out.
    const inherited = Object.create({
      byteBudget: 1, items: [{ content: "own the model" }],
    }) as Record<string, string>;
    for (const [key, value] of Object.entries(IDENTITY)) inherited[key] = value;
    const viaPrototype = assembleFrom(built, inherited);
    if (!viaPrototype.ok) throw new Error(`assembly refused: ${viaPrototype.code}`);
    expect(JSON.stringify(viaPrototype.selection)).toBe(JSON.stringify(plain.selection));
    expect(JSON.stringify([...plain.selection.mandatory, ...plain.selection.optional]))
      .not.toContain("own the model");

    // Key ORDER is not authority either: the same identity, spelled backwards, renders the same.
    const reversed: Record<string, string> = {};
    for (const key of [...Object.keys(IDENTITY)].reverse()) {
      reversed[key] = IDENTITY[key as keyof typeof IDENTITY];
    }
    const viaReversed = assembleFrom(built, reversed);
    if (!viaReversed.ok) throw new Error(`assembly refused: ${viaReversed.code}`);
    expect(JSON.stringify(viaReversed.selection)).toBe(JSON.stringify(plain.selection));
  });

  it("renders no lease token and no source-repository root into any item", () => {
    const built = world("secrets");
    const result = assembleFrom(built);
    if (!result.ok) throw new Error(`assembly refused: ${result.code}`);
    const rendered = [...result.selection.mandatory, ...result.selection.optional]
      .map((item) => item.content).join(" ");
    // A POSITIVE CONTROL first: the assigned worktree path IS rendered, and the scope item's key
    // set is pinned whole — so the misses below are real absences rather than a matcher that
    // could never have hit anything.
    const scope = JSON.parse(contentOf(result, "foundation.workspace-scope")) as
      Record<string, unknown>;
    expect(scope["worktreePath"]).toBe(built.worktreeRoot);
    expect(Object.keys(scope).sort()).toEqual([
      "baseRevisionHash", "catalogDigest", "declaredPaths", "observationDigest", "readScopes",
      "repositoryRef", "scopeRef", "worktreeIdentity", "worktreePath",
    ]);
    // Every one of these is SEEDED into durable state this world reads, so a leak would be a hit.
    for (const secret of [`token-${SLUG}`, "fixture-parent", "leaseToken", "bootId",
      join("fixture-source", "repo")]) {
      expect(`${secret}:${rendered.includes(secret)}`).toBe(`${secret}:false`);
    }
  });
});

describe("the server-derived Foundation context selection — refusals", () => {
  it("refuses every request that is not exactly four identity strings", () => {
    const built = world("requests");
    const before = rawCounts(built.store);
    const withGetter = {};
    Object.defineProperty(withGetter, "attemptRef", { enumerable: true, get: () => ATTEMPT_ID });
    for (const key of ["nodeKey", "projectId", "sessionId"] as const) {
      Object.defineProperty(withGetter, key, { enumerable: true, value: IDENTITY[key] });
    }
    const hostile: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["undefined", undefined],
      ["string", "attempt-1"],
      ["array", [ATTEMPT_ID, NODE_KEY, PROJECT_ID, SESSION_ID]],
      ["missing key", { attemptRef: ATTEMPT_ID, nodeKey: NODE_KEY, projectId: PROJECT_ID }],
      ["extra key", { ...IDENTITY, extra: "x" }],
      ["symbol key", Object.assign({ ...IDENTITY }, { [Symbol("s")]: 1 })],
      ["accessor key", withGetter],
      ["nonstring", { ...IDENTITY, attemptRef: 1 }],
      ["empty", { ...IDENTITY, nodeKey: "" }],
      ["over-long", { ...IDENTITY, sessionId: "s".repeat(513) }],
      ["prototype only", Object.create({ ...IDENTITY }) as unknown],
    ];
    expect(hostile.length).toBeGreaterThan(0);
    const port = authorityFor(built);
    for (const [label, request] of hostile) {
      // NOT through the defaulted helper: an explicit `undefined` there would silently become
      // the valid identity and this arm would grade nothing.
      const result = port.assembleFoundationContextSelection(request);
      expect(`${label}:${result.ok ? "admitted" : result.code}`)
        .toBe(`${label}:FOUNDATION_CONTEXT_REQUEST_INVALID`);
      expectRefusal(built.store, before, result, "FOUNDATION_CONTEXT_REQUEST_INVALID");
    }
  });

  it("refuses a foreign session, node, attempt or project with the layer that decided", () => {
    const built = world("foreign");
    const before = rawCounts(built.store);

    const foreignSession = assembleFrom(built, { ...IDENTITY, sessionId: "session-2" });
    expectRefusal(built.store, before, foreignSession, "FOUNDATION_CONTEXT_BINDING_MISMATCH");

    const foreignNode = assembleFrom(built, { ...IDENTITY, nodeKey: "node-absent" });
    const nodeRefusal =
      expectRefusal(built.store, before, foreignNode, "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect(nodeRefusal.source).toMatchObject({
      code: "NODE_CLOSURE_NODE_UNKNOWN", layer: "NODE_CLOSURE_READER", outcome: "UNKNOWN",
    });

    const foreignAttempt = assembleFrom(built, { ...IDENTITY, attemptRef: "attempt-absent" });
    const attemptRefusal =
      expectRefusal(built.store, before, foreignAttempt, "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect(attemptRefusal.source).toMatchObject({
      code: "FOUNDATION_BINDING_NOT_FOUND", status: "ABSENT",
    });

    const foreignProject = assembleFrom(built, { ...IDENTITY, projectId: "project-2" });
    const projectRefusal =
      expectRefusal(built.store, before, foreignProject, "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect((projectRefusal.source as { ok?: unknown }).ok).toBe(false);
  });

  it("refuses a configuration binding that is not the accepted server digest", () => {
    const built = world("binding");
    const before = rawCounts(built.store);
    for (const bad of ["", "not-a-digest", "A".repeat(64), `${DIGEST}0`]) {
      const result = assembleFrom(built, { ...IDENTITY }, bad);
      expectRefusal(
        built.store, before, result, "FOUNDATION_CONTEXT_CONFIGURATION_BINDING_INVALID");
    }
    // A WELL-FORMED digest that is simply not this project's reaches the resolver and is refused
    // there — a different layer, and the chain has to say so.
    const wrong = assembleFrom(built, { ...IDENTITY }, DIGEST);
    const refusal = expectRefusal(built.store, before, wrong, "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect(refusal.source).toMatchObject({
      authority: "NONE", layer: "PROVIDER_PROFILE_READER", outcome: "UNKNOWN",
    });
  });

  it("refuses an absent plan and an absent capture context, each naming its reader", () => {
    const unapproved = world("unapproved", { withApproval: false });
    const planRefusal = expectRefusal(unapproved.store, rawCounts(unapproved.store),
      assembleFrom(unapproved), "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect(planRefusal.source).toMatchObject({
      code: "PLANNING_AUTHORITY_READER_APPROVAL_ABSENT", layer: "PLANNING_AUTHORITY_READER",
    });
    // The reader really is the one that answered: the same world's plan read refuses identically.
    expect(readApprovedPlan(unapproved.store, PROJECT_ID, GOAL_ID).ok).toBe(false);
    expect(readApprovedCriteria(unapproved.store, PROJECT_ID, GOAL_ID).ok).toBe(false);

    const uncaptured = world("uncaptured", { withCapture: false });
    const captureRefusal = expectRefusal(uncaptured.store, rawCounts(uncaptured.store),
      assembleFrom(uncaptured), "FOUNDATION_CONTEXT_SOURCE_REFUSED");
    expect(captureRefusal.source).toMatchObject({
      code: "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT", ok: false,
    });
  });

  it("refuses an UNKNOWN and a token-only context limit rather than inventing bytes", () => {
    const unknown = world("unknown-limit", { contextLimit: null });
    expect(resolveCurrentProviderProfile(unknown.store, {
      expectedConfigurationDigest: unknown.configurationDigest, projectId: PROJECT_ID,
    })).toMatchObject({ contextLimit: { kind: "UNKNOWN" } });
    expectRefusal(unknown.store, rawCounts(unknown.store), assembleFrom(unknown),
      "FOUNDATION_CONTEXT_LIMIT_UNKNOWN");

    const tokens = world("token-limit", {
      contextLimit: { kind: "EXACT_TOKENS", source: "model card: 200k tokens", tokens: 200_000 },
    });
    expectRefusal(tokens.store, rawCounts(tokens.store), assembleFrom(tokens),
      "FOUNDATION_CONTEXT_LIMIT_UNSUPPORTED");
  });

  it("passes the selector's own budget verdicts through with code AND layer unchanged", () => {
    // The durable profile codec admits only POSITIVE SAFE INTEGERS, so an invalid budget cannot
    // be reached through an accepted profile. Pin the package contract directly instead, and use
    // the REACHABLE overflow to prove this module preserves the selector's attribution.
    for (const byteBudget of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(selectContext({ byteBudget, exclusions: [], mandatory: [], optional: [] }))
        .toMatchObject({ code: "INVALID_CONTEXT_BUDGET", layer: "CONTEXT_SELECTION" });
    }
    const tiny = world("oversize", {
      contextLimit: { bytes: 8, kind: "CONSERVATIVE_INPUT_BYTES", source: "an eight byte window" },
    });
    const before = rawCounts(tiny.store);
    const result = assembleFrom(tiny);
    expectRefusal(tiny.store, before, result, "CONTEXT_TOO_LARGE", "CONTEXT_SELECTION");
  });

  it("excludes a readably absent journal and a readably empty review lineage, by name", () => {
    const bare = world("bare-optional", { reviewRounds: 0, withJournal: false });
    const bound = readFoundationActivationByAttempt(bare.store, PROJECT_ID, ATTEMPT_ID);
    if (bound.status !== "BOUND") throw new Error("activation not bound");
    // The two absences are READABLE ones, proven at the readers before the composer speaks.
    expect(readCurrentAttemptJournal(bare.store, bound.activationDigest, PROJECT_ID))
      .toMatchObject({ code: "JOURNAL_RECORD_ABSENT", ok: false });
    expect(readReviewLedger(bare.store, PROJECT_ID, NODE_KEY).lineage.records).toEqual([]);

    const result = assembleFrom(bare);
    if (!result.ok) throw new Error(`assembly refused: ${result.code}`);
    expect(result.selection.optional).toEqual([]);
    expect(result.selection.exclusions).toEqual([
      { itemId: "foundation.attempt-journal", reason: "JOURNAL_RECORD_ABSENT" },
      { itemId: "foundation.prior-findings", reason: "NO_DURABLE_REVIEW_FINDINGS" },
    ]);
    expect(result.provenance.journalDigest).toBeNull();
    expect(result.selection.mandatory.length).toBe(MANDATORY_MATRIX.length);
  });

  it("refuses when the durable ledger moves under the read, and when the store is gone", () => {
    const moving = world("moving");
    const real = moving.store;
    let reads = 0;
    let triggerAt = Number.POSITIVE_INFINITY;
    let writerRan = false;
    /** A REAL production writer, sequenced to commit between the composer's last inner read and
     *  its closing horizon read. The proxy only ORDERS the write: it invents no data, answers no
     *  reader, and every method still executes on the real store. Methods are bound to the target
     *  because `SqliteEventStore` uses private fields a proxy receiver cannot reach. */
    const fenced = new Proxy(real, {
      get(target, property, receiver): unknown {
        if (property !== "readEventHorizon") {
          const held: unknown = Reflect.get(target, property, receiver);
          return typeof held === "function" ? held.bind(target) : held;
        }
        return (): bigint => {
          reads += 1;
          if (reads === triggerAt) {
            seedReview(real, 3);
            writerRan = true;
          }
          return real.readEventHorizon();
        };
      },
    });
    const port = createFoundationContextAuthority({
      expectedConfigurationDigest: moving.configurationDigest, store: fenced,
    });
    // Pass one COUNTS the horizon reads of a clean assembly and writes nothing; pass two fires
    // the real writer on the last of them, which is the composer's closing fence read.
    const clean = port.assembleFoundationContextSelection({ ...IDENTITY });
    expect(clean.ok).toBe(true);
    expect(reads).toBeGreaterThan(1);
    triggerAt = reads;
    reads = 0;
    const before = Number(real.readEventHorizon());
    const result = port.assembleFoundationContextSelection({ ...IDENTITY });
    expect(writerRan).toBe(true);
    expect(Number(real.readEventHorizon())).toBeGreaterThan(before);
    expect(result.ok ? "admitted" : `${result.code}@${result.layer}`)
      .toBe(`FOUNDATION_CONTEXT_SNAPSHOT_MOVED@${LAYER}`);

    const closed = world("closed");
    closed.store.close();
    const gone = assembleFrom(closed);
    expect(gone.ok ? "admitted" : `${gone.code}@${gone.layer}`)
      .toBe(`FOUNDATION_CONTEXT_STORE_UNAVAILABLE@${LAYER}`);
    if (gone.ok) throw new Error("unreachable");
    // A store fault is a FIXED sentence and no source: a path or a corruption mode is not the
    // caller's to see.
    expect(gone.source).toBeNull();
    expect(gone.detail).toBe("the durable store could not be read");
  });

  it("keeps the budget cell bound to the graph the rest of the context came from", () => {
    // Not a drill: the accepted world's own budget binding IS the graph revision and epoch the
    // composer served, so the cross-binding this arm names is a live equality rather than prose.
    const built = world("budget-binding");
    const graph = readCurrentActiveGraph(built.store, PROJECT_ID);
    if (!graph.ok) throw new Error(`graph unreadable: ${graph.code}`);
    const budget = readCurrentBudgetCoverage(built.store, PROJECT_ID, graph.provenance.goalRef);
    if (!budget.ok) throw new Error(`budget unreadable: ${budget.code}`);
    expect([budget.binding.graphRevisionRef, budget.binding.graphEpoch])
      .toEqual([graph.revisionId, graph.graphEpoch]);
    const result = assembleFrom(built);
    if (!result.ok) throw new Error(`assembly refused: ${result.code}`);
    expect(contentOf(result, "foundation.budget-coverage")).toContain(graph.revisionId);
    expect(result.provenance.graphRevisionId).toBe(graph.revisionId);
    // And the node closure the objective/policy/scope cells project really is this graph's.
    const closure = readCurrentNodeClosure(built.store, PROJECT_ID);
    if (!closure.ok) throw new Error("closure unreadable");
    expect(closure.graphContentHash).toBe(result.provenance.graphContentHash);
  });
});
