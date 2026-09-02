import {
  deepFreeze, exact, snapshotDataBounded, validHex64,
} from "../planning/planning-snapshot.js";
import {
  readExecutionIsolationCredentialBroker,
  readExecutionIsolationImage,
  readExecutionIsolationRef,
  readExecutionIsolationTools,
} from "./execution-isolation-profile-binding-admission.js";
import {
  EXECUTION_ISOLATION_PROFILE_LIMITS,
  EXECUTION_ISOLATION_PROFILE_PLANES,
  EXECUTION_ISOLATION_PROFILE_PURPOSES,
  EXECUTION_ISOLATION_PROFILE_VERSION,
  executionIsolationProfileRefusal,
  type ExecutionIsolationCredentialBrokerRef,
  type ExecutionIsolationPlane,
  type ExecutionIsolationProfileRefusal,
  type ExecutionIsolationProfileRevision,
  type ExecutionIsolationProfileRevisionDraft,
  type ExecutionIsolationPurpose,
} from "./execution-isolation-profile-contract.js";
import {
  readExecutionIsolationForbiddenHostInputs,
  readExecutionIsolationLimits,
  readExecutionIsolationMounts,
  readExecutionIsolationNetwork,
} from "./execution-isolation-profile-policy-admission.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | ExecutionIsolationProfileRefusal;
type ParsedRevision = Readonly<{
  body: ExecutionIsolationProfileRevisionDraft;
  revisionDigest?: string;
}>;
export type ExecutionIsolationProfileDraftAdmission =
  | Readonly<{ draft: ExecutionIsolationProfileRevisionDraft; ok: true }>
  | ExecutionIsolationProfileRefusal;
export type ExecutionIsolationProfileAdmission =
  | Readonly<{ ok: true; revision: ExecutionIsolationProfileRevision }>
  | ExecutionIsolationProfileRefusal;

const DRAFT_KEYS = Object.freeze([
  "commandMode", "credentialBroker", "deliveryProfileRevisionDigest", "executionPlane",
  "forbiddenHostInputs", "image", "limits", "mounts", "network", "profileId", "purpose",
  "revisionId", "sourceSnapshotDigest", "tools",
]);
const FULL_KEYS = Object.freeze([...DRAFT_KEYS, "revisionDigest", "version"]);
const refusal = (
  code: Parameters<typeof executionIsolationProfileRefusal>[0],
  layer: Parameters<typeof executionIsolationProfileRefusal>[1],
): ExecutionIsolationProfileRefusal => executionIsolationProfileRefusal(code, layer);
const malformed = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_MALFORMED", "EXECUTION_ISOLATION_PROFILE_ADMISSION",
);
const exceeded = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED", "EXECUTION_ISOLATION_PROFILE_LIMITS",
);
const bindingInvalid = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_BINDING_INVALID", "EXECUTION_ISOLATION_PROFILE_BINDING",
);
const credentialInvalid = (): ExecutionIsolationProfileRefusal => refusal(
  "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER_INVALID",
  "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER",
);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function isPurpose(value: unknown): value is ExecutionIsolationPurpose {
  return EXECUTION_ISOLATION_PROFILE_PURPOSES.some((candidate) => candidate === value);
}

function isExecutionPlane(value: unknown): value is ExecutionIsolationPlane {
  return EXECUTION_ISOLATION_PROFILE_PLANES.some((candidate) => candidate === value);
}

function readCredentialBroker(
  value: unknown,
  purpose: ExecutionIsolationPurpose,
): ReadResult<ExecutionIsolationCredentialBrokerRef | null> {
  if (purpose === "FRESH_VERIFIER") return value === null ? success(null) : credentialInvalid();
  if (value === null) return credentialInvalid();
  return readExecutionIsolationCredentialBroker(value);
}

