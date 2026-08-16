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
import { join } from "node:path";

import {
  PROJECT_CONFIGURATION_SELECTION_LAYER, readCurrentProjectConfiguration,
  selectProjectConfiguration,
} from "../../apps/daemon/src/configuration/project-configuration-selection.js";
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
import { SqliteEventStore, verifyBackupGeneration } from "../../packages/store/src/index.js";

import { hostileRoot, probeRacing } from "./hostile-harness.js";
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

export const INTEGRITY_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...codecCases, ...contractCases, ...selectionCases, ...approvalCases, ...sessionCases,
  ...authorityCases, ...documentCases, ...distributionCases, ...reviewCases,
  ...keyProviderCases, ...completionCases, ...coreApprovalCases, ...reducerCases,
]);
