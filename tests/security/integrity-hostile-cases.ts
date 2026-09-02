/**
 * HOSTILE CASE TABLE — the INTEGRITY axis of the declared-boundary roster.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, and a second
 * suite here would split the whole-slice invariant across two modules that `isolate: true`
 * keeps from ever seeing each other's outcomes. Every assertion lives in
 * `integrity-boundaries.security.ts`; this module only BUILDS hostile input and CALLS
 * production. It judges nothing, derives no expected code, and reimplements no codec,
 * digest or admission rule — each `run` hands back whatever production returned, unread.
 *
 * WHY DEEP RELATIVE IMPORTS. Bare specifiers do not resolve from this lane: root
 * `node_modules/@moe` holds only `daemon` and `runner`, so `@moe/core`, `@moe/contracts`,
 * `@moe/review` and `@moe/store` are unreachable by name. The lane tsconfig sets
 * `composite: false` and no `rootDir`, so a deep relative import typechecks and runs —
 * measured with a compiled probe (exit 0, probe deleted) before a line of this was written.
 *
 * THE RESEAL RULE, which is what makes this axis's forgeries mean anything. Every boundary
 * here guards a DIGEST, a CODEC or an AUTHORITY RECORD, so the central hostile move is not
 * a malformed payload — it is a forged-but-internally-consistent one. A probe that mutated
 * a field and left the digest stale would only ever exercise the digest check, and would
 * pass against an implementation with NO subject binding whatsoever. Every forgery below
 * therefore re-seals through the SAME production path that seals a genuine record, and
 * carries an `integrity` thunk the suite runs to prove the reseal held.
 *
 * CODEC AND AUTHORITY SIT IN SERIES across almost this whole axis, so a fixture invalid at
 * an earlier layer never reaches the layer under test. Each case names, in a comment, which
 * layer it arranged to answer and how the earlier ones were kept satisfied.
 *
 * SECRETS. `RECOVERY_KEY_PROVIDER_LAYER` guards key material and the session boundaries
 * guard credentials. Nothing here asserts on, logs or embeds a private key, a signing
 * secret or a credential value; identifiers, digests and refusal codes only.
 */

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROJECT_CONFIGURATION_SELECTION_LAYER, readCurrentProjectConfiguration,
  selectProjectConfiguration,
} from "../../apps/daemon/src/configuration/project-configuration-selection.js";
import {
  CUTOVER_GENERATION_SNAPSHOT_LAYER,
  LIVE_QUIESCE_EVIDENCE_FILENAME,
  readCutoverGenerationSnapshot,
} from "../../apps/daemon/src/cutover/cutover-generation-snapshot.js";
import type {
  CutoverGenerationPorts,
  CutoverGenerationSnapshot,
} from "../../apps/daemon/src/cutover/cutover-generation-snapshot.js";
import {
  SESSION_AUTHORITY_DAEMON_LAYERS,
} from "../../apps/daemon/src/identity/session-authority-contracts.js";
import { createSessionAuthority } from "../../apps/daemon/src/identity/session-authority.js";
import { createNodeRecoveryCryptoPort } from "../../apps/daemon/src/recovery/recovery-incarnation.js";
import {
  RECOVERY_COMPLETION_LAYER, recoveryCompletionDigest,
} from "../../apps/daemon/src/recovery/recovery-completion-digest.js";
import type {
  RecoveryCompletionEvidence,
} from "../../apps/daemon/src/recovery/recovery-completion-digest.js";
import {
  CORE_APPROVAL_LAYER, PROJECT_REDUCER_LAYER, projectStateOf, readRecoveryCompletionEvidence,
} from "../../apps/daemon/src/recovery/recovery-completion-evidence.js";
import { runRecoveryCompleteCommand } from "../../apps/daemon/src/recovery/recovery-completion.js";
import type {
  RecoveryCompletionAuthority,
} from "../../apps/daemon/src/recovery/recovery-completion-authority.js";
import {
  RECOVERY_INVENTORY_POPULATIONS, RECOVERY_PROOF_CLASSES, recoveryPopulationClass,
} from "../../apps/daemon/src/recovery/recovery-inventory-contract.js";
import type {
  RecoveryProofClass,
} from "../../apps/daemon/src/recovery/recovery-inventory-contract.js";
import {
  recordRecoveryReconciliation,
} from "../../apps/daemon/src/recovery/recovery-inventory-ledger.js";
import { createRecoveryKeyProvider } from "../../apps/daemon/src/recovery/recovery-key-provider.js";
import {
  RECOVERY_KEY_PROVIDER_LAYER,
} from "../../apps/daemon/src/recovery/recovery-key-provider-contract.js";
import type {
  RecoveryKeyProviderPort,
} from "../../apps/daemon/src/recovery/recovery-key-provider-contract.js";
import {
  DECIDED_AT, PRINCIPAL_ID, PROJECT_ID, anchoredIncarnation, cleanupRestoreHarnesses,
  restoreHarness, restoreRequest,
} from "../../apps/daemon/src/recovery/restore-test-harness.js";
import { runRestoreQuiesce } from "../../apps/daemon/src/recovery/restore-controller.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "../../apps/daemon/src/work/foundation-repository-scope-authority.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, FOUNDATION_REPOSITORY_SCOPE_LAYERS,
} from "../../apps/daemon/src/work/foundation-repository-scope-contracts.js";
import type {
  FoundationRepositoryScopeCatalog,
} from "../../apps/daemon/src/work/foundation-repository-scope-contracts.js";
import {
  CONFIRMATORY_FREEZE_AUTHORITY_LAYER, readConfirmatoryFreezeAuthority,
} from "../../packages/benchmark/src/confirmatory-freeze-authority.js";
import {
  PRE_FREEZE_AUDIT_LAYER, preFreezeAuditRefusal, preFreezeAuditVerdict,
} from "../../packages/benchmark/src/pre-freeze-audit-vocabulary.js";
import {
  GA_ACTIVATION_WORK_REF, GO_ACTIVATE_GATE_ID,
} from "../../packages/benchmark/src/activation-binding.js";
import {
  GA_ACTIVATION_RECORD_LAYER, composeActivationRecord,
} from "../../packages/benchmark/src/activation-record.js";
import type {
  ActivationRecordInput,
} from "../../packages/benchmark/src/activation-record.js";
import { PINNED_SPEC_SHA256 } from "../../packages/benchmark/src/claim-ladder-contract.js";
import {
  validateConfirmatoryFreezeAuthorityRecord,
} from "../../packages/benchmark/src/confirmatory-freeze-authority-contracts.js";
import {
  DISTRIBUTION_REFUSAL_LAYERS, DOCUMENT_WORK_PROPOSAL_LAYERS,
  PROJECT_CONFIGURATION_LIMIT_KEYS, PROJECT_CONFIGURATION_REFUSAL_LAYERS,
  decodeDocumentWorkProposalBytes, parseProjectConfigurationManifest,
} from "../../packages/contracts/src/index.js";
import {
  canonicalUnsignedManifestBytes,
} from "../../packages/contracts/src/distribution/distribution-contract.js";
import {
  decodeDistributionContainerBytes, parseDistributionManifest,
} from "../../packages/contracts/src/distribution/distribution-parser.js";
import {
  verifyDistributionSet,
} from "../../packages/contracts/src/distribution/distribution-verifier.js";
import type {
  ObservedDistributionComponent,
} from "../../packages/contracts/src/distribution/distribution-verifier.js";
import {
  PROJECT_CONFIGURATION_CODEC_LAYERS, createProjectConfigurationManifest,
  decodeProjectConfigurationManifestBytes, encodeProjectConfigurationManifest,
} from "../../packages/core/src/index.js";
import type {
  LiveQuiesceEvidence,
} from "../../packages/core/src/cutover/cutover-quiesce-evidence.js";
import {
  ACCEPTANCE_CONTRACT_LAYERS,
  type AcceptanceContract,
} from "../../packages/core/src/planning/acceptance-contract.js";
import {
  createAcceptanceContract,
  decodeAcceptanceContractBytes,
  encodeAcceptanceContract,
} from "../../packages/core/src/planning/acceptance-contract-codec.js";
import {
  PLAN_REVISION_LAYERS,
  type PlanRevision,
} from "../../packages/core/src/planning/plan-revision-contract.js";
import {
  createPlanRevision,
  decodePlanRevisionBytes,
  encodePlanRevision,
} from "../../packages/core/src/planning/plan-revision-codec.js";
import {
  SESSION_AUTH_LAYERS, authenticateSession,
} from "../../packages/core/src/identity/authenticate-session.js";
import type {
  SessionAuthenticationInput,
} from "../../packages/core/src/identity/authenticate-session.js";
import { rotateCredential } from "../../packages/core/src/identity/identity-session.js";
import {
  APPROVAL_AUTHORITY_LAYERS, checkHumanAuthority, grantHumanAuthority,
} from "../../packages/core/src/planning/approval-authority.js";
import {
  EMPTY_REVIEW_LINEAGE, REVIEW_DECISION_LAYERS, buildReviewPackage, recordReviewRound,
} from "../../packages/review/src/index.js";
import {
  ADMISSION_PURPOSES, GRAPH_CONTENT_LAYERS, NODE_AUTHORITY_LAYERS,
  NODE_AUTHORITY_RECURSION_LAYERS, createNodeDefinition, decodeGraphContent,
  decodeNodeDefinitionBytes, deriveNodeAuthoritySet, encodeGraphContent, encodeNodeDefinition,
  snapshotIdentityHash, validateGraphSnapshot,
} from "../../packages/scheduler/src/index.js";
import { SqliteEventStore, verifyBackupGeneration } from "../../packages/store/src/index.js";
import {
  DIGEST as IMPORT_DIGEST, recordOf as importRecordOf, seedImport,
} from "../../apps/daemon/src/projections/import-shadow-test-fixtures.js";

import { hostileRoot, probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RaceOutcome, RefusalExpectation } from "./hostile-harness.js";

/**
 * Bounds every race at 2s. `MAX_BOUND_MS` is 2**31-1, the `setTimeout` clamp boundary, so a
 * bound at or above it collapses to 1ms and would race nothing; 2s is three orders of
 * magnitude below it and far above any in-process refusal, which settles in microseconds.
 */
const RACE_BOUND = Object.freeze({ label: "integrity-race", timeoutMs: 2_000 });

export type HostileArm = "AFTER" | "BEFORE" | "RACE";

interface CaseBase {
  readonly arm: HostileArm;
  /** The roster constant this case covers. Compared against the roster, never hand-kept. */
  readonly constant: string;
  readonly name: string;
}

export interface RefusalCase extends CaseBase {
  readonly arm: "AFTER" | "BEFORE";
  readonly expect: RefusalExpectation;
  /**
   * Present on FORGERY cases only. Re-runs the production integrity check over the SAME
   * forged material the case refuses on, and must resolve `ok: true`. That is the half of
   * the assertion which proves the reseal held: without it a forgery is indistinguishable
   * from a plain digest mismatch and would pass against a boundary with no subject binding.
   */
  readonly integrity?: () => Promise<{ readonly ok: boolean }>;
  run(): Promise<unknown>;
}

export interface RaceCase extends CaseBase {
  readonly arm: "RACE";
  /** Optional exact tuples for race legs whose production refusals are deterministic. */
  readonly expectLeft?: RefusalExpectation;
  readonly expectRight?: RefusalExpectation;
  run(): Promise<RaceOutcome<unknown, unknown>>;
}

export type HostileCase = RaceCase | RefusalCase;

/**
 * Reads a layer OUT of the boundary's own declared constant. A typed string literal would
 * stay green when the constant is renamed or re-spelled; this reddens, which is exactly what
 * the layer drill requires.
 */
function layerOf(declared: readonly string[], wanted: string): string {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) {
    throw new Error(`${wanted} is not a member of the declared layer constant`);
  }
  return found;
}

/** Same rule for a boundary whose layer constant is a bare string, not a frozen array. */
const soleLayer = (declared: string, wanted: string): string => layerOf([declared], wanted);

const before = (
  constant: string, name: string, expect: RefusalExpectation, run: () => Promise<unknown>,
): RefusalCase => ({ arm: "BEFORE", constant, expect, name, run });

const after = (
  constant: string, name: string, expect: RefusalExpectation, run: () => Promise<unknown>,
): RefusalCase => ({ arm: "AFTER", constant, expect, name, run });

const forged = (
  constant: string, name: string, expect: RefusalExpectation,
  integrity: () => Promise<{ readonly ok: boolean }>, run: () => Promise<unknown>,
): RefusalCase => ({ arm: "AFTER", constant, expect, integrity, name, run });

const racing = (
  constant: string, name: string,
  left: () => Promise<unknown>, right: () => Promise<unknown>,
): RaceCase => ({ arm: "RACE", constant, name, run: () => probeRacing(RACE_BOUND, left, right) });

const racingExactly = (
  constant: string, name: string,
  expectLeft: RefusalExpectation, expectRight: RefusalExpectation,
  left: () => Promise<unknown>, right: () => Promise<unknown>,
): RaceCase => ({
  arm: "RACE", constant, expectLeft, expectRight, name,
  run: () => probeRacing(RACE_BOUND, left, right),
});

/** Defers synchronous production probes so probeRacing installs its bound before either runs. */
const deferredProbe = <T>(probe: () => T): Promise<T> => Promise.resolve().then(probe);

/**
 * Projects a production refusal that spells its layer `refusedBy` onto the helper's shape.
 * It READS the production field and never invents one; `assertRefusedWith` demands `layer`
 * or `reasonLayer`, and four boundaries on this axis spell theirs differently.
 */
const asLayered = (value: unknown, layerKey: string, codeKey = "code"): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return { ...record, code: record[codeKey], layer: record[layerKey] };
};

/** Every store this module opens, closed by the suite before the lane's roots are removed:
 *  a held SQLite handle kills the vitest worker and would take the rest of the lane with it. */
export const openedStores: SqliteEventStore[] = [];

/** The restore harness keeps its OWN root registry, which `cleanupHostileRoots` cannot see.
 *  Re-exported so the suite removes both on every exit path, including a throw: the lane runs
 *  `fileParallelism: false`, so one leaked root or held handle stalls every file after this. */
export { cleanupRestoreHarnesses };

const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const hex64 = (tag: string): string => createHash("sha256").update(tag).digest("hex");

// ---------------------------------------------------------------------------
// PROJECT_CONFIGURATION_CODEC_LAYERS — @moe/core's content-addressed manifest codec.
// ---------------------------------------------------------------------------

const CONFIG_PROJECT = "project-integrity-configuration";
const CODEC = PROJECT_CONFIGURATION_CODEC_LAYERS;

function configSettings(modelRef: string): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: "2".repeat(64) },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1",
    },
    selection: {
      modelRef, profileRef: "profile-1", providerRef: "provider-1",
      reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
      structuredOutputSchemaRef: "schema-1",
    },
  };
}

/** Seals a manifest through the PRODUCTION create-then-encode path: the digest is computed
 *  by `createProjectConfigurationManifest` and the bytes emitted by the production encoder,
 *  so anything derived from this is internally consistent by construction. */
