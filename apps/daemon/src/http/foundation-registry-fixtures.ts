import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProviderRuntimeObservation, deriveWorktreeTarget, hermeticGitEnvironment,
} from "@moe/runner";
import type { ProviderRuntimeObservation } from "@moe/runner";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import {
  createAcceptanceContract, createPlanRevision, reduceGraphRevision,
} from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphRevisionContent, GraphSnapshot, NodeAuthoritySection, NodeDefinition,
} from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { graphRevisionAggregateId } from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import type { CommandAdapterDeps, HttpCommandRequest } from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import {
  ACTIVATION_WITNESS, PROVIDER_OBSERVATION, envelope as bootstrapEnvelope,
  send as sendBootstrap,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedActivationWorld } from "../activation/activation-world-fixtures.js";
import { PRINCIPAL_ID, PROJECT_ID } from "../recovery/restore-test-harness.js";
import { deriveDispatchAggregateId } from "../work/foundation-attempt-contracts.js";

/**
 * INPUTS ONLY for the foundation command-seam suites. Every fixture builds a store, a
 * request or a payload; no boundary, codec or service rule is re-implemented here, so
 * the assertions in the test files always run against production code.
 *
 * The activation blob below is the ingress's OWN request shape, carried verbatim: a
 * coherent activation cannot be hand-forged (the grant id is derived from the whole
 * successor intent), so the only way to reach the durable path is to hand production
 * the bytes it would have accepted anyway.
 */

const encoder = new TextEncoder();
const roots: string[] = [];

export const CREDENTIAL = "foundation-operator-credential";
export const DECIDED_AT = "2026-08-15T00:00:00.000Z";
export const NODE_KEY = "dev-done";
export const SESSION_ID = "session-1";

const DIGEST = "a".repeat(64);
const DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64);

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

/**
 * A REAL repository behind the seam, because the production composition now
 * prepares a workspace before it may launch. SHA-256 objects so the head is 64
 * hex and can be bound as the durable observation the resolver reads.
 */
const REPOSITORY = (() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-seam-repo-")));
  roots.push(root);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "moe-seam-trees-")));
  roots.push(parent);
  const paths = ["scope/alpha.txt", "scope/beta.txt"] as const;
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, paths[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, paths[1]), Buffer.from("beta\n", "utf8"));
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["add", "--", ...paths]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "foundation base",
  ]);
  const catalogPath = join(realpathSync(mkdtempSync(join(tmpdir(), "moe-seam-catalog-"))), "c.json");
  roots.push(join(catalogPath, ".."));
  writeFileSync(catalogPath, JSON.stringify({
    catalogVersion: "moe-foundation-repository-scope-catalog/1",
    entries: [{
      declaredPaths: [...paths], projectId: PROJECT_ID, repositoryRef: "repo-1",
      scopeRef: "scope-1", sourceRepositoryRoot: root, worktreeParent: parent,
    }],
  }), "utf8");
  return { catalogPath, head: runGit(root, ["rev-parse", "HEAD"]), parent, paths, root };
})();

const HEAD = REPOSITORY.head;

/** The catalog an OUT-OF-PROCESS daemon must be pointed at to resolve the same workspace
 *  authority these fixtures seed, via `MOE_FOUNDATION_WORKSPACE_CATALOG`. */
export const FOUNDATION_SEAM_CATALOG_PATH = REPOSITORY.catalogPath;
export const FOUNDATION_SEAM_REPOSITORY_HEAD = HEAD;

/** The worktree this attempt derives. Computing it is not choosing it. */
const DERIVED_WORKTREE = (() => {
  const derived = deriveWorktreeTarget({
    attemptId: "attempt-1", baseIdentity: HEAD, projectId: PROJECT_ID,
    sourceRepositoryRoot: REPOSITORY.root, worktreeParent: REPOSITORY.parent,
  });
  if (!derived.ok) throw new Error(`worktree fixture refused: ${derived.code}`);
  return derived.target.worktreePath;
})();

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: SESSION_ID,
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: SESSION_ID,
} as const;
const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const BUDGET_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN", version: 2,
} as const;
const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;
const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;
const CLAIM = {
  claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
} as const;
const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

export const ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);
export const DISPATCH_AGGREGATE = deriveDispatchAggregateId(ACTIVATION_AGGREGATE);

