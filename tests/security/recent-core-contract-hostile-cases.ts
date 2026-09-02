/**
 * Hostile arms for the six boundary constants the v2/foundation lineage exported
 * without rostering: five `packages/core` contract admissions (capability catalog,
 * delivery profile, execution isolation profile, verification recipe, source
 * snapshot) and the runner's git observer for a source snapshot. All six are
 * `integrity` by SUBJECT: codecs and a revision-binding check, no durable state,
 * no process of their own.
 *
 * The five core admissions are pure functions over an `unknown` value, so their
 * BEFORE, AFTER and RACE arms drive the same admission with hostile SHAPES rather
 * than with state: `null` (not a record), `{}` (a record with none of the fields)
 * and `[]` (an array where a record is due). Each is refused at the ADMISSION
 * layer with the contract's MALFORMED code, and the layer is read OUT of the
 * declared roster constant so a renamed layer reds here instead of following.
 *
 * The runner observer takes an injected port. Its BEFORE arm hands it a port
 * whose every method throws, so the refusal of a non-hex expected revision is
 * proven to answer before any process could exist; its AFTER arm lets the root
 * resolution itself fail, which is the first port call and the second refusal on
 * the observer's path; its RACE arm runs both concurrently.
 */
import {
  CAPABILITY_CATALOG_LAYERS,
} from "../../packages/core/src/capability-catalog/capability-catalog-contract.js";
import {
  admitCapabilityCatalogRevision,
} from "../../packages/core/src/capability-catalog/capability-catalog-admission.js";
import {
  DELIVERY_PROFILE_LAYERS,
} from "../../packages/core/src/delivery-profile/delivery-profile-contract.js";
import {
  admitDeliveryProfileRevision,
} from "../../packages/core/src/delivery-profile/delivery-profile-profile-admission.js";
import {
  EXECUTION_ISOLATION_PROFILE_LAYERS,
} from "../../packages/core/src/execution-profile/execution-isolation-profile-contract.js";
import {
  admitExecutionIsolationProfileRevision,
} from "../../packages/core/src/execution-profile/execution-isolation-profile-admission.js";
import {
  VERIFICATION_RECIPE_LAYERS,
} from "../../packages/core/src/execution-profile/verification-recipe-contract.js";
import {
  admitVerificationRecipeRevision,
} from "../../packages/core/src/execution-profile/verification-recipe-admission.js";
import {
  SOURCE_SNAPSHOT_LAYERS,
} from "../../packages/core/src/source-snapshot/source-snapshot-contract.js";
import {
  admitSourceSnapshot,
} from "../../packages/core/src/source-snapshot/source-snapshot-admission.js";
import {
  RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
} from "../../packages/runner/src/source-snapshot/source-snapshot-git-contract.js";
import {
  observeSourceSnapshotGitWithPort,
} from "../../packages/runner/src/source-snapshot/source-snapshot-git-node.js";
import type {
  SourceSnapshotGitNodePort,
} from "../../packages/runner/src/source-snapshot/source-snapshot-git-node.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";

const BOUND_MS = 2_000;

/**
 * Reads a layer OUT of the boundary's own declared constant, the same drill the
 * integrity slice applies: a typed literal would stay green through a rename.
 */
function layerOf(declared: readonly string[], wanted: string): string {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) {
    throw new Error(`${wanted} is not a member of the declared layer constant`);
  }
  return found;
}

interface PureAdmission {
  readonly constant: string;
  readonly declared: readonly string[];
  readonly admissionLayer: string;
  readonly malformedCode: string;
  readonly slug: string;
  admit(value: unknown): unknown;
}

/** BEFORE / AFTER / RACE over a pure admission, driven by hostile shapes. */
function pureAdmissionArms(subject: PureAdmission): readonly HostileCase[] {
  const expected: RefusalExpectation = {
    code: subject.malformedCode,
    layer: layerOf(subject.declared, subject.admissionLayer),
  };
  const notARecord = async (): Promise<unknown> => subject.admit(null);
  const emptyRecord = async (): Promise<unknown> => subject.admit({});
  const arrayForRecord = async (): Promise<unknown> => subject.admit([]);
  return Object.freeze([
    {
      arm: "BEFORE", constant: subject.constant, expect: expected,
      name: `${subject.slug}: a non-record is refused before any field is read`,
      run: async () => (await probeBefore(
        { label: `${subject.slug}-before`, timeoutMs: BOUND_MS }, notARecord, emptyRecord,
      )).probe,
    },
    {
      arm: "AFTER", constant: subject.constant, expect: expected,
      name: `${subject.slug}: an array where a record is due is refused after a prior admission`,
      run: async () => (await probeAfter(
        { label: `${subject.slug}-after`, timeoutMs: BOUND_MS }, emptyRecord, arrayForRecord,
      )).probe,
    },
    {
      arm: "RACE", constant: subject.constant,
      name: `${subject.slug}: a non-record races an array and neither is admitted`,
      expectLeft: expected, expectRight: expected,
      run: async () => probeRacing(
        { label: `${subject.slug}-race`, timeoutMs: BOUND_MS }, notARecord, arrayForRecord,
      ),
    },
  ]);
}