function sealedManifest(projectId: string, modelRef: string) {
  const created = createProjectConfigurationManifest(projectId, configSettings(modelRef));
  if (!created.ok) throw new Error(`manifest reseal refused at create: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`manifest reseal refused at encode: ${encoded.code}`);
  return { bytes: encoded.bytes, manifest: created.manifest };
}

/** Re-spells the canonical bytes with the top-level keys REVERSED. The JSON still parses and
 *  the settings digest still matches, so the CANONICALIZATION layer is provably the one that
 *  answers rather than the bytes decoder or the digest comparison. */
function reorderedManifestBytes(): Uint8Array {
  const parsed: unknown = JSON.parse(decoder.decode(sealedManifest(CONFIG_PROJECT, "model-1").bytes));
  const record = parsed as Record<string, unknown>;
  return utf8.encode(JSON.stringify(
    Object.fromEntries(Object.keys(record).reverse().map((key) => [key, record[key]])),
  ));
}

const codecCases: readonly HostileCase[] = [
  before(
    "PROJECT_CONFIGURATION_CODEC_LAYERS", "truncated manifest bytes",
    {
      code: "PROJECT_CONFIGURATION_BYTES_INVALID",
      layer: layerOf(CODEC, "PROJECT_CONFIGURATION_CODEC"),
    },
    // The bytes never become JSON, so no later layer is reachable and the bounded decoder
    // is provably the branch that answered. Nothing sits earlier on this path.
    async () => decodeProjectConfigurationManifestBytes(
      sealedManifest(CONFIG_PROJECT, "model-1").bytes.slice(0, 40),
    ),
  ),
  after(
    "PROJECT_CONFIGURATION_CODEC_LAYERS", "a sealed digest carried onto newer settings",
    {
      code: "PROJECT_CONFIGURATION_DIGEST_MISMATCH",
      layer: layerOf(CODEC, "PROJECT_CONFIGURATION_DIGEST"),
    },
    // Arranged so the DIGEST layer answers: the record is a fully valid manifest the contract
    // parser admits, so shape and canonicalization are satisfied and only the re-derived
    // digest comparison can refuse.
    async () => encodeProjectConfigurationManifest({
      ...sealedManifest(CONFIG_PROJECT, "model-newer").manifest,
      settingsDigest: sealedManifest(CONFIG_PROJECT, "model-1").manifest.settingsDigest,
    }),
  ),
  racing(
    "PROJECT_CONFIGURATION_CODEC_LAYERS", "a re-spelled encoding races a duplicated key",
    async () => decodeProjectConfigurationManifestBytes(reorderedManifestBytes()),
    async () => decodeProjectConfigurationManifestBytes(
      utf8.encode(`{"projectId":"${CONFIG_PROJECT}","projectId":"other"}`),
    ),
  ),
];

// ---------------------------------------------------------------------------
// ACCEPTANCE_CONTRACT_LAYERS — @moe/core's canonical criteria-body codec.
// ---------------------------------------------------------------------------

const ACCEPTANCE = ACCEPTANCE_CONTRACT_LAYERS;

function acceptanceDraft(tag: string): Record<string, unknown> {
  return {
    applicability: {
      graphContentHash: "a".repeat(64), graphRevisionRef: "graph-revision-security",
      nodeIds: ["node-security"], nodeKind: "LEAF",
    },
    authorRef: "principal-security", contractId: "acceptance-security",
    obligations: [{
      criterionId: "criterion-security",
      evidenceRequirements: [{
        evidenceRef: "artifact-security", kind: "ARTIFACT",
        requirementId: "requirement-security",
      }],
      statement: `Criterion ${tag} remains satisfied.`,
      verificationRecipeRefs: ["recipe-security"],
    }],
  };
}

/** Mints both the digest and bytes through production; no test helper can bless either. */
function sealedAcceptance(tag: string): {
  readonly bytes: Uint8Array;
  readonly contract: AcceptanceContract;
} {
  const created = createAcceptanceContract(acceptanceDraft(tag));
  if (!created.ok) {
    throw new Error(`AcceptanceContract create refused: ${created.code}@${created.layer}`);
  }
  const encoded = encodeAcceptanceContract(created.contract);
  if (!encoded.ok) {
    throw new Error(`AcceptanceContract encode refused: ${encoded.code}@${encoded.layer}`);
  }
  return { bytes: encoded.bytes, contract: created.contract };
}

function forgedAcceptanceContract(): AcceptanceContract {
  const donor = sealedAcceptance("donor").contract;
  const carrier = sealedAcceptance("carrier").contract;
  return { ...carrier, criteriaDigest: donor.criteriaDigest };
}

/** Same valid contract and digest, but a spelling production never emits. */
function reorderedAcceptanceBytes(): Uint8Array {
  const parsed = JSON.parse(
    decoder.decode(sealedAcceptance("canonical").bytes),
  ) as Record<string, unknown>;
  return utf8.encode(JSON.stringify(
    Object.fromEntries(Object.keys(parsed).reverse().map((key) => [key, parsed[key]])),
  ));
}

/** Duplicate a digest key in production-minted bytes; JSON.parse alone would hide this. */
function duplicateAcceptanceKeyBytes(): Uint8Array {
  const source = decoder.decode(sealedAcceptance("canonical").bytes);
  const duplicated = source.replace(
    '"criteriaDigest":',
    `"criteriaDigest":"${"0".repeat(64)}","criteriaDigest":`,
  );
  if (duplicated === source) throw new Error("sealed AcceptanceContract carried no digest key");
  return utf8.encode(duplicated);
}

const acceptanceContractCases: readonly HostileCase[] = [
  before(
    "ACCEPTANCE_CONTRACT_LAYERS", "canonical criteria bytes truncated mid-envelope",
    {
      code: "ACCEPTANCE_CONTRACT_BYTES_INVALID",
      layer: layerOf(ACCEPTANCE, "ACCEPTANCE_CONTRACT_CODEC"),
    },
    async () => decodeAcceptanceContractBytes(
      sealedAcceptance("before").bytes.slice(0, 40),
    ),
  ),
  forged(
    "ACCEPTANCE_CONTRACT_LAYERS", "one criteria digest carried onto changed content",
    {
      code: "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH",
      layer: layerOf(ACCEPTANCE, "ACCEPTANCE_CONTRACT_DIGEST"),
    },
    async () => {
      const donor = sealedAcceptance("donor");
      const carrier = sealedAcceptance("carrier");
      const forgedContract = forgedAcceptanceContract();
      return {
        ok: donor.contract.criteriaDigest !== carrier.contract.criteriaDigest
          && forgedContract.criteriaDigest === donor.contract.criteriaDigest
          && forgedContract.obligations[0]?.statement === carrier.contract.obligations[0]?.statement,
      };
    },
    // Admission accepts both contracts independently; the server-derived digest comparison
    // is therefore the first guard that can answer for the combined record.
    async () => encodeAcceptanceContract(forgedAcceptanceContract()),
  ),
  racingExactly(
    "ACCEPTANCE_CONTRACT_LAYERS", "a re-spelled body races a duplicated digest key",
    {
      code: "ACCEPTANCE_CONTRACT_NONCANONICAL",
      layer: layerOf(ACCEPTANCE, "ACCEPTANCE_CONTRACT_CANONICALIZATION"),
    },
    {
      code: "ACCEPTANCE_CONTRACT_DUPLICATE_KEY",
      layer: layerOf(ACCEPTANCE, "ACCEPTANCE_CONTRACT_CODEC"),
    },
    async () => decodeAcceptanceContractBytes(reorderedAcceptanceBytes()),
    async () => decodeAcceptanceContractBytes(duplicateAcceptanceKeyBytes()),
  ),
];

// ---------------------------------------------------------------------------
// PLAN_REVISION_LAYERS — @moe/core's canonical plan-revision body codec.
// ---------------------------------------------------------------------------

const PLAN_REVISION = PLAN_REVISION_LAYERS;

function planRevisionDraft(tag: string): Record<string, unknown> {
  return {
    affectedCriterionIds: ["criterion-security"],
    affectedNodeIds: ["node-security"],
    approvalState: "PENDING_APPROVAL",
    authorRef: "principal-security",
    graphBinding: {
      graphContentHash: "a".repeat(64), graphRevisionRef: "graph-revision-security",
    },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `plan-revision-${tag}`,
    steps: [{
      description: `Step ${tag} remains verified.`, kind: "IMPLEMENTATION",
      stepId: "step-security",
    }],
    verificationRecipeRefs: ["recipe-security"],
  };
}

/** Mints both the digest and bytes through production; no test helper can bless either. */
function sealedPlanRevision(tag: string): {
  readonly bytes: Uint8Array;
  readonly revision: PlanRevision;
} {
  const created = createPlanRevision(planRevisionDraft(tag));
  if (!created.ok) {
    throw new Error(`PlanRevision create refused: ${created.code}@${created.layer}`);
  }
  const encoded = encodePlanRevision(created.revision);
  if (!encoded.ok) {
    throw new Error(`PlanRevision encode refused: ${encoded.code}@${encoded.layer}`);
  }
  return { bytes: encoded.bytes, revision: created.revision };
}

function forgedPlanRevision(): PlanRevision {
  const donor = sealedPlanRevision("donor").revision;
  const carrier = sealedPlanRevision("carrier").revision;
  return { ...carrier, planHash: donor.planHash };
}

/** Same valid revision and digest, but a spelling production never emits. */
function reorderedPlanRevisionBytes(): Uint8Array {
  const parsed = JSON.parse(
    decoder.decode(sealedPlanRevision("canonical").bytes),
  ) as Record<string, unknown>;
  return utf8.encode(JSON.stringify(
    Object.fromEntries(Object.keys(parsed).reverse().map((key) => [key, parsed[key]])),
  ));
}

/** Duplicate a digest key in production-minted bytes; JSON.parse alone would hide this. */
function duplicatePlanRevisionKeyBytes(): Uint8Array {
  const source = decoder.decode(sealedPlanRevision("canonical").bytes);
  const duplicated = source.replace(
    '"planHash":',
    `"planHash":"${"0".repeat(64)}","planHash":`,
  );
  if (duplicated === source) throw new Error("sealed PlanRevision carried no digest key");
  return utf8.encode(duplicated);
}

const planRevisionCases: readonly HostileCase[] = [
  before(
    "PLAN_REVISION_LAYERS", "canonical plan-revision bytes truncated mid-envelope",
    {
      code: "PLAN_REVISION_BYTES_INVALID",
      layer: layerOf(PLAN_REVISION, "PLAN_REVISION_CODEC"),
    },
    async () => decodePlanRevisionBytes(
      sealedPlanRevision("before").bytes.slice(0, 40),
    ),
  ),
  forged(
    "PLAN_REVISION_LAYERS", "one plan hash carried onto changed content",
    {
      code: "PLAN_REVISION_DIGEST_MISMATCH",
      layer: layerOf(PLAN_REVISION, "PLAN_REVISION_DIGEST"),
    },
    async () => {
      const donor = sealedPlanRevision("donor");
      const carrier = sealedPlanRevision("carrier");
      const forgedRevision = forgedPlanRevision();
      return {
        ok: donor.revision.planHash !== carrier.revision.planHash
          && forgedRevision.planHash === donor.revision.planHash
          && forgedRevision.revisionId === carrier.revision.revisionId,
      };
    },
    // Admission accepts both revisions independently; the recomputed digest comparison is
    // therefore the first guard that can answer for the combined record.
    async () => encodePlanRevision(forgedPlanRevision()),
  ),
  racingExactly(
    "PLAN_REVISION_LAYERS", "a re-spelled body races a duplicated digest key",
    {
      code: "PLAN_REVISION_NONCANONICAL",
      layer: layerOf(PLAN_REVISION, "PLAN_REVISION_CANONICALIZATION"),
    },
    {
      code: "PLAN_REVISION_DUPLICATE_KEY",
      layer: layerOf(PLAN_REVISION, "PLAN_REVISION_CODEC"),
    },
    async () => decodePlanRevisionBytes(reorderedPlanRevisionBytes()),
    async () => decodePlanRevisionBytes(duplicatePlanRevisionKeyBytes()),
  ),
];

// ---------------------------------------------------------------------------
// PROJECT_CONFIGURATION_REFUSAL_LAYERS — @moe/contracts' manifest parser.
// ---------------------------------------------------------------------------

const MANIFEST_LAYER = layerOf(
  PROJECT_CONFIGURATION_REFUSAL_LAYERS, "PROJECT_CONFIGURATION_MANIFEST",
);

const contractCases: readonly HostileCase[] = [
  before(
    "PROJECT_CONFIGURATION_REFUSAL_LAYERS", "a manifest declaring an unsupported schema",
    { code: "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED", layer: MANIFEST_LAYER },
    // Every other field is the sealed manifest's own, so shape admission is satisfied and
    // the version gate is provably the branch that answered.
    async () => parseProjectConfigurationManifest({
      ...sealedManifest(CONFIG_PROJECT, "model-1").manifest,
      schemaVersion: "moe-project-configuration/2",
    }),
  ),
  after(
    "PROJECT_CONFIGURATION_REFUSAL_LAYERS", "a sealed manifest with its digest field dropped",
    { code: "PROJECT_CONFIGURATION_INPUT_INVALID", layer: MANIFEST_LAYER },
    async () => {
      const { manifest } = sealedManifest(CONFIG_PROJECT, "model-1");
      return parseProjectConfigurationManifest({
        projectId: manifest.projectId, schemaVersion: manifest.schemaVersion,
        settings: manifest.settings,
      });
    },
  ),
  racing(
    "PROJECT_CONFIGURATION_REFUSAL_LAYERS", "an unsupported version races a reordered limit table",
    async () => parseProjectConfigurationManifest({
      ...sealedManifest(CONFIG_PROJECT, "model-1").manifest,
      schemaVersion: "moe-project-configuration/0",
    }),
    async () => parseProjectConfigurationManifest({
      ...sealedManifest(CONFIG_PROJECT, "model-1").manifest,
      settings: {
        ...configSettings("model-1"),
        limits: [...PROJECT_CONFIGURATION_LIMIT_KEYS]
          .reverse().map((key, index) => ({ key, value: index + 1 })),
      },
    }),
  ),
];

// ---------------------------------------------------------------------------
// PROJECT_CONFIGURATION_SELECTION_LAYER — the daemon's durable selection seam.
// ---------------------------------------------------------------------------

const SELECTION_LAYER = soleLayer(
  PROJECT_CONFIGURATION_SELECTION_LAYER, "PROJECT_CONFIGURATION_SELECTION",
);

let selectionStores = 0;

function selectionStore(): SqliteEventStore {
  selectionStores += 1;
  const root = hostileRoot(`config-selection-${selectionStores}`);
  const store = SqliteEventStore.openForProject(join(root, "selection.db"), CONFIG_PROJECT);
  openedStores.push(store);
  return store;
}

/**
 * A manifest SEALED FOR A DIFFERENT PROJECT through the production codec: the settings are
 * re-parsed, the digest recomputed by `createProjectConfigurationManifest`, the bytes
 * re-emitted by `encodeProjectConfigurationManifest`. The payload is internally consistent —
 * it decodes cleanly and passes its own digest check — and the only thing wrong is the
 * subject it names.
 */
const foreignSealedManifest = (): Uint8Array => sealedManifest("project-elsewhere", "model-1").bytes;

const selectionRequest = (bytes: Uint8Array, commandId: string) => ({
  commandId, correlationId: `correlation-${commandId}`, decidedAt: "2026-08-16T00:00:00.000Z",
  expectedVersion: 0, manifestBytes: bytes, principalId: "principal-1", projectId: CONFIG_PROJECT,
});

const selectionCases: readonly HostileCase[] = [
  before(
    "PROJECT_CONFIGURATION_SELECTION_LAYER", "a current read against a store holding nothing",
    { code: "PROJECT_CONFIGURATION_ABSENT", layer: SELECTION_LAYER },
    // The request is well formed — a logical project ref and a hex64 digest — so the request
    // guard is satisfied and the ABSENT branch is provably the one that answered.
    async () => readCurrentProjectConfiguration(selectionStore(), {
      expectedSettingsDigest: "a".repeat(64), projectId: CONFIG_PROJECT,
    }),
  ),
  forged(
    "PROJECT_CONFIGURATION_SELECTION_LAYER", "a manifest resealed for a different project",
    { code: "PROJECT_CONFIGURATION_CONFLICT", layer: SELECTION_LAYER },
    // Reseal proof: production's own decoder admits the forged bytes, so the codec layer is
    // satisfied and the SELECTION layer's project binding is what refuses.
    async () => decodeProjectConfigurationManifestBytes(foreignSealedManifest()),
    async () => selectProjectConfiguration(
      selectionStore(), selectionRequest(foreignSealedManifest(), "configuration-forged-1"),
    ),
  ),
  racing(
    "PROJECT_CONFIGURATION_SELECTION_LAYER",
    "two foreign-sealed selections at one expected version",
    async () => selectProjectConfiguration(
      selectionStore(), selectionRequest(foreignSealedManifest(), "configuration-race-left"),
    ),
    async () => selectProjectConfiguration(
      selectionStore(), selectionRequest(foreignSealedManifest(), "configuration-race-right"),
    ),
  ),
];

// ---------------------------------------------------------------------------
// APPROVAL_AUTHORITY_LAYERS — @moe/core's human authority gate.
// ---------------------------------------------------------------------------

const GATE_LAYER = layerOf(APPROVAL_AUTHORITY_LAYERS, "HUMAN_AUTHORITY_GATE");
const GRANT_AT = 1_770_000_000_000;

const emptyGate = (gateId: string) => ({ gateId, grant: null, workRef: `work-${gateId}` });

/** Mints a REAL grant through production. Every non-subject check the gate performs — named
 *  human, HUMAN kind, safe-integer moment — is satisfied because production itself minted
 *  the record, so only the binding can be wrong when it is carried elsewhere. */
function grantedGate(gateId: string) {
  const granted = grantHumanAuthority(
    emptyGate(gateId), { kind: "HUMAN", principalId: "human-approver-1" }, GRANT_AT,
  );
  if (!granted.ok) throw new Error(`grant fixture refused: ${granted.code}`);
  return granted.gate;
}

const carriedGrant = (from: string, onto: string) => ({
  gateId: onto, grant: grantedGate(from).grant, workRef: `work-${onto}`,
});

const approvalCases: readonly HostileCase[] = [
  before(
    "APPROVAL_AUTHORITY_LAYERS", "a named gate presented with no grant at all",
    { code: "APPROVAL_HUMAN_AUTHORITY_REQUIRED", layer: GATE_LAYER },
    async () => checkHumanAuthority(emptyGate("gate-1")),
  ),
  forged(
    "APPROVAL_AUTHORITY_LAYERS", "a real human grant carried onto different work",
    { code: "APPROVAL_AUTHORITY_BINDING_MISMATCH", layer: GATE_LAYER },
    // Reseal proof: the SAME grant record satisfies the gate it was actually issued for, so
    // nothing about it is malformed and the binding check is provably what answered here.
    async () => checkHumanAuthority(grantedGate("gate-alpha")),
    async () => checkHumanAuthority(carriedGrant("gate-alpha", "gate-beta")),
  ),
  racing(
    "APPROVAL_AUTHORITY_LAYERS", "two conflicting grants presented for one subject",
    async () => checkHumanAuthority(carriedGrant("gate-alpha", "gate-contested")),
    async () => checkHumanAuthority(carriedGrant("gate-omega", "gate-contested")),
  ),
];

// ---------------------------------------------------------------------------
// SESSION_AUTH_LAYERS — @moe/core's session authentication ladder.
// ---------------------------------------------------------------------------

const BINDING_REF = "71".repeat(32);
const EPOCH_REF = "72".repeat(32);
const SESSION_AT = 1_770_000_100_000;

/** A presentation VALID AT EVERY BINDING-LAYER PREDICATE: matching session and credential
 *  ids, one shared recovery binding, a proof naming the same command and digest. Overrides
 *  move exactly one fact so a later layer is provably the one that answers. */
function sessionInput(
  overrides: Partial<SessionAuthenticationInput> = {},
): SessionAuthenticationInput {
  const binding = { keyEpochRef: EPOCH_REF, recoveryIncarnationRef: BINDING_REF };
  const session = {
    ...binding, clientKeyId: "client-key-1", expiresAt: SESSION_AT + 60_000, generation: 1,
    principalId: "principal-1", profileRevisionId: "profile-1", sessionId: "session-1",
    status: "ACTIVE" as const, transportIds: ["coordination.v1"],
  };
  const credential = {
    ...binding, credentialId: "credential-1", generation: 1, revoked: false,
    sessionId: "session-1",
  };
  return {
    capabilityRecoveryCandidates: [],
    checkReplay: () => "FRESH" as const,
    credential,
    currentRecoveryBinding: binding,
    now: SESSION_AT,
    presentedCredentialId: "credential-1",
    principal: { kind: "HUMAN" as const, principalId: "principal-1", profileRevisionId: "profile-1" },
    projectId: "project-integrity-session",
    proof: {
      clientKeyId: "client-key-1", commandId: "request-1", credentialId: "credential-1",
      requestDigest: hex64("request-1"),
    },
    requestDigest: hex64("request-1"),
    requestId: "request-1",
    session,
    transportId: "coordination.v1",
    verifyProof: () => true,
    ...overrides,
  };
}

/** Rotates through PRODUCTION, then presents the superseded credential at the advanced
 *  session. The credential is genuine and passes every BINDING predicate; only its
 *  generation — the subject it is bound to — is stale. */
function replayedAfterRotation(): unknown {
  const base = sessionInput();
  const rotated = rotateCredential(base.session!, base.credential!, "credential-2");
  if (rotated === null) throw new Error("rotation fixture refused");
  return authenticateSession(sessionInput({
    credential: rotated.previous, session: rotated.session,
  }));
}

const sessionCases: readonly HostileCase[] = [
  before(
    "SESSION_AUTH_LAYERS", "a presentation whose proof does not verify",
    { code: "AUTHENTICATION_FAILED", layer: layerOf(SESSION_AUTH_LAYERS, "PROOF") },
    // Every BINDING predicate is satisfied by construction, so PROOF is provably the layer
    // that answered rather than the snapshot guard refusing a malformed presentation.
    async () => authenticateSession(sessionInput({ verifyProof: () => false })),
  ),
  forged(
    "SESSION_AUTH_LAYERS", "a credential replayed after production rotated the session",
    { code: "SESSION_REPLAYED", layer: layerOf(SESSION_AUTH_LAYERS, "GENERATION") },
    // Reseal proof: the same credential authenticates cleanly against the generation it
    // belongs to, so it is a genuine, internally consistent record and the GENERATION check
    // is what refuses once production advanced the subject.
    async () => {
      const accepted = authenticateSession(sessionInput());
      return { ok: accepted.ok };
    },
    async () => replayedAfterRotation(),
  ),
  racing(
    "SESSION_AUTH_LAYERS", "a closed session races a revoked credential",
    async () => authenticateSession(sessionInput({
      session: { ...sessionInput().session!, status: "CLOSED" },
    })),
    async () => authenticateSession(sessionInput({
      credential: { ...sessionInput().credential!, revoked: true },
    })),
  ),
];

// ---------------------------------------------------------------------------
// SESSION_AUTHORITY_DAEMON_LAYERS — the daemon's durable session-authority seam.
// ---------------------------------------------------------------------------

const DAEMON_STORE_LAYER = layerOf(SESSION_AUTHORITY_DAEMON_LAYERS, "DURABLE_STORE");
const AUTHORITY_AT = Date.parse("2026-08-16T12:00:00.000Z");
const AUTHORITY_PROJECT = "project-session-authority";

let authorityStores = 0;

function principalAuthority() {
  authorityStores += 1;
  const root = hostileRoot(`session-authority-${authorityStores}`);
  const store = SqliteEventStore.openForProject(join(root, "authority.db"), AUTHORITY_PROJECT);
  openedStores.push(store);
  return createSessionAuthority(store, {
    clock: () => AUTHORITY_AT, projectId: AUTHORITY_PROJECT,
  });
}

const principalRequest = (profileRevisionId: string) => Object.freeze({
  commandId: "command-create-principal", correlationId: "correlation-create-principal",
  kind: "AGENT" as const, principalId: "agent-session-authority", profileRevisionId,
});

/** Commits one principal, then presents the SAME durable command identity carrying different
 *  bytes. The second request is well formed at every shape layer — it is the first with one
 *  field changed — so the durable idempotency binding is provably what refuses. */
function replayedCommandIdentity(...profiles: readonly string[]): unknown {
  const authority = principalAuthority();
  const first = authority.createPrincipal(principalRequest("profile-v1"));
  if (!first.ok) throw new Error(`principal fixture refused: ${first.code}`);
  let last: unknown = first;
  for (const profile of profiles) last = authority.createPrincipal(principalRequest(profile));
  return last;
}

const authorityCases: readonly HostileCase[] = [
  before(
    "SESSION_AUTHORITY_DAEMON_LAYERS", "a command identity bound to different bytes",
    { code: "SESSION_AUTHORITY_COMMAND_CONFLICT", layer: DAEMON_STORE_LAYER },
    async () => replayedCommandIdentity("profile-forged"),
  ),
  after(
    "SESSION_AUTHORITY_DAEMON_LAYERS", "the conflicting identity presented a second time",
    { code: "SESSION_AUTHORITY_COMMAND_CONFLICT", layer: DAEMON_STORE_LAYER },
    async () => replayedCommandIdentity("profile-forged", "profile-forged-again"),
  ),
  racing(
    "SESSION_AUTHORITY_DAEMON_LAYERS", "two conflicting bodies race one command identity",
    async () => replayedCommandIdentity("profile-left"),
    async () => replayedCommandIdentity("profile-right"),
  ),
];

// ---------------------------------------------------------------------------
// DOCUMENT_WORK_PROPOSAL_LAYERS — @moe/contracts' agent-reported proposal ingress.
// ---------------------------------------------------------------------------

interface ProposalShape {
  readonly duplicateRef?: boolean;
  readonly sharedPath?: boolean;
  readonly unboundCitation?: boolean;
}

/** One proposal whose sources and candidates are legal at every shape, limit and identity
 *  layer. Each flag moves exactly one fact so the layer under test is the one that answers. */
function documentProposalBytes(shape: ProposalShape): Uint8Array {
  const second = {
    byteLength: 20, contentSha256: hex64("source-2"),
    displayPath: shape.sharedPath === true ? "docs/one.md" : "docs/two.md",
    sourceRef: shape.duplicateRef === true ? "source-1" : "source-2",
  };
  return utf8.encode(JSON.stringify({
    advisoryOnly: true, authority: "NONE",
    candidates: [{
      candidateRef: "candidate-1", objective: "review the sources",
      sourceRefs: shape.unboundCitation === true ? ["source-absent"] : ["source-1"],
      title: "Candidate one",
    }],
    contextManifestDigest: hex64("context"), projectId: "project-documents",
    repositoryBaseHash: hex64("repository"), schemaVersion: "moe-document-work-proposal/1",
    sources: [
      { byteLength: 10, contentSha256: hex64("source-1"), displayPath: "docs/one.md", sourceRef: "source-1" },
      second,
    ],
    submissionState: "NOT_SUBMITTED", truthClass: "AGENT_REPORTED",
  }));
}

const documentCases: readonly HostileCase[] = [
  before(
    "DOCUMENT_WORK_PROPOSAL_LAYERS", "truncated proposal bytes",
    {
      code: "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED",
      layer: layerOf(DOCUMENT_WORK_PROPOSAL_LAYERS, "BOUNDED_JSON"),
    },
    async () => decodeDocumentWorkProposalBytes(documentProposalBytes({}).slice(0, 30)),
  ),
  forged(
    "DOCUMENT_WORK_PROPOSAL_LAYERS", "two sources resealed onto one display path",
    {
      code: "DOCUMENT_WORK_PROPOSAL_SOURCE_CONFLICT",
      layer: layerOf(DOCUMENT_WORK_PROPOSAL_LAYERS, "PROVENANCE"),
    },
    // Reseal proof: the same proposal with distinct display paths is ACCEPTED, so every
    // shape, limit and identity layer is satisfied and PROVENANCE is what refuses. A shape
    // failure in disguise would fail this half.
    async () => decodeDocumentWorkProposalBytes(documentProposalBytes({})),
    async () => decodeDocumentWorkProposalBytes(documentProposalBytes({ sharedPath: true })),
  ),
  racing(
    "DOCUMENT_WORK_PROPOSAL_LAYERS", "a duplicated ref races an unbound citation",
    async () => decodeDocumentWorkProposalBytes(documentProposalBytes({ duplicateRef: true })),
    async () => decodeDocumentWorkProposalBytes(documentProposalBytes({ unboundCitation: true })),
  ),
];

// ---------------------------------------------------------------------------
// DISTRIBUTION_REFUSAL_LAYERS — @moe/contracts' packager and startup admission.
// ---------------------------------------------------------------------------

const PACKAGER_LAYER = layerOf(DISTRIBUTION_REFUSAL_LAYERS, "DISTRIBUTION_PACKAGER");
const STARTUP_LAYER = layerOf(DISTRIBUTION_REFUSAL_LAYERS, "DISTRIBUTION_STARTUP");
const RELEASE_SOURCE_SHA = "3".repeat(64);
const API_PINS = Object.freeze({
  commandEnvelopeVersion: "moe-command/1", errorRegistryVersion: "moe-error/1",
  queryEnvelopeVersion: "moe-query/1",
});
const releaseKey = generateKeyPairSync("ed25519");

const distributionManifestInput = (overrides: Record<string, unknown>) => ({
  aggregateDigest: hex64("aggregate"), apiCompatibilityRange: { ...API_PINS },
  assets: [
    { byteLength: 12, path: "src/index.ts", sha256: hex64("asset-a") },
    { byteLength: 34, path: "src/util.ts", sha256: hex64("asset-b") },
  ],
  buildToolVersions: { node: "24.16.0", pnpm: "11.0.8" },
  builtInSkills: [{ digest: hex64("skill"), skillId: "moe-planning", version: "1.0.0" }],
  componentId: "daemon", componentKind: "DAEMON", contractSchemaHash: hex64("schema"),
  instructionTemplates: [{ digest: hex64("template"), templateId: "AGENTS.md", version: "1" }],
  manifestVersion: "moe-distribution-manifest/1", signatureAlgorithm: "ed25519",
  signingKeyId: "release-key-1", source: { objectFormat: "sha256", sourceSha: RELEASE_SOURCE_SHA },
  ...overrides,
});

const distributionExpectation = (overrides: Record<string, unknown> = {}) => ({
  apiCompatibilityRange: { ...API_PINS }, buildToolVersions: { node: "24.16.0", pnpm: "11.0.8" },
  builtInSkills: [{ digest: hex64("skill"), skillId: "moe-planning", version: "1.0.0" }],
  componentKinds: { "control-room": "CONTROL_ROOM", daemon: "DAEMON" },
  contractSchemaHash: hex64("schema"),
  instructionTemplates: [{ digest: hex64("template"), templateId: "AGENTS.md", version: "1" }],
  source: { objectFormat: "sha256", sourceSha: RELEASE_SOURCE_SHA },
  trustedKeyIds: ["release-key-1"], ...overrides,
});

/** Signs the PRODUCTION canonical unsigned manifest bytes. A forged manifest re-signed here
 *  is byte-consistent with its own signature, so the signature check provably passes and any
 *  refusal that follows is about the SUBJECT rather than about a broken seal. */
function signedComponent(overrides: Record<string, unknown>): ObservedDistributionComponent {
  const parsed = parseDistributionManifest(
    distributionManifestInput(overrides), "DISTRIBUTION_PACKAGER",
  );
  if (!parsed.ok) throw new Error(`distribution fixture refused: ${parsed.reason}`);
  const manifest = parsed.manifest;
  return {
    container: {
      assets: { "src/index.ts": "aGVsbG8=", "src/util.ts": "d29ybGQ=" },
      containerVersion: "moe-distribution-container/1", manifest,
      signature: sign(null, canonicalUnsignedManifestBytes(manifest), releaseKey.privateKey)
        .toString("hex"),
    },
    recomputedAggregateDigest: manifest.aggregateDigest,
    recomputedAssetDigests: Object.fromEntries(
      manifest.assets.map((asset): readonly [string, string] => [asset.path, asset.sha256]),
    ),
  };
}

const verifyReleaseSignature = (input: {
  readonly message: Uint8Array; readonly signature: string;
}): boolean => verify(
  null, input.message, releaseKey.publicKey, Buffer.from(input.signature, "hex"),
);

/** The whole observed set, with the daemon component resealed against a different source
 *  revision. `control-room` stays genuine so the component-set gate is satisfied first. */
const forgedRelease = (): readonly ObservedDistributionComponent[] => [
  signedComponent({ source: { objectFormat: "sha256", sourceSha: "e".repeat(64) } }),
  signedComponent({ componentId: "control-room", componentKind: "CONTROL_ROOM" }),
];

function forgedReleaseSealHolds(): { readonly ok: boolean } {
  const component = forgedRelease()[0];
  if (component === undefined) throw new Error("forged release produced no component");
  return {
    ok: verifyReleaseSignature({
      message: canonicalUnsignedManifestBytes(component.container.manifest),
      signature: component.container.signature,
    }),
  };
}

const distributionCases: readonly HostileCase[] = [
  before(
    "DISTRIBUTION_REFUSAL_LAYERS", "truncated container bytes",
    { code: "CONTAINER_BYTES_INVALID", layer: PACKAGER_LAYER },
    async () => asLayered(decodeDistributionContainerBytes(
      utf8.encode('{"containerVersion":"moe-distributi'), "DISTRIBUTION_PACKAGER",
    ), "refusedBy", "reason"),
  ),
  forged(
    "DISTRIBUTION_REFUSAL_LAYERS", "a manifest re-signed for a different source revision",
    { code: "SOURCE_SHA_MISMATCH", layer: STARTUP_LAYER },
    // Reseal proof: the forged manifest's own signature verifies against the production
    // canonical unsigned bytes. `verifyDistributionSet` checks the signature BEFORE the
    // provenance comparison, so reaching SOURCE_SHA_MISMATCH at all proves the seal held.
    async () => forgedReleaseSealHolds(),
    async () => asLayered(verifyDistributionSet(
      forgedRelease(), distributionExpectation(), verifyReleaseSignature,
    ), "refusedBy", "reason"),
  ),
  racing(
    "DISTRIBUTION_REFUSAL_LAYERS", "a foreign source races an untrusted signing key",
    async () => asLayered(verifyDistributionSet(
      forgedRelease(), distributionExpectation(), verifyReleaseSignature,
    ), "refusedBy", "reason"),
    async () => asLayered(verifyDistributionSet(
      forgedRelease(), distributionExpectation({ trustedKeyIds: ["release-key-rotated"] }),
      verifyReleaseSignature,
    ), "refusedBy", "reason"),
  ),
];

// ---------------------------------------------------------------------------
// REVIEW_DECISION_LAYERS — @moe/review's package builder and finding lineage.
// ---------------------------------------------------------------------------

const PACKAGE_LAYER = layerOf(REVIEW_DECISION_LAYERS, "PACKAGE");
const FINDINGS_LAYER = layerOf(REVIEW_DECISION_LAYERS, "FINDINGS");

const REVIEW_ITEMS = Object.freeze([
  { digest: hex64("criterion"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("rubric"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("tree"), kind: "INTEGRATED_TREE", locator: "tree-1" },
  { digest: hex64("bytes"), kind: "SUBMITTED_BYTES", locator: "bytes-1" },
  { digest: hex64("hash"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("receipt"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
]);

const finding = (locator: string) => ({
  detail: "structured finding", ruleId: "rule-1", severity: "MAJOR" as const,
  subject: { kind: "ARTIFACT" as const, locator },
});

/** Advances a lineage to round 5 through PRODUCTION, so its digest is one the reducer itself
 *  sealed. Nothing test-side recomputes it; a hand-built digest would only test the digest. */
function attestedLineage() {
  const recorded = recordReviewRound(EMPTY_REVIEW_LINEAGE, {
    findings: [finding("artifact-1")], round: 5,
  });
  if (!recorded.ok) throw new Error(`lineage fixture refused: ${recorded.code}`);
  return recorded.value.lineage;
}

const reviewCases: readonly HostileCase[] = [
  before(
    "REVIEW_DECISION_LAYERS", "a clean package carrying a forbidden item kind",
    { code: "PACKAGE_ITEM_KIND_FORBIDDEN", layer: PACKAGE_LAYER },
    // Every other item is a legal kind with a hex64 digest, so the binding-completeness
    // gates are satisfied and the forbidden-kind branch is provably what answered.
    async () => buildReviewPackage([
      ...REVIEW_ITEMS,
      { digest: hex64("transcript"), kind: "WORKER_TRANSCRIPT", locator: "transcript-1" },
    ]),
  ),
  forged(
    "REVIEW_DECISION_LAYERS", "a superseded round replayed against an attested lineage",
    { code: "FINDING_LINEAGE_APPEND_ONLY", layer: FINDINGS_LAYER },
    // Reseal proof: the SAME lineage admits a forward round, so its digest is attested and
    // the append-only frontier is provably the check that refused the replay. A lineage
    // whose digest had been hand-edited would be caught by FINDING_LINEAGE_DIGEST_MISMATCH
    // instead — exactly the digest-mismatch-in-disguise this half rules out.
    async () => recordReviewRound(attestedLineage(), { findings: [], round: 6 }),
    async () => recordReviewRound(attestedLineage(), {
      findings: [finding("artifact-2")], round: 3,
    }),
  ),
  racing(
    "REVIEW_DECISION_LAYERS", "a replayed round races an unrepresentable one",
    async () => recordReviewRound(attestedLineage(), {
      findings: [finding("artifact-3")], round: 5,
    }),
    async () => recordReviewRound(attestedLineage(), {
      findings: [finding("artifact-4")], round: Number.NaN,
    }),
  ),
];

// ---------------------------------------------------------------------------
// RECOVERY_KEY_PROVIDER_LAYER — the durable, OS-protected recovery key epoch.
// ---------------------------------------------------------------------------

const KEY_PROVIDER_LAYER = soleLayer(RECOVERY_KEY_PROVIDER_LAYER, "RECOVERY_KEY_PROVIDER");
const KEY_PROJECT = "project-integrity-key-epoch";

let keyStores = 0;

function keyEpochStore(): SqliteEventStore {
  keyStores += 1;
  const root = hostileRoot(`key-epoch-${keyStores}`);
  const store = SqliteEventStore.openForProject(join(root, "epoch.db"), KEY_PROJECT);
  openedStores.push(store);
  return store;
}

const keyEpochRequest = (overrides: Record<string, unknown> = {}) => ({
  backupGenerationDigest: hex64("backup-generation"), correlationId: "corr-key-1",
  decidedAt: "2026-08-16T00:00:00.000Z", principalId: "principal-1", projectId: KEY_PROJECT,
  protectedDirectory: hostileRoot("key-epoch-directory"),
  restoreCommandId: "restore-cmd-key-1", ...overrides,
});

const port = (protect: RecoveryKeyProviderPort["protect"]): RecoveryKeyProviderPort =>
  ({ platform: "linux", protect });

const keyProvider = (protect: RecoveryKeyProviderPort["protect"]) =>
  createRecoveryKeyProvider(createNodeRecoveryCryptoPort(), port(protect));

const unverifiableProtection = async () => ({
  authority: "NONE" as const, code: "RECOVERY_KEY_PROTECTION_UNVERIFIABLE" as const,
  layer: RECOVERY_KEY_PROVIDER_LAYER, mechanism: "UNKNOWN" as const, ok: false as const,
  platform: "linux" as const,
  reason: "The protection mechanism was applied but did not prove itself on read-back.",
  truth: "UNKNOWN" as const,
});

const grantedProtection = async () => ({
  mechanism: "POSIX_MODE_0700_OWNER_ONLY" as const, ok: true as const, platform: "linux" as const,
});

const keyProviderCases: readonly HostileCase[] = [
  before(
    "RECOVERY_KEY_PROVIDER_LAYER", "a request naming a predecessor incarnation",
    { code: "RECOVERY_KEY_EPOCH_INPUT_INVALID", layer: KEY_PROVIDER_LAYER },
    // The extra key is the ONLY defect: every declared field is well formed, so the request
    // snapshot is provably what refused rather than a downstream succession check.
    async () => keyProvider(grantedProtection).open(keyEpochStore(), {
      ...keyEpochRequest(), predecessorIncarnationRef: hex64("predecessor"),
    }),
  ),
  after(
    "RECOVERY_KEY_PROVIDER_LAYER", "an epoch whose protection did not prove itself on read-back",
    { code: "RECOVERY_KEY_PROTECTION_UNVERIFIABLE", layer: KEY_PROVIDER_LAYER },
    // The request itself is admitted, so the snapshot layer is satisfied and the protection
    // verdict is provably the branch that answered.
    async () => keyProvider(unverifiableProtection).open(keyEpochStore(), keyEpochRequest()),
  ),
  racing(
    "RECOVERY_KEY_PROVIDER_LAYER", "an unverifiable host races a throwing protection port",
    async () => keyProvider(unverifiableProtection).open(keyEpochStore(), keyEpochRequest()),
    async () => keyProvider(() => {
      throw new Error("protection port unavailable");
    }).open(keyEpochStore(), keyEpochRequest()),
  ),
];

// ---------------------------------------------------------------------------
// The recovery-completion trio — RECOVERY_COMPLETION_LAYER, CORE_APPROVAL_LAYER and
// PROJECT_REDUCER_LAYER — over ONE real restored, quiesced, reconciled world.
//
// The world is built entirely from shipped production surfaces: the real restore
// controller, the real anchor, the real backup verifier, the real reconciliation ledger,
// and the evidence digest read back through the production reader rather than recomputed
// here. Building it once and sharing it is safe because every case below REFUSES, so none
// of them advances the aggregate.
// ---------------------------------------------------------------------------

const COMPLETION_LAYER = soleLayer(RECOVERY_COMPLETION_LAYER, "RECOVERY_COMPLETION");
const APPROVAL_LAYER = soleLayer(CORE_APPROVAL_LAYER, "CORE_APPROVAL");
const REDUCER_LAYER = soleLayer(PROJECT_REDUCER_LAYER, "PROJECT_REDUCER");
const DECISION_REASON = "R3 cutover approved after external inventory review";
const STEP_UP_REF = hex64("step-up");

interface RecoveryScene {
  readonly digest: string;
  readonly evidence: RecoveryCompletionEvidence;
  readonly policyRevisionRef: string;
  readonly recordDigest: string;
  readonly store: SqliteEventStore;
  readonly version: number;
}

function externalFacts(backupGenerationDigest: string, backupCursor: string) {
  const classDigest = (proofClass: RecoveryProofClass): string =>
    hex64(`class-${RECOVERY_PROOF_CLASSES.indexOf(proofClass)}`);
  return {
    backupCursor, backupGenerationDigest, configuredClasses: [...RECOVERY_PROOF_CLASSES],
    projectTag: `moe-project:${PROJECT_ID}`,
    proofs: RECOVERY_PROOF_CLASSES.map((proofClass) => ({
      class: proofClass, sourceProofDigest: classDigest(proofClass),
      truth: "COMPLETE" as const, upstream: null,
    })),
    subjects: RECOVERY_INVENTORY_POPULATIONS.map((population) => {
      const proofClass = recoveryPopulationClass(population) as RecoveryProofClass;
      return {
        class: proofClass as string,
        evidence: { kind: "NEGATIVE_COMPLETE" as const, proofDigest: classDigest(proofClass) },
        identity: `external-${population}`, population: population as string,
        sourceProofDigest: classDigest(proofClass),
      };
    }),
  };
}

async function buildRecoveryScene(label: string): Promise<RecoveryScene> {
  const harness = await restoreHarness(`integrity-${label}`);
  openedStores.push(harness.store);
  const binding = await anchoredIncarnation(harness, `restore-cmd-${label}`);
  const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));
  if (!quiesced.ok) throw new Error(`restore quiesce refused: ${quiesced.code}`);
  const verified = verifyBackupGeneration(harness.container, harness.trust, {
    observedLogicalPaths: harness.logicalPaths,
  });
  if (!verified.ok) throw new Error(`backup verification refused: ${verified.reason}`);
  const written = recordRecoveryReconciliation(
    harness.store,
    {
      correlationId: "corr-integrity", decidedAt: DECIDED_AT,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    externalFacts(binding.backupGenerationDigest, verified.manifest.cursor),
  );
  if (!written.ok) throw new Error(`reconciliation refused: ${written.upstream.code}`);
  const found = readRecoveryCompletionEvidence(harness.store, PROJECT_ID, written.recordDigest);
  if (!found.ok) throw new Error(`evidence read refused: ${found.code}`);
  return {
    digest: found.digest, evidence: found.evidence,
    policyRevisionRef: found.evidence.policyRevisionRef, recordDigest: written.recordDigest,
    store: harness.store, version: harness.store.getAggregateVersion(PROJECT_ID),
  };
}

let completionScene: Promise<RecoveryScene> | null = null;
let reducerScene: Promise<RecoveryScene> | null = null;

const recoveryScene = (): Promise<RecoveryScene> =>
  (completionScene ??= buildRecoveryScene("completion"));

/**
 * A SECOND world, deliberately separate: these cases drift the project aggregate, and a
 * shared world would leak that drift into the completion and approval cases above.
 *
 * THE DRIFT IS THE HOSTILE MOVE. One further decision is committed onto the project
 * aggregate carrying the project's CURRENT durable state verbatim, so the aggregate advances
 * by one while the state the ledger reports does not. Every layer in front of the reducer
 * still answers yes — the envelope decodes, the evidence still reads a QUIESCED project
 * awaiting recovery, and the daemon's own CAS compares the caller's number against
 * `getAggregateVersion`, which now matches. Only the reducer compares it against the state
 * it is actually reducing, so the reducer is provably the layer that answers.
 */
async function buildDriftedScene(): Promise<RecoveryScene> {
  const scene = await buildRecoveryScene("reducer");
  const state = projectStateOf(scene.store, PROJECT_ID);
  if (state === null) throw new Error("drift fixture found no durable project state");
  const stateBytes = utf8.encode(JSON.stringify(state));
  const at = scene.store.getAggregateVersion(PROJECT_ID);
  const response = scene.store.commitExpectedVersionDecision({
    commandKind: "recovery.complete", committedResultBytes: stateBytes,
    correlationId: "corr-integrity-drift", decidedAt: DECIDED_AT,
    events: [{
      domainSchemaVersion: "moe-recovery-completion/1", eventId: `project-drift-${at}`,
      eventType: "ProjectAggregateDrifted", payload: stateBytes,
    }],
    expectedVersion: at,
    key: {
      commandId: "recovery-drift-1", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: stateBytes, targetAggregateId: PROJECT_ID,
  });
  if (response.decision.resultCode !== "EFFECTS_COMMITTED") {
    throw new Error(`drift fixture refused: ${response.decision.resultCode}`);
  }
  return { ...scene, version: scene.store.getAggregateVersion(PROJECT_ID) };
}

const driftedScene = (): Promise<RecoveryScene> => (reducerScene ??= buildDriftedScene());

interface CompletionShape {
  readonly approvalRef?: string;
  readonly commandId?: string;
  readonly exactRevisionHash?: string;
  readonly expectedVersion?: number;
  readonly record?: Record<string, unknown>;
}

function completionBytes(scene: RecoveryScene, shape: CompletionShape): Uint8Array {
  const approval = {
    actor: PRINCIPAL_ID, actorKind: "HUMAN",
    applicablePolicyRef: scene.policyRevisionRef,
    approvalRef: shape.approvalRef ?? "approval-recovery-r3-1", approvedNodeScope: [],
    budgetRef: hex64("budget"), criteriaRef: hex64("criteria"), decision: null,
    decisionReason: null, dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash: shape.exactRevisionHash ?? scene.digest, lifecycle: "PENDING",
    planQualityAssessmentRef: hex64("plan-quality"), policyDecisionRef: null, riskTier: "R3",
    stepUpAuthRef: STEP_UP_REF, truthClass: "HUMAN_APPROVED", validity: "CURRENT",
    ...shape.record,
  };
  return utf8.encode(JSON.stringify({
    commandId: shape.commandId ?? "recovery-complete-integrity-1",
    correlationId: "corr-complete-integrity", decidedAt: DECIDED_AT,
    expectedVersion: shape.expectedVersion ?? scene.version, kind: "recovery.complete",
    payload: {
      approval, authentication: { presentation: "integrity-slice" },
      command: {
        decision: "APPROVE", decisionReason: DECISION_REASON, kind: "approval.decide",
        stepUpAuthRef: STEP_UP_REF,
      },
      reconciliationDigest: scene.recordDigest,
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: "moe-recovery-completion/1",
  }));
}

/**
 * A stub of the INJECTED step-up authority port, not of the boundary under test. It grants,
 * so the CORE_APPROVAL and PROJECT_REDUCER layers downstream of it are reachable at all;
 * every refusal these cases assert is produced by real production code past this seam.
 */
const grantingAuthority: RecoveryCompletionAuthority = {
  authorize: (input) => Object.freeze({
    ok: true as const, principalId: PRINCIPAL_ID, stepUpAuthRef: STEP_UP_REF,
    subjectDigest: input.recoveryDigest,
  }),
};

const runOn = async (
  scene: RecoveryScene, shape: CompletionShape,
): Promise<unknown> => asLayered(
  runRecoveryCompleteCommand(scene.store, completionBytes(scene, shape), grantingAuthority),
  "refusedBy",
);

const runCompletion = async (shape: CompletionShape): Promise<unknown> =>
  runOn(await recoveryScene(), shape);

const runDrifted = async (shape: CompletionShape): Promise<unknown> =>
  runOn(await driftedScene(), shape);

/** A genuine production digest over a DIFFERENT coverage set: the evidence tuple is copied
 *  and its configured classes reversed, then re-digested by `recoveryCompletionDigest`. The
 *  approval therefore carries a real, well-formed completion digest naming other evidence. */
const foreignEvidenceDigest = (scene: RecoveryScene): string => recoveryCompletionDigest({
  ...scene.evidence, configuredClasses: [...scene.evidence.configuredClasses].reverse(),
});

const completionCases: readonly HostileCase[] = [
  before(
    "RECOVERY_COMPLETION_LAYER", "a completion observing a version the project has left",
    { code: "RECOVERY_COMPLETION_STALE", layer: COMPLETION_LAYER },
    // The envelope decodes and the evidence reads cleanly, so ingress and the inventory
    // layer are both satisfied and this layer's own CAS is provably what refused.
    async () => runCompletion({
      commandId: "recovery-complete-stale-1", expectedVersion: 0,
    }),
  ),
  forged(
    "RECOVERY_COMPLETION_LAYER", "an approval bound to a resealed foreign evidence digest",
    { code: "RECOVERY_COMPLETION_DIGEST_MISMATCH", layer: COMPLETION_LAYER },
    // Reseal proof: the forged binding is a real hex64 digest produced by the production
    // digest over a legitimate evidence tuple, so it is not a corrupted field — it names
    // other evidence. Proved by re-deriving it and checking it differs from the scene's.
    async () => {
      const scene = await recoveryScene();
      return {
        // Two clauses, neither satisfiable by a hand-written hex string. The first binds the
        // digest function to the production evidence READER — the same authority that seals a
        // genuine completion re-derives the scene's own digest. The second says the forgery is
        // that authority's digest over OTHER evidence, not a corrupted field.
        ok: recoveryCompletionDigest(scene.evidence) === scene.digest
          && foreignEvidenceDigest(scene) !== scene.digest,
      };
    },
    async () => {
      const scene = await recoveryScene();
      return runCompletion({
        commandId: "recovery-complete-forged-1",
        exactRevisionHash: foreignEvidenceDigest(scene),
      });
    },
  ),
  racing(
    "RECOVERY_COMPLETION_LAYER", "a stale observation races a foreign evidence binding",
    async () => runCompletion({
      commandId: "recovery-complete-race-left", expectedVersion: 0,
    }),
    async () => {
      const scene = await recoveryScene();
      return runCompletion({
        commandId: "recovery-complete-race-right",
        exactRevisionHash: foreignEvidenceDigest(scene),
      });
    },
  ),
];

const coreApprovalCases: readonly HostileCase[] = [
  before(
    "CORE_APPROVAL_LAYER", "an approval record that is not a legal decision subject",
    { code: "INPUT_INVALID", layer: APPROVAL_LAYER },
    // Reached only because the envelope, the evidence and the CAS all passed: this layer
    // sits behind all three, so a fixture invalid earlier would never arrive here.
    async () => runCompletion({
      commandId: "recovery-complete-approval-1", record: { riskTier: "R9" },
    }),
  ),
  after(
    "CORE_APPROVAL_LAYER", "an approval already decided before this command ran",
    { code: "ILLEGAL_TRANSITION", layer: APPROVAL_LAYER },
    async () => runCompletion({
      commandId: "recovery-complete-approval-2",
      record: { decision: "APPROVE", decisionReason: DECISION_REASON, lifecycle: "DECIDED" },
    }),
  ),
  racing(
    "CORE_APPROVAL_LAYER", "a malformed subject races an already-decided one",
    async () => runCompletion({
      commandId: "recovery-complete-approval-race-left", record: { riskTier: "R9" },
    }),
    async () => runCompletion({
      commandId: "recovery-complete-approval-race-right",
      record: { decision: "APPROVE", decisionReason: DECISION_REASON, lifecycle: "DECIDED" },
    }),
  ),
];

const reducerCases: readonly HostileCase[] = [
  before(
    "PROJECT_REDUCER_LAYER", "a completion whose aggregate moved past the state it reduces",
    { code: "EXPECTED_VERSION_CONFLICT", layer: REDUCER_LAYER },
    // Ingress, evidence and the daemon's own CAS have all already answered yes — the CAS
    // compares against `getAggregateVersion`, which the drift satisfies. Only the reducer
    // compares the caller's number against the state it is reducing.
    async () => runDrifted({ commandId: "recovery-complete-reducer-1" }),
  ),
  after(
    "PROJECT_REDUCER_LAYER", "the drifted completion re-presented under a fresh identity",
    { code: "EXPECTED_VERSION_CONFLICT", layer: REDUCER_LAYER },
    async () => runDrifted({ commandId: "recovery-complete-reducer-2" }),
  ),
  racing(
    "PROJECT_REDUCER_LAYER", "two completions race one drifted project aggregate",
    async () => runDrifted({ commandId: "recovery-complete-reducer-race-left" }),
    async () => runDrifted({ commandId: "recovery-complete-reducer-race-right" }),
  ),
];

// ---------------------------------------------------------------------------
// GRAPH_CONTENT_LAYERS — @moe/scheduler's canonical `GraphRevisionContent` codec.
// ---------------------------------------------------------------------------

const GRAPH_CONTENT = GRAPH_CONTENT_LAYERS;

/**
 * ONLY THE PUBLISHED CODEC IS CALLED. `packages/scheduler/src/index.ts` exports
 * `encodeGraphContent`/`decodeGraphContent` and deliberately WITHHOLDS `canonicalGraphJson`
 * and `graphContentDigest`, because a caller holding either could mint bytes or a hash the
 * graph kernel never accepted. A probe reaching past the barrel would prove nothing about
 * what a consumer can actually do, so every arm below goes through the two exported entries
 * and every byte string it forges is derived from bytes production itself sealed.
 *
 * THE THREE DECLARED MEMBERS ARE SPREAD ACROSS THE ARMS rather than one exercised three
 * times: GRAPH_CONTENT_CODEC and GRAPH_VALIDATION on the two BEFORE arms, GRAPH_CONTENT_IDENTITY
 * on the forgery and on the non-canonical re-spelling. GRAPH_VALIDATION is the one that matters
 * most here — it is the passthrough branch, where a structural failure keeps the kernel's OWN
 * code instead of being restamped.
 *
 * IDENTITY IS PINNED TWICE BECAUSE IT ANSWERS TWICE, at two guards neither of which subsumes
 * the other (`graph-content.ts:216` vs `:224`): a swapped VALUE whose bytes are canonical is
 * caught only by the digest recompute, an alternate SPELLING of correct content recomputes the
 * right digest and is caught only by the re-encode. One arm each, so dropping either guard
 * reddens a NAMED case on its own code comparison.
 */

/**
 * This codec refuses with `{ ok: false, issues: [...] }`, not with a flat record, so
 * `assertRefusedWith` cannot read it and `asLayered` — which only re-keys top-level fields —
 * does not apply. This lifts production's own `code` and `layer` up UNREAD.
 *
 * It refuses to choose when production answered with more than one issue: picking `issues[0]`
 * would silently pin whichever the validator's `sortIssues` happened to order first, and the
 * case would then be asserting a branch it never arranged. Every arm below is built to produce
 * exactly one REFUSED issue, so this throws only if that stops being true — and it throws only
 * for a refusal, never for the admission it exists to catch.
 */
const soleIssue = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  // AN ADMITTED RESULT PASSES THROUGH UNTOUCHED, and that is load-bearing rather than tidy.
  // `{ ok: true, value }` carries no `issues`, so throwing below would fire on exactly the
  // outcome these arms exist to catch. On a RACE arm the throw INVERTS the verdict:
  // `probeRacing` catches every leg, `legValue` hands the caught Error to `admitted()`, an
  // Error carries no `ok`/`authority`/`truth`/`outcome`, and `expect(admitted(left))
  // .toBe(false)` then PASSES on an admission. Handing the record back unread lets
  // `admitted()` see its own `ok: true` and redden; on a BEFORE/AFTER arm it reddens twice —
  // the whole-slice invariant collects it, then `assertRefusedWith` reports the absent code.
  if (record["ok"] !== false) return value;
  const issues = record["issues"];
  if (!Array.isArray(issues) || issues.length !== 1) {
    throw new Error(
      "graph-content refusal must carry exactly one issue for a layer assertion to mean "
      + `anything, got ${Array.isArray(issues) ? issues.length : 0}`,
    );
  }
  const issue = issues[0] as Record<string, unknown>;
  return { ...record, code: issue["code"], layer: issue["layer"] };
};

/** A HARD chain dev-node-1 -> dev-node-2 -> dev-node-3, completion = the terminal node. */
const graphChain = (): Record<string, unknown> => ({
  nodes: [1, 2, 3].map((index) => ({ nodeKey: `dev-node-${index}`, executionBearing: true })),
  edges: [1, 2].map((index) => ({
    edgeKey: `dev-edge-${index}`, producerNodeKey: `dev-node-${index}`,
    consumerNodeKey: `dev-node-${index + 1}`, kind: "HARD",
  })),
  completionNodeKey: "dev-node-3",
});

/**
 * The same chain plus a HARD SELF EDGE. Integrity defects are collected first and cycle and
 * completion-closure are evaluated only once integrity holds (`validate-graph.ts:18-24`), so
 * this snapshot yields exactly ONE issue and there is no ambiguity about which layer answered.
 */
const selfEdgeGraph = (): Record<string, unknown> => {
  const chain = graphChain();
  const edges = chain["edges"] as readonly unknown[];
  return {
    ...chain,
    edges: [...edges, {
      edgeKey: "dev-edge-self", producerNodeKey: "dev-node-1",
      consumerNodeKey: "dev-node-1", kind: "HARD",
    }],
  };
};


/**
 * V3 AUTHORITY FOR THIS BLOCK'S FIXTURES (task-8c7e6ce4). `GraphRevisionContent` v3 makes
 * `nodeAuthority` a MANDATORY field and `bindAuthority` RE-DERIVES the stated set rather
 * than adopting it, so the seven-field bodies this block used to seal can no longer encode
 * at all. Everything below COMPOSES the published producers and judges nothing.
 *
 * DELIBERATELY LOCAL TO THIS BLOCK. The NODE_AUTHORITY sections further down build their
 * own v3 bodies, and reaching into them would couple these arms to fixtures that answer a
 * different boundary - and to node keys (`node-a`..`node-c`) this chain does not use.
 */
const gcHex = (digit: string): string => digit.repeat(64);

const gcPlanDraft = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-security"],
  affectedNodeIds: [...nodeKeys],
  approvalState: "APPROVED",
  authorRef: "principal-security",
  graphBinding: { graphContentHash: gcHex("a"), graphRevisionRef: "graph-revision-security" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-security",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-security" }],
  verificationRecipeRefs: ["recipe-security"],
});