/** The activation command the daemon's own ingress admits, as raw bytes. */
export function activationBytes(commandId = "cmd-activation-1"): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: "corr-foundation", decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: ACTIVATION_SECTION,
      budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/**
 * The graph the seam now DERIVES rather than receives. It is seeded as a durable ACTIVE
 * revision by `seamHarness`, so the dispatch payload no longer carries it at all — the
 * multi-node refusal keeps its home in the service's own suite, where the request is
 * built directly and a second execution-bearing node can still be presented.
 */
const SEEDED_GRAPH: GraphSnapshot = Object.freeze({
  completionNodeKey: NODE_KEY, edges: [], nodes: [{ executionBearing: true, nodeKey: NODE_KEY }],
});

/** A digest-bound quote from the runner's own observation builder, never hand-written. */
function runtimeQuote(): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0",
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "C:\\installed\\claude.exe", sha256: DIGEST_A },
    ] as never,
  });
  if (!built.ok) throw new Error(`runtime quote fixture refused: ${built.code}`);
  return built.observation;
}

const LAUNCH_TEMPLATE = Object.freeze({
  argv: ["--print", "hello", "--model", "claude-opus-5", "--effort", "high"],
  bootstrapCredentialDigest: DIGEST_B, cwd: DERIVED_WORKTREE, environment: {},
  launchSelection: {
    concurrencyCeiling: 4, configurationDigest: "1c".repeat(32),
    modelSnapshotEvidence: "claude-opus-5/build-2026-05-14",
    modelSnapshotKind: "DATED_SNAPSHOT", orchestrationDigest: "3e".repeat(32),
    policyDigest: "2d".repeat(32), profileRevisionId: "profile-revision-19",
    provider: "claude", reasoningEffort: "high", selectedModelId: "claude-opus-5",
  },
  limits: { stderrBytes: 1_024, stdoutBytes: 1_024, tailBytes: 256, timeoutMs: 1_000 },
  runtime: {
    installedRoot: "C:\\installed", pinRoot: "C:\\pins", quotedObservation: runtimeQuote(),
  },
});

export interface PayloadOverrides {
  readonly binding?: unknown;
  readonly bytesBase64?: unknown;
  readonly omitBytes?: boolean;
}

/** The transport payload: the activation blob travels as base64 inside the JsonObject. */
export function dispatchPayload(
  overrides: PayloadOverrides = {},
): Readonly<Record<string, JsonValue>> {
  const payload: Record<string, unknown> = {
    binding: overrides.binding
      ?? { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
    launchTemplate: structuredClone(LAUNCH_TEMPLATE),
  };
  if (overrides.omitBytes !== true) {
    payload["activationRequestBytesBase64"] = overrides.bytesBase64 === undefined
      ? Buffer.from(activationBytes()).toString("base64")
      : overrides.bytesBase64;
  }
  return payload as Readonly<Record<string, JsonValue>>;
}

export interface EnvelopeOverrides {
  readonly commandId?: string;
  readonly commandKind?: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
}

export function commandRequest(overrides: EnvelopeOverrides & {
  readonly credential?: string | null;
} = {}): HttpCommandRequest {
  const credential = overrides.credential === undefined ? CREDENTIAL : overrides.credential;
  return {
    body: encoder.encode(JSON.stringify({
      commandId: overrides.commandId ?? "cmd-foundation-1",
      commandKind: overrides.commandKind ?? "foundation.dispatch",
      correlationId: "corr-foundation", expectedVersion: 0,
      payload: overrides.payload ?? dispatchPayload(),
      requestDigest: DIGEST, schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: ACTIVATION_AGGREGATE,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

/**
 * The durable ACTIVE graph revision the dispatch derivation reads. Driven through the
 * REAL revision reducer and committed as the events it actually emitted — a hand-written
 * event shape would let the derivation pass against a history production never writes.
 */
// --- v3 node-authority fixtures (task-8c7e6ce4) ------------------------------

/**
 * `GraphRevisionContent` v3 (task-6ba1ff89) makes `nodeAuthority` MANDATORY, and
 * `encodeGraphContent` RE-DERIVES the set it is handed rather than adopting it
 * (`graph-content.ts:120-141`), so a hand-built section can never pass. Everything below
 * COMPOSES the published producers — `createPlanRevision` / `createAcceptanceContract`
 * (@moe/core), then `createNodeDefinition` and `deriveNodeAuthoritySet` (@moe/scheduler) —
 * and judges nothing: each helper hands back what production returned, or throws carrying
 * production's own code, so a fixture that stopped building is never mistaken for a
 * boundary that stopped refusing.
 */
const AUTHORITY_HEX = (digit: string): string => digit.repeat(64);

const planDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: [...nodeKeys],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a"],
});

const acceptanceDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  applicability: {
    graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: [...nodeKeys], nodeKind: "LEAF",
  },
  authorRef: "principal-a",
  contractId: "acceptance-contract-a",
  obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-a"],
  }],
});