function parseRevision(value: unknown, full: boolean): ReadResult<ParsedRevision> {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: EXECUTION_ISOLATION_PROFILE_LIMITS.maxArrayLength,
    maxDepth: EXECUTION_ISOLATION_PROFILE_LIMITS.maxSnapshotDepth,
    maxNodes: EXECUTION_ISOLATION_PROFILE_LIMITS.maxNodes,
  });
  if (!snapshot.ok) return snapshot.limitExceeded ? exceeded() : malformed();
  if (!exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== EXECUTION_ISOLATION_PROFILE_VERSION) return refusal(
    "EXECUTION_ISOLATION_PROFILE_VERSION_UNSUPPORTED", "EXECUTION_ISOLATION_PROFILE_VERSION",
  );
  const executionPlane = record["executionPlane"];
  if (!isExecutionPlane(executionPlane)) return refusal(
    "EXECUTION_ISOLATION_PROFILE_PLANE_FORBIDDEN", "EXECUTION_ISOLATION_PROFILE_PLANE",
  );
  const purpose = record["purpose"];
  if (!isPurpose(purpose)) return refusal(
    "EXECUTION_ISOLATION_PROFILE_PURPOSE_INVALID", "EXECUTION_ISOLATION_PROFILE_PURPOSE",
  );
  if (record["commandMode"] !== "DIRECT_ARGV") return refusal(
    "EXECUTION_ISOLATION_PROFILE_COMMAND_MODE_FORBIDDEN", "EXECUTION_ISOLATION_PROFILE_COMMAND",
  );
  const profileId = readExecutionIsolationRef(record["profileId"]);
  const revisionId = readExecutionIsolationRef(record["revisionId"]);
  const credentialBroker = readCredentialBroker(record["credentialBroker"], purpose);
  const image = readExecutionIsolationImage(record["image"]);
  const limits = readExecutionIsolationLimits(record["limits"]);
  const mounts = readExecutionIsolationMounts(record["mounts"], purpose);
  const forbiddenHostInputs = readExecutionIsolationForbiddenHostInputs(
    record["forbiddenHostInputs"],
  );
  const network = readExecutionIsolationNetwork(record["network"], purpose);
  const tools = readExecutionIsolationTools(record["tools"]);
  if (!profileId.ok) return profileId; if (!revisionId.ok) return revisionId;
  if (!credentialBroker.ok) return credentialBroker; if (!image.ok) return image;
  if (!limits.ok) return limits; if (!mounts.ok) return mounts;
  if (!forbiddenHostInputs.ok) return forbiddenHostInputs; if (!network.ok) return network;
  if (!tools.ok) return tools;
  if (!validHex64(record["deliveryProfileRevisionDigest"])
    || !validHex64(record["sourceSnapshotDigest"])) return bindingInvalid();
  const body: ExecutionIsolationProfileRevisionDraft = Object.freeze({
    commandMode: "DIRECT_ARGV", credentialBroker: credentialBroker.value,
    deliveryProfileRevisionDigest: record["deliveryProfileRevisionDigest"], executionPlane,
    forbiddenHostInputs: forbiddenHostInputs.value, image: image.value, limits: limits.value,
    mounts: mounts.value, network: network.value, profileId: profileId.value, purpose,
    revisionId: revisionId.value, sourceSnapshotDigest: record["sourceSnapshotDigest"],
    tools: tools.value,
  } as ExecutionIsolationProfileRevisionDraft);
  if (!full) return success(Object.freeze({ body }));
  return validHex64(record["revisionDigest"])
    ? success(Object.freeze({ body, revisionDigest: record["revisionDigest"] }))
    : bindingInvalid();
}

export function admitExecutionIsolationProfileRevisionDraft(
  value: unknown,
): ExecutionIsolationProfileDraftAdmission {
  const parsed = parseRevision(value, false); if (!parsed.ok) return parsed;
  return Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const });
}

export function admitExecutionIsolationProfileRevision(
  value: unknown,
): ExecutionIsolationProfileAdmission {
  const parsed = parseRevision(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({
    ok: true as const,
    revision: deepFreeze({
      ...parsed.value.body,
      revisionDigest: parsed.value.revisionDigest!,
      version: EXECUTION_ISOLATION_PROFILE_VERSION,
    }),
  });
}