const gcAcceptanceDraft = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  applicability: {
    graphContentHash: gcHex("a"), graphRevisionRef: "graph-revision-security",
    nodeIds: [...nodeKeys], nodeKind: "LEAF",
  },
  authorRef: "principal-security",
  contractId: "acceptance-security-authority",
  obligations: [{
    criterionId: "criterion-security",
    evidenceRequirements: [{
      evidenceRef: "artifact-security", kind: "ARTIFACT", requirementId: "requirement-security",
    }],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-security"],
  }],
});

/** A MONOTONIC contract owes a matching registry proof, else the node codec refuses
 *  NODE_AUTHORITY_MONOTONIC_PROOF_MISSING @ NODE_AUTHORITY_PROOFS before any of these
 *  arms could reach the guard it arranged. */
const GC_REGISTRY_ENTRY: Record<string, unknown> = {
  parameterSchema: { digest: gcHex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-security",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-security",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

/** ONE contract per HARD edge ENTERING a node. `binding` is a PARAMETER rather than a
 *  derived constant on purpose: handing it a DIFFERENT graph's structural identity is
 *  exactly the binding forgery DoD 3 requires an arm for, and it is the only knob moved. */
const gcRequirement = (
  edge: Record<string, unknown>, binding: string,
): Record<string, unknown> => ({
  edgeKey: edge["edgeKey"],
  requirement: {
    contract: {
      alternateProducers: [] as string[],
      alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
      consumer: {
        contractHash: gcHex("c"), criterionRef: "criterion-security", kind: "PRECONDITION",
      },
      consumerNodeKey: edge["consumerNodeKey"],
      consumptionHorizon: "RESULT_SEAL",
      edgeKind: "ARTIFACT_CONSUMPTION",
      graphBindingDigest: binding,
      invalidationFacts: [{
        sourceFactDigest: gcHex("e"), sourceFactRef: "fact-security", sourceFactVersion: 1,
      }],
      minimumQualifyingMilestone: "RESULT_SEALED",
      necessity: {
        failedConsumerCriterionRef: "criterion-security", failureKind: "MISSING_ARTIFACT",
        truthClass: "OBSERVED",
      },
      producer: {
        artifactOrInterfaceRef: "artifact-security", digest: gcHex("f"),
        kind: "ARTIFACT_CONSUMPTION",
      },
      producerNodeKey: edge["producerNodeKey"],
      recheckPredicateRef: "predicate-security",
      satisfactionPredicate: {
        parametersDigest: gcHex("1"), predicateRef: "predicate-security",
        schemaId: "schema-security", schemaVersion: 1,
      },
      satisfactionWitnesses: [{
        sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: gcHex("2"),
        witnessRef: "witness-security", witnessVersion: 1,
      }],
      stability: "MONOTONIC",
      truthClass: "OBSERVED",
    },
    edgeKind: "ARTIFACT_CONSUMPTION",
  },
});

/** The structural identity PRODUCTION assigns this snapshot. `snapshotIdentityHash` accepts
 *  only the brand-protected `ValidatedGraph`, so it cannot be reached for a graph the kernel
 *  never accepted - which is what makes the donor binding below a REAL one rather than a
 *  hex literal a mismatch test could pass against by accident. */
function gcBinding(snapshot: Record<string, unknown>): string {
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  return snapshotIdentityHash(validated.graph);
}

/** Admitted by PRODUCTION or not built at all: a body the node codec refuses could never
 *  reach the graph-content guard the arm using it arranged. */
function gcDefinitions(
  snapshot: Record<string, unknown>, binding: string,
): readonly unknown[] {
  const nodes = snapshot["nodes"] as readonly Record<string, unknown>[];
  const edges = snapshot["edges"] as readonly Record<string, unknown>[];
  const nodeKeys = nodes.map((node) => String(node["nodeKey"]));
  return [...nodeKeys].sort().map((nodeKey) => {
    const plan = createPlanRevision(gcPlanDraft(nodeKeys));
    if (!plan.ok) throw new Error(`plan fixture refused: ${plan.code}`);
    const acceptance = createAcceptanceContract(gcAcceptanceDraft(nodeKeys));
    if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
    const completes = nodeKey === snapshot["completionNodeKey"];
    const built = createNodeDefinition({
      acceptanceContract: acceptance.contract,
      draft: {
        admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
          meter: "runner.authorized_ms", purpose, quantity: index + 1,
        })),
        admissionGatePolicy: "POLICY_ALLOWANCE", capability: "capability-implement",
        completionLinkage: completes ? nodeKey : null,
        constraints: ["constraint-security"],
        directHardDependencies: edges
          .filter((edge) => edge["kind"] === "HARD" && edge["consumerNodeKey"] === nodeKey)
          .map((edge) => gcRequirement(edge, binding)),
        joinRole: completes ? "COMPLETION" : "NONE",
        nodeKey, objective: `Land ${nodeKey}.`, policySliceHash: gcHex("3"),
        readScopes: ["services/api/src"], repositoryBaseTree: gcHex("4"),
        resources: ["resource-security"], verificationRecipeRevisions: ["recipe-security"],
        writeScopes: ["services/api/src/node"],
      },
      planRevision: plan.revision,
      predicateRegistry: [GC_REGISTRY_ENTRY],
    });
    if (!built.ok) {
      throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
    }
    return built.value.definition;
  });
}