const CORE_ADMISSIONS: readonly PureAdmission[] = Object.freeze([
  {
    admissionLayer: "CAPABILITY_CATALOG_ADMISSION", admit: admitCapabilityCatalogRevision,
    constant: "CAPABILITY_CATALOG_LAYERS", declared: CAPABILITY_CATALOG_LAYERS,
    malformedCode: "CAPABILITY_CATALOG_MALFORMED", slug: "capability-catalog",
  },
  {
    admissionLayer: "DELIVERY_PROFILE_ADMISSION", admit: admitDeliveryProfileRevision,
    constant: "DELIVERY_PROFILE_LAYERS", declared: DELIVERY_PROFILE_LAYERS,
    malformedCode: "DELIVERY_PROFILE_MALFORMED", slug: "delivery-profile",
  },
  {
    admissionLayer: "EXECUTION_ISOLATION_PROFILE_ADMISSION",
    admit: admitExecutionIsolationProfileRevision,
    constant: "EXECUTION_ISOLATION_PROFILE_LAYERS", declared: EXECUTION_ISOLATION_PROFILE_LAYERS,
    malformedCode: "EXECUTION_ISOLATION_PROFILE_MALFORMED", slug: "execution-isolation-profile",
  },
  {
    admissionLayer: "VERIFICATION_RECIPE_ADMISSION", admit: admitVerificationRecipeRevision,
    constant: "VERIFICATION_RECIPE_LAYERS", declared: VERIFICATION_RECIPE_LAYERS,
    malformedCode: "VERIFICATION_RECIPE_MALFORMED", slug: "verification-recipe",
  },
  {
    admissionLayer: "SOURCE_SNAPSHOT_ADMISSION", admit: admitSourceSnapshot,
    constant: "SOURCE_SNAPSHOT_LAYERS", declared: SOURCE_SNAPSHOT_LAYERS,
    malformedCode: "SOURCE_SNAPSHOT_MALFORMED", slug: "source-snapshot",
  },
]);

// ── The runner's git observer ─────────────────────────────────────────────────────────────

const GIT_LAYER = layerOf([RUNNER_SOURCE_SNAPSHOT_GIT_LAYER], "RUNNER_SOURCE_SNAPSHOT_GIT");
const REVISION_INVALID: RefusalExpectation = {
  code: "RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID", layer: GIT_LAYER,
};
const ROOT_UNRESOLVABLE: RefusalExpectation = {
  code: "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE", layer: GIT_LAYER,
};
/** A repository root no process may ever be spawned in: no such directory anywhere. */
const HOSTILE_ROOT = "/moe-security-lane/no-such-repository";
const HEX_64 = "a".repeat(64);

/** Every method throws: the refusal under test must answer before touching the port. */
function inertPort(): SourceSnapshotGitNodePort {
  return Object.freeze({
    realpath: () => { throw new Error("the observer touched the port before refusing"); },
    run: () => { throw new Error("the observer spawned before refusing"); },
  });
}

/** Root resolution fails; the process port must still never run. */
function unresolvableRootPort(): SourceSnapshotGitNodePort {
  return Object.freeze({
    realpath: () => { throw new Error("ENOENT"); },
    run: () => { throw new Error("the observer spawned after its root failed to resolve"); },
  });
}

const revisionNotHex = async (): Promise<unknown> =>
  observeSourceSnapshotGitWithPort(HOSTILE_ROOT, "not-a-revision", inertPort());
const rootUnresolvable = async (): Promise<unknown> =>
  observeSourceSnapshotGitWithPort(HOSTILE_ROOT, HEX_64, unresolvableRootPort());

const runnerGitArms: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE", constant: "RUNNER_SOURCE_SNAPSHOT_GIT_LAYER", expect: REVISION_INVALID,
    name: "runner-git: a non-hex expected revision is refused before any port call",
    run: async () => (await probeBefore(
      { label: "runner-git-before", timeoutMs: BOUND_MS }, revisionNotHex, rootUnresolvable,
    )).probe,
  },
  {
    arm: "AFTER", constant: "RUNNER_SOURCE_SNAPSHOT_GIT_LAYER", expect: ROOT_UNRESOLVABLE,
    name: "runner-git: an unresolvable root is refused after the revision was admitted",
    run: async () => (await probeAfter(
      { label: "runner-git-after", timeoutMs: BOUND_MS }, revisionNotHex, rootUnresolvable,
    )).probe,
  },
  {
    arm: "RACE", constant: "RUNNER_SOURCE_SNAPSHOT_GIT_LAYER",
    name: "runner-git: a non-hex revision races an unresolvable root; nothing is observed",
    expectLeft: REVISION_INVALID, expectRight: ROOT_UNRESOLVABLE,
    run: async () => probeRacing(
      { label: "runner-git-race", timeoutMs: BOUND_MS }, revisionNotHex, rootUnresolvable,
    ),
  },
]);

export const RECENT_CORE_CONTRACT_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  ...CORE_ADMISSIONS.flatMap(pureAdmissionArms),
  ...runnerGitArms,
]);