/** Admitted by PRODUCTION or not built at all: a body the codec refuses could never reach
 *  the encode this fixture exists to feed. */
function nodeDefinitionFor(nodeKey: string, snapshot: GraphSnapshot): NodeDefinition {
  const nodeKeys = snapshot.nodes.map((node) => node.nodeKey);
  const plan = createPlanRevision(planDraftFor(nodeKeys));
  if (!plan.ok) throw new Error(`plan revision fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(acceptanceDraftFor(nodeKeys));
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const completes = nodeKey === snapshot.completionNodeKey;
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract,
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: "runner.authorized_ms", purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "POLICY_ALLOWANCE",
      capability: "capability-implement",
      completionLinkage: completes ? nodeKey : null,
      constraints: ["constraint-a"],
      directHardDependencies: [],
      joinRole: completes ? "COMPLETION" : "NONE",
      nodeKey,
      objective: `Land ${nodeKey}.`,
      policySliceHash: AUTHORITY_HEX("3"),
      readScopes: ["services/api/src"],
      repositoryBaseTree: AUTHORITY_HEX("4"),
      resources: ["resource-a"],
      verificationRecipeRevisions: ["recipe-a"],
      writeScopes: ["services/api/src/node"],
    },
    planRevision: plan.revision,
    predicateRegistry: [],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

/**
 * The authenticated half of a v3 record. `definitions` is sorted by `nodeKey` because
 * `readAuthoritySection` requires the two arrays index-aligned and STRICTLY ASCENDING
 * (`graph-content-fields.ts:121-147`), and `deriveNodeAuthoritySet` already returns its
 * entries in that order. `authorities` is the PRODUCER'S own value, never a rebuilt one:
 * `bindAuthority` re-derives and refuses GRAPH_CONTENT_AUTHORITY_DISAGREEMENT on any
 * stated set that is not the derived one.
 */
function authoritySectionFor(snapshot: GraphSnapshot): NodeAuthoritySection {
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  const definitions = snapshot.nodes
    .map((node) => node.nodeKey)
    .slice()
    .sort()
    .map((nodeKey) => nodeDefinitionFor(nodeKey, snapshot));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return { authorities: derived.value, definitions };
}

function seedActiveGraph(store: SqliteEventStore): void {
  const content: GraphRevisionContent = {
    author: "human:architect-primary", completionNode: NODE_KEY, decompositionBudget: 24,
    nodeAuthority: authoritySectionFor(SEEDED_GRAPH),
    parentRevision: "rev-000000000000", policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40), snapshot: SEEDED_GRAPH,
  };
  const encodedGraph = encodeGraphContent(content);
  if (!encodedGraph.ok) throw new Error("seam graph fixture failed to encode");
  const graphHash = encodedGraph.value.graphContentHash;
  const seededHash = (seed: string): string => seed.repeat(64).slice(0, 64);
  const binding = {
    budgetHash: seededHash("55"), expectedGoalVersion: 3, graphHash,
    policyHash: seededHash("66"), qualityHash: seededHash("33"),
  } as const;
  const revisionId = "graph-revision-1";
  const steps = [
    {
      commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
      graphContentHash: graphHash, kind: "graph_revision.create",
      planHash: seededHash("11"), revisionId,
    },
    {
      commandId: "cmd-submit", expectedVersion: 1, kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
    },
    {
      activation: { ...binding, activationRef: "activation-1", graphEpoch: 1, truthClass: "HUMAN_APPROVED" },
      approval: { ...binding, approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" },
      commandId: "cmd-approve", expectedVersion: 2, kind: "graph.approve",
    },
  ] as never[];
  let current: never | undefined;
  const events: { kind: string }[] = [];
  for (const step of steps) {
    const result = reduceGraphRevision(current, step);
    if (!result.ok) throw new Error(`seam graph fixture rejected: ${result.error.code}`);
    current = result.state as never;
    events.push(...(result.events as readonly { kind: string }[]));
  }
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId, commandBytes: encoder.encode(`seed-${revisionId}`),
    commandId: `seed-${revisionId}`, committedAt: DECIDED_AT,
    events: events.map((event, index) => ({
      eventId: `seed-${revisionId}-${index}`, eventType: event.kind,
      payload: encoder.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  const stored = putGraphBody(store, PROJECT_ID, encodedGraph.value);
  if (!stored.ok) throw new Error(`seam graph body refused: ${stored.code}`);
}

export interface SeamHarness {
  readonly close: () => void;
  readonly deps: CommandAdapterDeps;
  readonly storePath: string;
}

/**
 * A REAL store behind the REAL registry: the project is seeded through production
 * bootstrap commands and the ports come from `createStoreDependencies`, so nothing
 * below the seam is a double.
 */
export interface SeamHarnessOptions {
  /** Omitted models a project whose ACTIVE graph revision was never written, which is the
   *  only way to exercise the derivation's own refusal arm through the real seam. */
  readonly seedGraph?: boolean;
}

export function seamHarness(label: string, options: SeamHarnessOptions = {}): SeamHarness {
  const root = mkdtempSync(join(tmpdir(), `moe-foundation-seam-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");
  // GENESIS FIRST, on a store with no history at all. `ensureGenesisRecoveryBinding`
  // refuses to install onto a store that already carries recovery history, and a
  // test-installed binding leaves the store under a recovery embargo that refuses every
  // activation with RECOVERY_RECONCILIATION_REQUIRED — both measured, not assumed.
  const provider = createStoreDependencies({
    clock: () => DECIDED_AT,
    credential: CREDENTIAL,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    storePath,
    // The production composition prepares a workspace before it may launch, so
    // the seam gets a REAL catalog. Without it every dispatch would stop at
    // preparation and these suites would no longer reach the launcher they exist
    // to test — and this is also the only place the whole provider -> registry ->
    // command -> service wiring is driven by production code end to end.
    workspaceCatalogPath: REPOSITORY.catalogPath,
  });
  seedFoundationStore(storePath, options);
  return Object.freeze({
    close: () => {
      provider.close();
    },
    deps: provider.provide(),
    storePath,
  });
}

/**
 * The durable world a Foundation dispatch needs, written through production seams into a
 * store the caller owns — so a LIVE daemon started on the same file finds it already there.
 */
export function seedFoundationStore(
  storePath: string, options: SeamHarnessOptions = {},
): void {
  const seed = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    // The four commands `seedReadyProject` drives, with the bound observation
    // carrying the fixture repository's real head; a bind cannot be appended
    // after activation, so the sequence is driven here rather than patched.
    for (const [kind, version, payload] of [
      ["project.register", 0, { owner: "owner-1" }],
      ["project.bind_repository", 1, {
        observation: {
          baseRevisionHash: HEAD, repositoryRef: "repo-1", scopeRef: "scope-1",
          truthClass: "DAEMON_VERIFIED",
        },
      }],
      ["provider.probe", 0, { observation: PROVIDER_OBSERVATION }],
      ["project.activate", 2, { witness: ACTIVATION_WITNESS }],
    ] as readonly (readonly [string, number, Record<string, unknown>])[]) {
      const outcome = sendBootstrap(seed, bootstrapEnvelope(kind, version, payload));
      if (!outcome.ok) throw new Error(`seam fixture ${kind} refused: ${outcome.code}`);
    }
    if (options.seedGraph !== false) {
      seedActiveGraph(seed);
      // The goal and authorized budget root that go with it: `effect.activate` now derives its
      // budget from durable project/goal/graph/node facts instead of the caller's payload
      // section. Idempotent, and ordered AFTER the seam's own revision on purpose — it enriches
      // the world rather than rebuilding it, so the graph above is left exactly as it is. The
      // `seedGraph: false` world stays deliberately empty: it is the durable home of the
      // graph-absent refusal, and seeding it would delete that coverage.
      seedActivationWorld(seed);
    }
  } finally {
    seed.close();
  }
}

/** Every scratch root this module handed out, removed together. */
export function cleanupSeamHarnesses(): void {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}