/** The PRODUCER'S own set, never a rebuilt one. Memoised because every seal below walks it
 *  and the arms differ in the BYTES they forge, never in the graph they seal. */
let gcSection: Record<string, unknown> | null = null;
function graphAuthority(): Record<string, unknown> {
  if (gcSection !== null) return gcSection;
  const chain = graphChain();
  const definitions = gcDefinitions(chain, gcBinding(chain));
  const derived = deriveNodeAuthoritySet(chain, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  gcSection = { authorities: derived.value, definitions };
  return gcSection;
}

/** A structurally DIFFERENT accepted graph, so its identity is a real production binding
 *  that this chain's contracts have no right to carry. */
const gcDonorChain = (): Record<string, unknown> => ({
  nodes: [1, 2].map((index) => ({ nodeKey: `dev-node-${index}`, executionBearing: true })),
  edges: [{
    edgeKey: "dev-edge-1", producerNodeKey: "dev-node-1",
    consumerNodeKey: "dev-node-2", kind: "HARD",
  }],
  completionNodeKey: "dev-node-2",
});

/** The EIGHT design-197/255 content fields. `completionNode` agrees with the snapshot's own
 *  completion node, `repositoryBaseTree` is a legal 40-hex tree id, and `nodeAuthority` is
 *  the production-DERIVED v3 section, so the field reader and the reconciliation both admit
 *  every record built here.
 *
 *  `authority` DEFAULTS to the accepted chain's section instead of being derived from the
 *  `snapshot` argument, and that default is load-bearing: the self-edge arm below passes a
 *  snapshot the kernel REFUSES, so deriving from it would throw inside the fixture instead
 *  of letting `encodeGraphContent` answer. The field reader checks only the section's SHAPE
 *  and validation runs before `bindAuthority` (`graph-content.ts:157-166`), so a well-formed
 *  section keeps the graph kernel as the branch that provably answered. */
const graphContentRecord = (
  author: string, snapshot: Record<string, unknown> = graphChain(),
  authority: Record<string, unknown> = graphAuthority(),
): Record<string, unknown> => ({
  author,
  completionNode: snapshot["completionNodeKey"],
  decompositionBudget: 3,
  nodeAuthority: authority,
  parentRevision: null,
  policyRevision: "dev-policy-1",
  repositoryBaseTree: "a".repeat(40),
  snapshot,
});

/** Seals through the PRODUCTION encoder, the only route to a `graphContentHash`. */
function sealedGraphContent(author: string): { bytes: Uint8Array; graphContentHash: string } {
  const encoded = encodeGraphContent(graphContentRecord(author));
  if (!encoded.ok) {
    throw new Error(`graph content reseal refused at encode: ${encoded.issues[0]?.code ?? "?"}`);
  }
  return { bytes: encoded.value.bytes, graphContentHash: encoded.value.graphContentHash };
}

/** One content's canonical bytes carrying ANOTHER content's production-sealed hash. Both
 *  halves are real: the envelope still parses, the schema tag is untouched, the fields still
 *  read and the declared completion node still agrees, so the re-derived digest comparison is
 *  the first thing on the path that can possibly refuse. */
function forgedGraphBytes(): Uint8Array {
  const donor = sealedGraphContent("dev-author-a");
  const carrier = sealedGraphContent("dev-author-b");
  return utf8.encode(
    decoder.decode(carrier.bytes).replace(carrier.graphContentHash, donor.graphContentHash),
  );
}

/** The sealed bytes with the ENVELOPE keys REVERSED. `readContentEnvelope` checks the key
 *  SET, so shape, schema and the digest all still pass and the canonical re-encode is
 *  provably the only branch left that can answer. */
function reSpelledGraphBytes(): Uint8Array {
  const parsed: unknown = JSON.parse(decoder.decode(sealedGraphContent("dev-author-a").bytes));
  const record = parsed as Record<string, unknown>;
  return utf8.encode(JSON.stringify(
    Object.fromEntries(Object.keys(record).reverse().map((key) => [key, record[key]])),
  ));
}

/** A DUPLICATED `hash` key. `JSON.parse` keeps the last, so the envelope reads clean and the
 *  digest still matches — but the bytes are not the canonical spelling of their own content. */
function duplicateKeyGraphBytes(): Uint8Array {
  const sealed = sealedGraphContent("dev-author-a");
  return utf8.encode(
    decoder.decode(sealed.bytes).replace('"hash":', `"hash":"${"0".repeat(64)}","hash":`),
  );
}


/** Sealed bytes whose ENVELOPE names the SUPERSEDED schema version. Content, hash and the
 *  v3 authority section are all production's own and untouched, so exactly two guards sit
 *  earlier - a real Uint8Array under the ceiling, and one fatal-decodable JSON document -
 *  and both admit it. The version gate is provably the branch that answered. */
function oldVersionGraphBytes(): Uint8Array {
  const text = decoder.decode(sealedGraphContent("dev-author-a").bytes);
  const stale = text.replace(
    '"schema":"MOE-GRAPH-CONTENT/3"', '"schema":"MOE-GRAPH-CONTENT/2"',
  );
  if (stale === text) throw new Error("sealed graph content did not state the v3 schema tag");
  return utf8.encode(stale);
}

/** The accepted chain's REAL derived authorities, beside definitions whose HARD-edge
 *  contracts are bound to a DIFFERENT accepted graph. Every half is production-minted: the
 *  donor binding is `snapshotIdentityHash` over a graph the kernel accepted, and each body
 *  carrying it was admitted by `createNodeDefinition` - so no earlier guard can answer and
 *  the recursion's closure check is the first thing on the path that can. */
function bindingForgedGraphRecord(): Record<string, unknown> {
  const chain = graphChain();
  return graphContentRecord("dev-author-a", chain, {
    authorities: graphAuthority()["authorities"],
    definitions: gcDefinitions(chain, gcBinding(gcDonorChain())),
  });
}

const graphContentCases: readonly HostileCase[] = [
  before(
    "GRAPH_CONTENT_LAYERS", "canonical graph-content bytes truncated mid-envelope",
    {
      code: "GRAPH_CONTENT_UNREADABLE",
      layer: layerOf(GRAPH_CONTENT, "GRAPH_CONTENT_CODEC"),
    },
    // Forty bytes lands inside the `hash` string, so the input never becomes one JSON
    // document. Exactly two guards sit earlier and both ADMIT it — it is a real Uint8Array
    // and it is far under the size ceiling — so the bounded read is provably the branch that
    // answered, and nothing later on the path is reachable.
    async () => soleIssue(
      decodeGraphContent(sealedGraphContent("dev-author-a").bytes.slice(0, 40)),
    ),
  ),
  before(
    "GRAPH_CONTENT_LAYERS", "a structurally invalid snapshot keeps the graph kernel's own code",
    {
      code: "GRAPH_SELF_EDGE",
      layer: layerOf(GRAPH_CONTENT, "GRAPH_VALIDATION"),
    },
    // All six caller-stated fields are the sealed fixture's own, so the field reader admits
    // the record and the graph kernel is provably the branch that answered. The expected code
    // is the KERNEL's, not one of this codec's: the arm reddens if a structural failure is
    // ever restamped as GRAPH_CONTENT_MALFORMED, which is the whole point of `passthrough`.
    async () => soleIssue(
      encodeGraphContent(graphContentRecord("dev-author-a", selfEdgeGraph())),
    ),
  ),
  forged(
    "GRAPH_CONTENT_LAYERS", "one content's sealed hash carried onto a different content",
    {
      code: "GRAPH_CONTENT_DIGEST_MISMATCH",
      layer: layerOf(GRAPH_CONTENT, "GRAPH_CONTENT_IDENTITY"),
    },
    // HALF ONE. Both halves of the forgery are re-sealed through the PRODUCTION encoder and
    // the forged bytes are asserted to be EXACTLY the carrier's own canonical bytes with the
    // donor's production hash substituted. Without this the case is indistinguishable from a
    // stale-digest probe and would pass against a codec that binds no subject at all.
    async () => {
      const donor = encodeGraphContent(graphContentRecord("dev-author-a"));
      const carrier = encodeGraphContent(graphContentRecord("dev-author-b"));
      if (!donor.ok || !carrier.ok) return { ok: false };
      const resealed = decoder.decode(carrier.value.bytes)
        .replace(carrier.value.graphContentHash, donor.value.graphContentHash);
      return { ok: resealed === decoder.decode(forgedGraphBytes()) };
    },
    // HALF TWO. Shape, schema tag, field read and the completion reconciliation all pass, and
    // the digest recompute runs BEFORE the canonical re-encode (`graph-content.ts:216` vs
    // `:224`), so IDENTITY answers with a mismatch rather than the misleading NONCANONICAL.
    async () => soleIssue(decodeGraphContent(forgedGraphBytes())),
  ),
  after(
    "GRAPH_CONTENT_LAYERS", "sealed bytes re-spelled with the envelope keys reversed",
    {
      code: "GRAPH_CONTENT_NONCANONICAL",
      layer: layerOf(GRAPH_CONTENT, "GRAPH_CONTENT_IDENTITY"),
    },
    // NO EARLIER GUARD CAN ANSWER, and each is named rather than assumed. The input is a real
    // Uint8Array far under the ceiling; it is fatal-decodable UTF-8 carrying one JSON document;
    // `readContentEnvelope` compares the key SET, which a reversal leaves exact; the schema tag
    // is the sealed one; the seven content fields are the sealed record's own, so the field
    // read admits them and the snapshot is the same accepted chain; the declared completion
    // node still agrees; and the digest is recomputed over the graph and the fields, NEITHER of
    // which moved, so it matches. The canonical re-encode comparison is the only branch left.
    // That is what makes the pin mean something: a codec that stopped re-encoding would answer
    // `ok: true` on these bytes, and this arm reddens on its own code rather than on a crash.
    async () => soleIssue(decodeGraphContent(reSpelledGraphBytes())),
  ),
  before(
    "GRAPH_CONTENT_LAYERS", "sealed bytes whose envelope names the superseded schema version",
    {
      code: "GRAPH_CONTENT_UNSUPPORTED_SCHEMA",
      layer: layerOf(GRAPH_CONTENT, "GRAPH_CONTENT_CODEC"),
    },
    // DoD 3's OLD-VERSION path. The tag is the only edit; the content beneath it is a v3
    // record with a real derived authority section, so a codec that stopped checking the
    // version would decode these bytes successfully rather than fail some other way.
    async () => soleIssue(decodeGraphContent(oldVersionGraphBytes())),
  ),
  forged(
    "GRAPH_CONTENT_LAYERS", "hard-edge contracts sealed to a different accepted graph",
    {
      code: "NODE_AUTHORITY_RECURSION_BINDING_MISMATCH",
      // The FOREIGN authority's own layer, read out of ITS declared roster rather than this
      // codec's: GRAPH_CONTENT_LAYERS has three members and this is not one of them. That is
      // the property under test - `authorityPassthrough` must carry the composer's code AND
      // layer out unrestamped, so a reader can tell which authority refused.
      layer: layerOf(NODE_AUTHORITY_RECURSION_LAYERS, "NODE_AUTHORITY_RECURSION"),
    },
    // HALF ONE. The donor binding is a REAL production identity over a genuinely different
    // accepted graph, not a hex literal, and it differs from the carrier's. `gcDefinitions`
    // throws unless `createNodeDefinition` ADMITTED every body carrying it, so reaching this
    // return proves the forged material passed its own admission.
    async () => {
      const chain = graphChain();
      const carrier = gcBinding(chain);
      const donor = gcBinding(gcDonorChain());
      const definitions = gcDefinitions(chain, donor);
      return {
        ok: donor !== carrier && /^[0-9a-f]{64}$/u.test(donor)
          && definitions.length === (chain["nodes"] as readonly unknown[]).length,
      };
    },
    // HALF TWO. The field reader admits the section, the kernel accepts the snapshot and the
    // completion node still agrees, so `bindAuthority` is reached and the recursion's closure
    // check answers. DoD 3's BINDING path.
    async () => soleIssue(encodeGraphContent(bindingForgedGraphRecord())),
  ),
  racing(
    "GRAPH_CONTENT_LAYERS", "a re-spelled envelope races a duplicated hash key",
    async () => soleIssue(decodeGraphContent(reSpelledGraphBytes())),
    async () => soleIssue(decodeGraphContent(duplicateKeyGraphBytes())),
  ),
];

// ---------------------------------------------------------------------------
// FOUNDATION_REPOSITORY_SCOPE_LAYERS - the daemon-startup repository/scope catalog.
// ---------------------------------------------------------------------------

/**
 * TWO LAYERS SIT IN SERIES on this boundary, so every arm below names which one
 * answered. The codec refuses operator configuration under
 * DAEMON_REPOSITORY_SCOPE_CATALOG; resolution refuses a catalog whose seal no
 * longer covers its entries under DAEMON_REPOSITORY_SCOPE_RESOLUTION. A
 * code-only assertion here would stay green the moment one layer started
 * answering for the other's condition.
 */
const REPOSITORY_SCOPE = FOUNDATION_REPOSITORY_SCOPE_LAYERS;

const repositoryScopeEntry = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  declaredPaths: ["apps/daemon/src"],
  projectId: "project-security",
  repositoryRef: "repo-security",
  scopeRef: "scope-security",
  sourceRepositoryRoot: "D:\\projexts\\moe-security",
  worktreeParent: "D:\\projexts\\moe-security-worktrees",
  ...overrides,
});

const repositoryScopeInput = (
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION, entries,
});

/** Sealed BY PRODUCTION; no test helper can mint one of these digests. */
function sealedRepositoryScopeCatalog(scopeRef: string): FoundationRepositoryScopeCatalog {
  const result = decodeFoundationRepositoryScopeCatalog(
    repositoryScopeInput([repositoryScopeEntry({ scopeRef })]),
  );
  if (!result.ok) {
    throw new Error(`repository-scope catalog refused: ${result.code}@${result.layer}`);
  }
  return result.catalog;
}

/**
 * A GENUINE production digest carried onto a DIFFERENT admitted field set. The
 * carrier decodes cleanly and every field in it was admitted by the codec; the
 * only thing wrong is that the seal it presents belongs to the donor.
 */
function forgedRepositoryScopeCatalog(): FoundationRepositoryScopeCatalog {
  const donor = sealedRepositoryScopeCatalog("scope-donor");
  const carrier = sealedRepositoryScopeCatalog("scope-carrier");
  return { ...carrier, digest: donor.digest };
}

/** The store is never read on this arm: the seal is checked before any ledger page. */
function repositoryScopeStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest("project-security");
  openedStores.push(store);
  return store;
}

const repositoryScopeRequest = (scopeRef: string): Record<string, unknown> => ({
  baseRevisionHash: hex64("repository-scope-base"), projectId: "project-security",
  repositoryRef: "repo-security", scopeRef,
});

/** An accessor that answers a canonical root once and a swapped root afterwards. */
function accessorRepositoryScopeEntry(): Record<string, unknown> {
  const entry = repositoryScopeEntry();
  let reads = 0;
  Object.defineProperty(entry, "sourceRepositoryRoot", {
    configurable: true, enumerable: true,
    get: () => (reads += 1) === 1 ? "D:\\projexts\\moe-security" : "D:\\projexts\\swapped",
  });
  return entry;
}

const repositoryScopeCases: readonly HostileCase[] = [
  before(
    "FOUNDATION_REPOSITORY_SCOPE_LAYERS", "a UNC host root is admitted by no normalization",
    {
      code: "FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID",
      layer: layerOf(REPOSITORY_SCOPE, "DAEMON_REPOSITORY_SCOPE_CATALOG"),
    },
    async () => decodeFoundationRepositoryScopeCatalog(repositoryScopeInput([
      repositoryScopeEntry({ sourceRepositoryRoot: "\\\\server\\share\\moe" }),
    ])),
  ),
  forged(
    "FOUNDATION_REPOSITORY_SCOPE_LAYERS", "one sealed digest carried onto another entry set",
    {
      code: "FOUNDATION_REPOSITORY_SCOPE_CATALOG_DIGEST_MISMATCH",
      layer: layerOf(REPOSITORY_SCOPE, "DAEMON_REPOSITORY_SCOPE_RESOLUTION"),
    },
    async () => {
      const donor = sealedRepositoryScopeCatalog("scope-donor");
      const carrier = sealedRepositoryScopeCatalog("scope-carrier");
      const forgery = forgedRepositoryScopeCatalog();
      return {
        ok: donor.digest !== carrier.digest && forgery.digest === donor.digest
          && forgery.entries[0]?.scopeRef === carrier.entries[0]?.scopeRef,
      };
    },
    // The codec admitted every field of the carrier independently, so the
    // recomputed seal is the first guard that can answer for the pair.
    async () => resolveFoundationRepositoryScope(
      repositoryScopeStore(), forgedRepositoryScopeCatalog(),
      repositoryScopeRequest("scope-carrier"),
    ),
  ),
  racingExactly(
    "FOUNDATION_REPOSITORY_SCOPE_LAYERS", "a case-folded path pair races an accessor entry",
    {
      code: "FOUNDATION_REPOSITORY_SCOPE_PATH_CASE_COLLISION",
      layer: layerOf(REPOSITORY_SCOPE, "DAEMON_REPOSITORY_SCOPE_CATALOG"),
    },
    {
      code: "FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR",
      layer: layerOf(REPOSITORY_SCOPE, "DAEMON_REPOSITORY_SCOPE_CATALOG"),
    },
    async () => decodeFoundationRepositoryScopeCatalog(repositoryScopeInput([
      repositoryScopeEntry({ declaredPaths: ["apps/Daemon/src", "apps/daemon/src"] }),
    ])),
    async () => decodeFoundationRepositoryScopeCatalog(
      repositoryScopeInput([accessorRepositoryScopeEntry()]),
    ),
  ),
];

// ---------------------------------------------------------------------------
// NODE_AUTHORITY_LAYERS and NODE_AUTHORITY_RECURSION_LAYERS - design 199/255's canonical
// node-body codec and the recursive authority derivation over a validated graph.
// ---------------------------------------------------------------------------

/**
 * ONLY THE PUBLISHED BARREL IS CALLED. `packages/scheduler/src/index.ts` forwards
 * `node-authority-public.ts` wholesale and that module deliberately WITHHOLDS
 * `canonicalText`, `nodeBodyDigest` and `canonicalEnvelopeJson`, because a caller holding
 * any of them could mint a body digest for a definition the codec never admitted. Every
 * fixture below is therefore sealed by `createNodeDefinition` + `encodeNodeDefinition`, and
 * every forged byte string is derived from bytes production itself sealed. Not one digest
 * in this block is hand-written.
 *
 * TWO CONSTANTS, TWO SUBJECTS, ONE FAMILY. `NODE_AUTHORITY_LAYERS` names the layers of the
 * body codec; `NODE_AUTHORITY_RECURSION_LAYERS` names the recursion's own two PLUS the
 * codec's eleven, because a foreign verdict travels out unchanged. They are covered
 * separately: a single block would let one boundary's arms satisfy the other's roster row.
 *
 * THE LAYERS ARE SPREAD ACROSS THE ARMS rather than one exercised three times.
 * NODE_AUTHORITY_CODEC answers the truncated read; NODE_AUTHORITY_IDENTITY answers twice, at
 * two guards neither of which subsumes the other (`node-authority-codec.ts:213` vs `:217`) -
 * a swapped VALUE is caught only by the digest recompute, an alternate SPELLING of correct
 * content recomputes the right digest and is caught only by the byte re-encode. On the
 * recursion side GRAPH_SNAPSHOT carries the graph kernel's OWN code out of the passthrough
 * branch, and NODE_AUTHORITY_RECURSION answers for what no single body can see.
 */

/**
 * The append-only twin of `soleIssue` above. Both codecs refuse with
 * `{ ok: false, issues: [...] }`, which `assertRefusedWith` cannot read and `asLayered` does
 * not reach. This one is separate rather than a reuse because its throw has to NAME this
 * boundary: a message about graph-content would misdirect the next reader of a red. It
 * refuses to choose between multiple issues for the same reason - picking `issues[0]` would
 * pin whichever branch happened to sort first, and the arm would assert something it never
 * arranged. An ADMITTED result passes through unread so `admitted()` can see its own
 * `ok: true` and redden, on a race arm as well as on a refusal arm.
 */
const soleNodeIssue = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record["ok"] !== false) return value;
  const issues = record["issues"];
  if (!Array.isArray(issues) || issues.length !== 1) {
    throw new Error(
      "a node-authority refusal must carry exactly one issue for a layer assertion to mean "
      + `anything, got ${Array.isArray(issues) ? issues.length : 0}`,
    );
  }
  const issue = issues[0] as Record<string, unknown>;
  return { ...record, code: issue["code"], layer: issue["layer"] };
};

const NODE_BODY = NODE_AUTHORITY_LAYERS;
const NODE_RECURSION = NODE_AUTHORITY_RECURSION_LAYERS;

const nodeHex = (digit: string): string => digit.repeat(64);
const NODE_PURPOSES = Object.freeze([...ADMISSION_PURPOSES].sort());

/** A HARD chain node-a -> node-b -> node-c(completion), plus one ADVISORY that carries no
 *  contract. `nodeCount` shortens the chain so a SECOND, genuinely different structure can
 *  be validated for the binding forgery below. */
const nodeSnapshotDraft = (nodeCount = 3): Record<string, unknown> => ({
  completionNodeKey: `node-${String.fromCharCode(96 + nodeCount)}`,
  edges: [
    ...Array.from({ length: nodeCount - 1 }, (_unused, index) => ({
      consumerNodeKey: `node-${String.fromCharCode(98 + index)}`,
      edgeKey: `edge-${String.fromCharCode(97 + index)}${String.fromCharCode(98 + index)}`,
      kind: "HARD", producerNodeKey: `node-${String.fromCharCode(97 + index)}`,
    })),
  ],
  nodes: Array.from({ length: nodeCount }, (_unused, index) => ({
    executionBearing: true, nodeKey: `node-${String.fromCharCode(97 + index)}`,
  })),
});

/**
 * The same chain plus a HARD SELF EDGE. `validate-graph.ts:18-24` collects integrity defects
 * first and evaluates cycle and completion closure only once integrity holds, so this
 * snapshot yields exactly ONE issue and there is no ambiguity about which layer answered.
 */
const nodeSelfEdgeSnapshot = (): Record<string, unknown> => {
  const draft = nodeSnapshotDraft();
  return {
    ...draft,
    edges: [...(draft["edges"] as readonly unknown[]), {
      consumerNodeKey: "node-a", edgeKey: "edge-self", kind: "HARD", producerNodeKey: "node-a",
    }],
  };
};

/** The structural binding a hard-edge contract must carry, taken from PRODUCTION. */
function nodeBinding(draft: Record<string, unknown>): string {
  const validated = validateGraphSnapshot(draft);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  return snapshotIdentityHash(validated.graph);
}

const NODE_BINDING = nodeBinding(nodeSnapshotDraft());
/** A DIFFERENT accepted structure, so the forged binding below is a real graph's identity
 *  rather than a random hex string a shape check could dismiss. */
const NODE_DONOR_BINDING = nodeBinding(nodeSnapshotDraft(2));

const nodePlanDraft = (): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-node"], affectedNodeIds: ["node-a", "node-b", "node-c"],
  approvalState: "APPROVED", authorRef: "principal-node",
  graphBinding: { graphContentHash: nodeHex("a"), graphRevisionRef: "graph-revision-node" },
  parentRevisionId: null, rejectionRef: null, revisionId: "plan-revision-node",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-node" }],
  verificationRecipeRefs: ["recipe-node"],
});

const nodeAcceptanceDraft = (): Record<string, unknown> => ({
  applicability: {
    graphContentHash: nodeHex("a"), graphRevisionRef: "graph-revision-node",
    nodeIds: ["node-a", "node-b", "node-c"], nodeKind: "LEAF",
  },
  authorRef: "principal-node", contractId: "acceptance-node",
  obligations: [{
    criterionId: "criterion-node",
    evidenceRequirements: [
      { evidenceRef: "artifact-node", kind: "ARTIFACT", requirementId: "requirement-node" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-node"],
  }],
});

const nodeRegistryEntry = (): Record<string, unknown> => ({
  parameterSchema: { digest: nodeHex("b"), kind: "JSON_SCHEMA" }, predicateRef: "predicate-node",
  proofRationale: "An artifact seal cannot become unsealed.", schemaId: "schema-node",
  schemaVersion: 1, sourceOperationClass: "ARTIFACT_SEAL",
});

const nodeContract = (
  consumer: string, producer: string, binding: string,
): Record<string, unknown> => ({
  alternateProducers: [] as string[],
  alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
  consumer: { contractHash: nodeHex("c"), criterionRef: "criterion-node", kind: "PRECONDITION" },
  consumerNodeKey: consumer, consumptionHorizon: "RESULT_SEAL", edgeKind: "ARTIFACT_CONSUMPTION",
  graphBindingDigest: binding,
  invalidationFacts: [
    { sourceFactDigest: nodeHex("e"), sourceFactRef: "fact-node", sourceFactVersion: 1 },
  ],
  minimumQualifyingMilestone: "RESULT_SEALED",
  necessity: {
    failedConsumerCriterionRef: "criterion-node", failureKind: "MISSING_ARTIFACT",
    truthClass: "OBSERVED",
  },
  producer: {
    artifactOrInterfaceRef: "artifact-node", digest: nodeHex("f"), kind: "ARTIFACT_CONSUMPTION",
  },
  producerNodeKey: producer, recheckPredicateRef: "predicate-node",
  satisfactionPredicate: {
    parametersDigest: nodeHex("1"), predicateRef: "predicate-node", schemaId: "schema-node",
    schemaVersion: 1,
  },
  satisfactionWitnesses: [{
    sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: nodeHex("2"),
    witnessRef: "witness-node", witnessVersion: 1,
  }],
  stability: "MONOTONIC", truthClass: "OBSERVED",
});

const nodeEdge = (
  edgeKey: string, consumer: string, producer: string, binding: string,
): Record<string, unknown> => ({
  edgeKey,
  requirement: { contract: nodeContract(consumer, producer, binding), edgeKind: "ARTIFACT_CONSUMPTION" },
});

/** `objective` is the only field a tag moves, so two sealed bodies differ in exactly one
 *  admitted value and their digests differ for a reason the arm can state. */
const nodeBodyDraft = (
  nodeKey: string, tag: string, edges: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  admissionAmounts: NODE_PURPOSES.map((purpose, index) => ({
    meter: "runner.authorized_ms", purpose, quantity: index + 1,
  })),
  admissionGatePolicy: "POLICY_ALLOWANCE", capability: "capability-implement",
  completionLinkage: nodeKey === "node-c" ? "node-c" : null,
  constraints: ["constraint-node"], directHardDependencies: edges,
  joinRole: nodeKey === "node-c" ? "COMPLETION" : "NONE",
  nodeKey, objective: `Land ${nodeKey} for ${tag}.`, policySliceHash: nodeHex("3"),
  readScopes: ["services/api/src"], repositoryBaseTree: nodeHex("4"),
  resources: ["resource-node"], verificationRecipeRevisions: ["recipe-node"],
  writeScopes: ["services/api/src/node"],
});

/** Admitted by PRODUCTION or not used at all: a body this throws on could never reach the
 *  guard an arm below arranges, so the arm would be asserting an unreachable branch. */
function admittedNodeBody(
  nodeKey: string, tag: string, edges: readonly Record<string, unknown>[] = [],
): unknown {
  const plan = createPlanRevision(nodePlanDraft());
  if (!plan.ok) throw new Error(`plan fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(nodeAcceptanceDraft());
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract, draft: nodeBodyDraft(nodeKey, tag, edges),
    planRevision: plan.revision, predicateRegistry: [nodeRegistryEntry()],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

/** Seals through the PRODUCTION encoder, then reads the envelope digest back OUT of the
 *  sealed bytes. Nothing here computes a digest; the envelope is production's own. */
function sealedNodeDefinition(tag: string): { bytes: Uint8Array; digest: string } {
  const encoded = encodeNodeDefinition(admittedNodeBody("node-a", tag));
  if (!encoded.ok) {
    throw new Error(`node body reseal refused at encode: ${encoded.issues[0]?.code ?? "?"}`);
  }
  const envelope = JSON.parse(decoder.decode(encoded.bytes)) as Record<string, unknown>;
  return { bytes: encoded.bytes, digest: String(envelope["digest"]) };
}

/** One body's canonical bytes carrying ANOTHER body's production-sealed digest. The envelope
 *  still parses, the key set is exact, the schema tag is untouched and the body still admits,
 *  so the digest recompute is the first thing on the path that can possibly refuse. */
function forgedNodeBytes(): Uint8Array {
  const donor = sealedNodeDefinition("donor");
  const carrier = sealedNodeDefinition("carrier");
  const text = decoder.decode(carrier.bytes);
  if (text.split(carrier.digest).length !== 2) {
    throw new Error("the sealed envelope does not state its digest exactly once");
  }
  return utf8.encode(text.replace(carrier.digest, donor.digest));
}

/** The sealed bytes with the ENVELOPE keys REVERSED. `readEnvelope` compares the key SET and
 *  says so in its own prose (`node-authority-codec.ts:163-164`), so shape, schema, admission
 *  and the digest all still pass and the byte re-encode is provably the only branch left. */
function reSpelledNodeBytes(): Uint8Array {
  const parsed = JSON.parse(
    decoder.decode(sealedNodeDefinition("canonical").bytes),
  ) as Record<string, unknown>;
  return utf8.encode(JSON.stringify(
    Object.fromEntries(Object.keys(parsed).reverse().map((key) => [key, parsed[key]])),
  ));
}

/** A DUPLICATED `digest` key. `JSON.parse` keeps the LAST, so the envelope reads clean and
 *  the digest still matches - but the bytes are not the canonical spelling of their content. */
function duplicateDigestKeyNodeBytes(): Uint8Array {
  const source = decoder.decode(sealedNodeDefinition("canonical").bytes);
  const duplicated = source.replace('"digest":', `"digest":"${"0".repeat(64)}","digest":`);
  if (duplicated === source) throw new Error("sealed node envelope carried no digest key");
  return utf8.encode(duplicated);
}

const nodeAuthorityCases: readonly HostileCase[] = [
  before(
    "NODE_AUTHORITY_LAYERS", "canonical node-body bytes truncated mid-envelope",
    {
      code: "NODE_AUTHORITY_UNREADABLE",
      layer: layerOf(NODE_BODY, "NODE_AUTHORITY_CODEC"),
    },
    // Forty bytes lands inside the envelope, so the input never becomes one JSON document.
    // Exactly two guards sit earlier and both ADMIT it - it is a real Uint8Array and it is
    // far under `NODE_AUTHORITY_LIMITS.maxBytes` - so the bounded read is provably the
    // branch that answered and nothing later on the path is reachable.
    async () => soleNodeIssue(
      decodeNodeDefinitionBytes(sealedNodeDefinition("before").bytes.slice(0, 40)),
    ),
  ),
  forged(
    "NODE_AUTHORITY_LAYERS", "one body's sealed digest carried onto a different body",
    {
      code: "NODE_AUTHORITY_DIGEST_MISMATCH",
      layer: layerOf(NODE_BODY, "NODE_AUTHORITY_IDENTITY"),
    },
    // HALF ONE. Both halves are sealed through the PRODUCTION encoder and the forged bytes
    // are asserted to be EXACTLY the carrier's own canonical bytes with the donor's
    // production digest substituted. Without this the case is indistinguishable from a
    // stale-digest probe and would pass against a codec that binds no body at all.
    async () => {
      const donor = sealedNodeDefinition("donor");
      const carrier = sealedNodeDefinition("carrier");
      const resealed = decoder.decode(carrier.bytes).replace(carrier.digest, donor.digest);
      return {
        ok: donor.digest !== carrier.digest
          && resealed === decoder.decode(forgedNodeBytes()),
      };
    },
    // HALF TWO. The envelope reads, the schema tag is the sealed one and the body is
    // re-admitted on its own, so IDENTITY answers with a mismatch rather than the
    // misleading NONCANONICAL that a re-spelling would produce.
    async () => soleNodeIssue(decodeNodeDefinitionBytes(forgedNodeBytes())),
  ),
  racingExactly(
    "NODE_AUTHORITY_LAYERS", "a re-spelled envelope races a duplicated digest key",
    // Both legs are pinned exactly rather than left to the shape assertion: the two inputs
    // reach the SAME guard by different routes, and only the exact tuple proves that a
    // codec which stopped re-encoding would redden here instead of admitting both.
    {
      code: "NODE_AUTHORITY_NONCANONICAL",
      layer: layerOf(NODE_BODY, "NODE_AUTHORITY_IDENTITY"),
    },
    {
      code: "NODE_AUTHORITY_NONCANONICAL",
      layer: layerOf(NODE_BODY, "NODE_AUTHORITY_IDENTITY"),
    },
    async () => soleNodeIssue(decodeNodeDefinitionBytes(reSpelledNodeBytes())),
    async () => soleNodeIssue(decodeNodeDefinitionBytes(duplicateDigestKeyNodeBytes())),
  ),
];

/** The three admitted bodies of the default chain, each edge wired to its CONSUMER's body.
 *  `binding` is a knob so the forgery below moves exactly one field. */
const nodeBodies = (binding: string = NODE_BINDING): unknown[] => [
  admittedNodeBody("node-a", "set"),
  admittedNodeBody("node-b", "set", [nodeEdge("edge-ab", "node-b", "node-a", binding)]),
  admittedNodeBody("node-c", "set", [nodeEdge("edge-bc", "node-c", "node-b", NODE_BINDING)]),
];

const nodeRecursionCases: readonly HostileCase[] = [
  before(
    "NODE_AUTHORITY_RECURSION_LAYERS",
    "a structurally invalid snapshot keeps the graph kernel's own code",
    {
      code: "GRAPH_SELF_EDGE",
      layer: layerOf(NODE_RECURSION, "GRAPH_SNAPSHOT"),
    },
    // The bodies handed in are the REAL admitted three, so the refusal cannot be an artifact
    // of an empty body set. The expected code is the KERNEL's, not this module's: the arm
    // reddens if a structural failure is ever restamped as NODE_AUTHORITY_RECURSION_MALFORMED,
    // which is the whole point of the `passthrough` branch at `node-authority-recursion.ts:213`.
    async () => soleNodeIssue(deriveNodeAuthoritySet(nodeSelfEdgeSnapshot(), nodeBodies())),
  ),
  forged(
    "NODE_AUTHORITY_RECURSION_LAYERS", "a hard-edge contract sealed to another graph structure",
    {
      code: "NODE_AUTHORITY_RECURSION_BINDING_MISMATCH",
      layer: layerOf(NODE_RECURSION, "NODE_AUTHORITY_RECURSION"),
    },
    // HALF ONE. The forged binding is a REAL accepted graph's identity, and the body that
    // carries it is still ADMITTED by `createNodeDefinition` - proven by re-running that
    // admission here. Without this half the case could pass against a module that refused
    // the body outright, which would test admission and not the structural binding at all.
    async () => {
      const plan = createPlanRevision(nodePlanDraft());
      const acceptance = createAcceptanceContract(nodeAcceptanceDraft());
      if (!plan.ok || !acceptance.ok) return { ok: false };
      const admittedForged = createNodeDefinition({
        acceptanceContract: acceptance.contract,
        draft: nodeBodyDraft("node-b", "set", [
          nodeEdge("edge-ab", "node-b", "node-a", NODE_DONOR_BINDING),
        ]),
        planRevision: plan.revision,
        predicateRegistry: [nodeRegistryEntry()],
      });
      return { ok: NODE_DONOR_BINDING !== NODE_BINDING && admittedForged.ok };
    },
    // HALF TWO. Validation admits the snapshot, all three bodies admit, the body set indexes
    // exactly onto the snapshot's nodes and the contract's endpoints match the edge, so the
    // binding comparison at `node-authority-recursion.ts:164` is the first guard that can
    // answer - and it answers under this module's own layer, not the graph's.
    async () => soleNodeIssue(
      deriveNodeAuthoritySet(nodeSnapshotDraft(), nodeBodies(NODE_DONOR_BINDING)),
    ),
  ),
  racingExactly(
    "NODE_AUTHORITY_RECURSION_LAYERS", "a body set short of a node races one that repeats one",
    // Two DISTINCT codes, both from `indexBodies`, so a module that collapsed the two
    // conditions into one verdict reddens on a named leg instead of staying green.
    {
      code: "NODE_AUTHORITY_RECURSION_NODE_MISSING",
      layer: layerOf(NODE_RECURSION, "NODE_AUTHORITY_RECURSION"),
    },
    {
      code: "NODE_AUTHORITY_RECURSION_NODE_DUPLICATE",
      layer: layerOf(NODE_RECURSION, "NODE_AUTHORITY_RECURSION"),
    },
    async () => soleNodeIssue(
      deriveNodeAuthoritySet(nodeSnapshotDraft(), nodeBodies().slice(0, 2)),
    ),
    async () => soleNodeIssue(deriveNodeAuthoritySet(nodeSnapshotDraft(), [
      ...nodeBodies().slice(0, 2), admittedNodeBody("node-b", "repeat"),
    ])),
  ),
];

// ---------------------------------------------------------------------------
// CONFIRMATORY_FREEZE_AUTHORITY_LAYER — record mechanism present, authority still WITHHELD.
//
// task-22b69ee5 produced the original unconditional withholding under ruling
// comment-b308bf89a6d24978a928eadc5bade7b1. task-3a10eb6b adds the strict record contract and
// fixed-path reader without installing a record. The legacy three arms keep proving that caller
// arguments and ambient state cannot redirect that fixed path. The three contract arms below
// separately prove malformed bytes, a form-valid foreign-scope forgery, and two raced semantic
// refusals all answer with authority NONE and their exact code/layer.
//
// Test records contain identifier strings only: no key material, signature, credential or corpus
// byte. The only file writes go to hostileRoot; none can reach the production reader's fixed path.
// ---------------------------------------------------------------------------

const CONFIRMATORY = "CONFIRMATORY_FREEZE_AUTHORITY_LAYER";

/** Same order of magnitude as `RACE_BOUND`, and far above an in-process read that settles in
 *  microseconds: an expiry here means the reader grew an I/O path, which is itself the finding. */
const CONFIRMATORY_BOUND = Object.freeze({
  label: "confirmatory-freeze-authority", timeoutMs: 2_000,
});

/** The LAYER is read out of the production constant so a rename reddens; the CODE is a hard
 *  literal so a re-spelling of the production code cannot move both sides together and stay
 *  green. Both halves are required — this boundary's whole evidentiary value is its exact tuple. */
type ConfirmatoryExpectation = RefusalExpectation & { readonly authority: "NONE" };

const confirmatoryExpectation = (code: string): ConfirmatoryExpectation => ({
  authority: "NONE",
  code,
  layer: soleLayer(CONFIRMATORY_FREEZE_AUTHORITY_LAYER, "CONFIRMATORY_FREEZE_AUTHORITY"),
});

const CONFIRMATORY_REFUSAL: ConfirmatoryExpectation = {
  authority: "NONE",
  code: "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED",
  layer: soleLayer(CONFIRMATORY_FREEZE_AUTHORITY_LAYER, "CONFIRMATORY_FREEZE_AUTHORITY"),
};

const authorityRecord = (scope: string): Record<string, unknown> => ({
  schemaVersion: 1,
  scope,
  scopeReference: "urn:hostile:confirmatory-corpus",
  independentAuthor: "hostile-independent-author-id",
  custodian: "hostile-custodian-id",
  allowedViewers: ["hostile-viewer-class"],
  restrictedArtifactBoundary: "hostile-artifact-boundary",
  separationFromImplementers: "hostile-separation-attestation",
  signatureAlgorithm: "hostile-algorithm-reference",
  signatureEncoding: "hostile-encoding-reference",
  signerKeyId: "hostile-key-reference",
  trustedPublicKeyDistribution: "hostile-distribution-semantics",
  keyRotation: "hostile-rotation-semantics",
  canonicalBytesCovered: "hostile-canonical-domain",
  issuedAt: "2026-08-23T00:00:00.000Z",
  timestampSemantics: "utc-rfc3339",
  publicRegistryReference: "hostile-public-registry-reference",
  registrySemantics: "hostile-append-only-semantics",
  redactionRules: "hostile-redaction-rules",
  staleAfter: "2998-01-01T00:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  revokedAt: null,
});

const authorityBytes = (record: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(record));

/** Writes only to a throwaway root, then proves the bytes are a complete production-valid form. */
function forgeAuthorityRecord(tag: string): string {
  const file = join(hostileRoot(`confirmatory-${tag}`), "confirmatory-freeze-authority.json");
  writeFileSync(file, JSON.stringify(authorityRecord("CONFIRMATORY_BENCHMARK_CORPUS")), "utf8");
  const validation = validateConfirmatoryFreezeAuthorityRecord(readFileSync(file));
  if (!validation.ok) throw new Error(`ambient authority fixture invalid: ${validation.code}`);
  return file;
}

/** Points a plausible environment surface at the planted record and hands back the undo. Restore
 *  is by CAPTURED PRIOR, including deleting a key that did not exist, so one arm cannot leak an
 *  authority-shaped variable into the rest of a fork the lane runs with `fileParallelism: false`. */
function pointEnvironmentAt(file: string, tag: string): () => void {
  const planted: Readonly<Record<string, string>> = {
    MOE_BENCHMARK_FREEZE_AUTHORITY_FILE: file,
    MOE_BENCHMARK_FREEZE_CUSTODIAN: `${tag}-custodian`,
    MOE_BENCHMARK_FREEZE_SIGNER_KEY_ID: `${tag}-signerKeyId`,
  };
  const prior = Object.keys(planted).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(planted)) {
    process.env[key] = value;
  }
  // READ BACK, for the same reason `forgeAuthorityRecord` re-reads its bytes: an arm whose plant
  // silently did nothing would still pass, and would then be asserting that a refusal survives
  // an environment nobody changed. This is the assertion that keeps the AFTER arm attached.
  const unset = Object.entries(planted).filter(([key, value]) => process.env[key] !== value);
  if (unset.length > 0) {
    throw new Error(`forged authority environment did not take: ${unset.map(([k]) => k).join(", ")}`);
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

const CONFIRMATORY_MALFORMED_BYTES = new TextEncoder().encode("{");
const CONFIRMATORY_FOREIGN_BYTES = authorityBytes(authorityRecord("FOREIGN_CORPUS"));
const CONFIRMATORY_REVOKED_BYTES = authorityBytes({
  ...authorityRecord("CONFIRMATORY_BENCHMARK_CORPUS"),
  revokedAt: "2026-08-23T01:00:00.000Z",
});
const CONFIRMATORY_EXPIRED_BYTES = authorityBytes({
  ...authorityRecord("CONFIRMATORY_BENCHMARK_CORPUS"),
  issuedAt: "1998-01-01T00:00:00.000Z",
  staleAfter: "1999-01-01T00:00:00.000Z",
  expiresAt: "2000-01-01T00:00:00.000Z",
});

const CONFIRMATORY_MALFORMED = confirmatoryExpectation(
  "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
);
const CONFIRMATORY_FOREIGN = confirmatoryExpectation(
  "CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE",
);
const CONFIRMATORY_REVOKED = confirmatoryExpectation(
  "CONFIRMATORY_FREEZE_AUTHORITY_REVOKED",
);
const CONFIRMATORY_EXPIRED = confirmatoryExpectation(
  "CONFIRMATORY_FREEZE_AUTHORITY_EXPIRED",
);

const confirmatoryFreezeAuthorityCases: readonly HostileCase[] = [
  before(
    CONFIRMATORY, "read BEFORE a complete forged authority record is planted",
    CONFIRMATORY_REFUSAL,
    // The ordering is the harness's, not the case's: `probeBefore` runs the read to completion
    // and only then applies the effect, so this arm pins the answer a caller gets on a machine
    // where nothing has been planted yet. Paired with the AFTER arm it is the falsifier for
    // "the refusal is really unconditional" — one of the two would move if it were not.
    async () => {
      let undo: (() => void) | undefined;
      try {
        const outcome = await probeBefore(
          CONFIRMATORY_BOUND,
          async () => readConfirmatoryFreezeAuthority(),
          async () => {
            const file = forgeAuthorityRecord("before");
            undo = pointEnvironmentAt(file, "before");
            return file;
          },
        );
        return outcome.probe;
      } finally {
        undo?.();
      }
    },
  ),
  after(
    CONFIRMATORY, "read AFTER a complete forged record is planted and the environment points at it",
    CONFIRMATORY_REFUSAL,
    // THE ARM THAT CARRIES THE PROPERTY. A complete authority record exists on disk and three
    // plausible variables name it, its custodian and its signer key id. A reader that consulted
    // any of them — or that grew a "configured authority" fallback later — answers differently
    // here and reddens on the exact tuple, which is the whole reason the tuple is pinned.
    async () => {
      let undo: (() => void) | undefined;
      try {
        const outcome = await probeAfter(
          CONFIRMATORY_BOUND,
          async () => {
            const file = forgeAuthorityRecord("after");
            undo = pointEnvironmentAt(file, "after");
            return file;
          },
          async () => readConfirmatoryFreezeAuthority(),
        );
        return outcome.probe;
      } finally {
        undo?.();
      }
    },
  ),
  racingExactly(
    CONFIRMATORY, "two reads race while forged records are planted under both of them",
    CONFIRMATORY_REFUSAL, CONFIRMATORY_REFUSAL,
    // Both legs are pinned EXACTLY rather than left to the shape assertion, and both are read
    // legs: a race in which only one side reads could be satisfied by a reader that answers
    // correctly once and then caches. The legs plant into SEPARATE roots and touch no shared
    // environment key, so neither can restore over the other — the interleaving is real and the
    // teardown is still deterministic. The yields put each plant on the other's continuation.
    async () => {
      forgeAuthorityRecord("race-left");
      await Promise.resolve();
      return readConfirmatoryFreezeAuthority();
    },
    async () => {
      await Promise.resolve();
      forgeAuthorityRecord("race-right");
      return readConfirmatoryFreezeAuthority();
    },
  ),
  before(
    CONFIRMATORY, "refuse malformed hostile bytes before a validation record can be built",
    CONFIRMATORY_MALFORMED,
    async () => validateConfirmatoryFreezeAuthorityRecord(CONFIRMATORY_MALFORMED_BYTES),
  ),
  forged(
    CONFIRMATORY, "refuse a form-valid foreign-scope record after strict decoding",
    CONFIRMATORY_FOREIGN,
    // The harness's integrity half re-runs the production check over the SAME forged bytes.
    // It proves the form reached semantic validation and the exact fail-closed decision holds;
    // no test helper reimplements the validator.
    async () => {
      const result = validateConfirmatoryFreezeAuthorityRecord(CONFIRMATORY_FOREIGN_BYTES);
      return {
        ok: !result.ok
          && result.authority === "NONE"
          && result.code === "CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE"
          && result.layer === "CONFIRMATORY_FREEZE_AUTHORITY",
      };
    },
    async () => validateConfirmatoryFreezeAuthorityRecord(CONFIRMATORY_FOREIGN_BYTES),
  ),
  racingExactly(
    CONFIRMATORY, "race revoked and expired authority records without admitting either",
    CONFIRMATORY_REVOKED, CONFIRMATORY_EXPIRED,
    async () => {
      await Promise.resolve();
      return validateConfirmatoryFreezeAuthorityRecord(CONFIRMATORY_REVOKED_BYTES);
    },
    async () => {
      await Promise.resolve();
      return validateConfirmatoryFreezeAuthorityRecord(CONFIRMATORY_EXPIRED_BYTES);
    },
  ),
];

// ---------------------------------------------------------------------------
// PRE_FREEZE_AUDIT_LAYER — the pinned-spec audit's closed refusal vocabulary.
// ---------------------------------------------------------------------------

const PRE_FREEZE = "PRE_FREEZE_AUDIT_LAYER";
const PRE_FREEZE_LAYER = soleLayer(PRE_FREEZE_AUDIT_LAYER, "PRE_FREEZE_AUDIT");

const preFreezeExpectation = (code: string): RefusalExpectation => ({
  code, layer: PRE_FREEZE_LAYER,
});

function solePreFreezeRefusal(
  verdict: ReturnType<typeof preFreezeAuditVerdict>,
): unknown {
  const refusal = verdict.refusals[0];
  if (refusal === undefined) throw new Error("pre-freeze hostile probe produced no refusal");
  return refusal;
}

const preFreezeAuditCases: readonly HostileCase[] = [
  before(
    PRE_FREEZE, "zero generated audit cases refuse before any source can be trusted",
    preFreezeExpectation("SWEEP_ZERO_CASES"),
    async () => solePreFreezeRefusal(preFreezeAuditVerdict(0, [])),
  ),
  after(
    PRE_FREEZE, "a positive case count cannot erase a detected ambiguous reference",
    preFreezeExpectation("REFERENCE_AMBIGUOUS"),
    async () => solePreFreezeRefusal(preFreezeAuditVerdict(1, [
      preFreezeAuditRefusal("REFERENCE_AMBIGUOUS", 407, "S3"),
    ])),
  ),
  racingExactly(
    PRE_FREEZE, "independent source and reference refusals race without collapsing",
    preFreezeExpectation("SPEC_BYTES_UNPINNED"),
    preFreezeExpectation("REFERENCE_UNRESOLVED"),
    async () => solePreFreezeRefusal(preFreezeAuditVerdict(1, [
      preFreezeAuditRefusal("SPEC_BYTES_UNPINNED", 0, ""),
    ])),
    async () => solePreFreezeRefusal(preFreezeAuditVerdict(1, [
      preFreezeAuditRefusal("REFERENCE_UNRESOLVED", 19, "G-absent"),
    ])),
  ),
];

// ---------------------------------------------------------------------------
// PRE-ROSTER — GA activation record. The parent row advertises it atomically.
// ---------------------------------------------------------------------------

const ACTIVATION_RECORD = "GA_ACTIVATION_RECORD_LAYER";
const ACTIVATION_RECORD_REFUSER = soleLayer(
  GA_ACTIVATION_RECORD_LAYER, "GA_ACTIVATION_RECORD",
);
const ACTIVATION_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ACTIVATION_CLAIM =
  "Moe v0.1.0 satisfies its stated correctness invariants (full CORE coverage manifest) "
  + "and its BENCH-S1–BENCH-S12 corpus oracles (as of 2026-09-01).";

function activationGate() {
  const minted = grantHumanAuthority(
    { gateId: GO_ACTIVATE_GATE_ID, grant: null, workRef: GA_ACTIVATION_WORK_REF },
    { kind: "HUMAN", principalId: "operator-yaron" },
    1_756_000_000_000,
  );
  if (!minted.ok) throw new Error(`activation control gate refused: ${minted.code}`);
  return minted.gate;
}

const ACTIVATION_CONTROL_INPUT: ActivationRecordInput = Object.freeze({
  binding: Object.freeze({
    authority: activationGate(),
    decision: GO_ACTIVATE_GATE_ID,
    generations: Object.freeze({
      backupGenerationDigest: "a".repeat(64),
      distributionManifestSha256: "b".repeat(64),
      importGenerationSha256: "c".repeat(64),
      quiesceRecordSha256: "d".repeat(64),
    }),
    sourceCommit: ACTIVATION_COMMIT,
  }),
  campaignVerdicts: Object.freeze({ "G-L1": "PASS" as const }),
  claimSentences: Object.freeze([ACTIVATION_CLAIM]),
  familyEvidence: Object.freeze([Object.freeze({
    countLine: "Tests 1 passed (1)", exitCode: 0, familyId: "property",
  })]),
  pinnedSpecSha256: PINNED_SPEC_SHA256,
  scopeNotEstablished: Object.freeze([]),
  sourceCommit: ACTIVATION_COMMIT,
});

function assertActivationControl(): void {
  const control = composeActivationRecord(ACTIVATION_CONTROL_INPUT);
  if (!control.ok) throw new Error(`activation positive control refused: ${control.code}`);
  const property = control.record.gateFamilies.find(({ familyId }) => familyId === "property");
  if (control.record.reachedRung !== "L1"
    || control.record.activation.status !== "BINDING_ADMITTED_ACT_PENDING"
    || property?.verdict !== "PASS") {
    throw new Error("activation positive control did not reach admitted L1 with property PASS");
  }
}

function activationHostile(patch: Partial<ActivationRecordInput>): unknown {
  assertActivationControl();
  return composeActivationRecord(Object.freeze({ ...ACTIVATION_CONTROL_INPUT, ...patch }));
}

const activationExpectation = (code: string): RefusalExpectation => ({
  code, layer: ACTIVATION_RECORD_REFUSER,
});
const hostilePinnedSpec = `${PINNED_SPEC_SHA256[0] === "0" ? "1" : "0"}${PINNED_SPEC_SHA256.slice(1)}`;

const activationRecordCases: readonly HostileCase[] = [
  before(
    ACTIVATION_RECORD, "a 39-hex top-level source commit cannot name the admitted record",
    activationExpectation("ACTIVATION_RECORD_SOURCE_COMMIT_INVALID"),
    async () => activationHostile({ sourceCommit: ACTIVATION_COMMIT.slice(0, 39) }),
  ),
  after(
    ACTIVATION_RECORD, "a one-nibble spec drift cannot inherit the pinned record authority",
    activationExpectation("ACTIVATION_RECORD_SPEC_MISMATCH"),
    async () => activationHostile({ pinnedSpecSha256: hostilePinnedSpec }),
  ),
  racingExactly(
    ACTIVATION_RECORD, "independent source and spec drift refuse regardless of settlement order",
    activationExpectation("ACTIVATION_RECORD_SOURCE_COMMIT_INVALID"),
    activationExpectation("ACTIVATION_RECORD_SPEC_MISMATCH"),
    () => deferredProbe(() => activationHostile({ sourceCommit: ACTIVATION_COMMIT.slice(0, 39) })),
    () => deferredProbe(() => activationHostile({ pinnedSpecSha256: hostilePinnedSpec })),
  ),
];

// ---------------------------------------------------------------------------
// PRE-ROSTER — live quiesce evidence through the daemon's four-source reader.
// ---------------------------------------------------------------------------

const LIVE_QUIESCE = "LIVE_QUIESCE_EVIDENCE_LAYER";
const CUTOVER_GENERATION_REFUSER = soleLayer(
  CUTOVER_GENERATION_SNAPSHOT_LAYER, "DAEMON_CUTOVER_GENERATION",
);
const CUTOVER_PROJECT_ID = "integrity-live-quiesce-project";
const QUIESCE_ITEM = Object.freeze({
  discoveredBy: "production-process-enumerator",
  id: "process:4242",
  kind: "PROCESS" as const,
  observedBefore: "pid 4242 was live",
});

const LIVE_QUIESCE_CONTROL: LiveQuiesceEvidence = Object.freeze({
  authority: Object.freeze({
    commentId: "comment-live-quiesce-authority",
    moment: "2026-09-01T12:00:00.000Z",
    principal: "operator/live",
  }),
  citationKey: "live-quiesce-security-control",
  citedBy: "task-38ec450ae92d486f860c5801c0f28870",
  hostFingerprint: "host-integrity-a",
  inventory: Object.freeze({
    hostFingerprint: "host-integrity-a",
    itemCount: 1,
    items: Object.freeze([QUIESCE_ITEM]),
    runMode: "LIVE" as const,
    undiscoverableKinds: Object.freeze([]),
  }),
  manifestComparison: Object.freeze({
    comparedEntryCount: 1,
    differences: Object.freeze([]),
    matched: true,
    ok: true as const,
  }),
  outcome: "COMPLETE" as const,
  resolvedCount: 1,
  results: Object.freeze([Object.freeze({
    item: QUIESCE_ITEM,
    observedAfter: Object.freeze({ detail: "pid 4242 is absent", live: false }),
    ok: true as const,
    pollsUsed: 1,
    stopCommand: "terminate pid 4242",
  })]),
  runMode: "LIVE" as const,
  stoppedAt: Object.freeze([Object.freeze({
    itemId: QUIESCE_ITEM.id, moment: "2026-09-01T12:00:01.000Z",
  })]),
});

function commitCutoverWitness(
  store: SqliteEventStore, eventId: string, eventType: string, witness: unknown,
): void {
  store.commit({
    aggregateId: CUTOVER_PROJECT_ID,
    commandBytes: new TextEncoder().encode(eventId),
    commandId: `cmd-${eventId}`,
    committedAt: "2026-09-01T12:00:00.000Z",
    events: [{
      eventId, eventType,
      payload: new TextEncoder().encode(JSON.stringify({ witness })),
    }],
    expectedVersion: store.getAggregateVersion(CUTOVER_PROJECT_ID),
  });
}

function readQuiesceSnapshot(
  evidence: LiveQuiesceEvidence, label: string,
): CutoverGenerationSnapshot {
  const root = hostileRoot(label);
  const store = SqliteEventStore.openForProject(join(root, "store.db"), CUTOVER_PROJECT_ID);
  openedStores.push(store);
  commitCutoverWitness(store, `${label}-activated`, "ProjectActivated", {
    distributionManifestHash: "e".repeat(64), truthClass: "DAEMON_VERIFIED",
  });
  commitCutoverWitness(store, `${label}-quiesced`, "ProjectQuiesced", {
    backupGenerationHash: "f".repeat(64), truthClass: "DAEMON_VERIFIED",
  });
  seedImport(store, IMPORT_DIGEST, [importRecordOf()]);
  const evidencePath = join(root, LIVE_QUIESCE_EVIDENCE_FILENAME);
  writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
  const ports: CutoverGenerationPorts = {
    config: { storeRoot: root },
    readFileText: (path) => readFileSync(path, "utf8"),
    store,
  };
  return readCutoverGenerationSnapshot(ports, { projectId: CUTOVER_PROJECT_ID });
}

function quiesceHostile(evidence: LiveQuiesceEvidence, label: string): CutoverGenerationSnapshot {
  const control = readQuiesceSnapshot(LIVE_QUIESCE_CONTROL, `${label}-control`);
  if (!control.ok) throw new Error(`live quiesce positive control refused: ${control.code}`);
  return readQuiesceSnapshot(evidence, label);
}

const cutoverExpectation: RefusalExpectation = Object.freeze({
  code: "CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT",
  layer: CUTOVER_GENERATION_REFUSER,
});
const countMismatchEvidence: LiveQuiesceEvidence = Object.freeze({
  ...LIVE_QUIESCE_CONTROL, resolvedCount: 0,
});
const stopMomentMissingEvidence: LiveQuiesceEvidence = Object.freeze({
  ...LIVE_QUIESCE_CONTROL, stoppedAt: Object.freeze([]),
});
const hostDivergenceEvidence: LiveQuiesceEvidence = Object.freeze({
  ...LIVE_QUIESCE_CONTROL,
  inventory: Object.freeze({
    ...LIVE_QUIESCE_CONTROL.inventory, hostFingerprint: "host-integrity-b",
  }),
});

const liveQuiesceCases: readonly HostileCase[] = [
  before(
    LIVE_QUIESCE, "a resolved-count drift cannot mint the quiesce generation",
    cutoverExpectation,
    async () => quiesceHostile(countMismatchEvidence, "quiesce-count"),
  ),
  after(
    LIVE_QUIESCE, "a successful stop without its stop moment cannot mint the generation",
    cutoverExpectation,
    async () => quiesceHostile(stopMomentMissingEvidence, "quiesce-stop-moment"),
  ),
  racingExactly(
    LIVE_QUIESCE, "count and host divergence refuse regardless of settlement order",
    cutoverExpectation,
    cutoverExpectation,
    () => deferredProbe(() => quiesceHostile(countMismatchEvidence, "quiesce-race-count")),
    () => deferredProbe(() => quiesceHostile(hostDivergenceEvidence, "quiesce-race-host")),
  ),
];

export const PRE_ROSTER_INTEGRITY_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...activationRecordCases,
  ...liveQuiesceCases,
]);

export const INTEGRITY_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...codecCases, ...acceptanceContractCases, ...planRevisionCases, ...contractCases,
  ...selectionCases, ...approvalCases, ...sessionCases,
  ...authorityCases, ...documentCases, ...distributionCases, ...reviewCases,
  ...keyProviderCases, ...completionCases, ...coreApprovalCases, ...reducerCases,
  ...graphContentCases, ...repositoryScopeCases,
  ...nodeAuthorityCases, ...nodeRecursionCases, ...confirmatoryFreezeAuthorityCases,
  ...preFreezeAuditCases,
]);
