import { RECOVERY_INCARNATION_SCHEMA_VERSION, digestOf } from "./recovery-incarnation-contract.js";
import type { RecoveryIncarnationRequest } from "./recovery-incarnation-contract.js";

/**
 * What a recovery incarnation is bound TO, and the one derivation both mints run.
 *
 * A restored store and a never-restored store need the same fencing identity but
 * possess different facts: a restore knows a command and a backup generation, a
 * fresh store knows neither and must never be handed a synthesized pair. The
 * origin is therefore an explicit TAG, and each branch carries only the fields
 * its own origin can actually prove.
 *
 * Both branches hash the ORIGIN TAG FIRST. A genesis store context digest is
 * shaped exactly like a backup generation digest, so a caller able to choose a
 * restore command could otherwise name the same two strings genesis derives and
 * land on genesis' references. Tagging both origins rather than only one keeps
 * that closed even if a later edit changes how many parts a branch contributes.
 */
export const RECOVERY_INCARNATION_ORIGINS = Object.freeze(["GENESIS", "RESTORE"] as const);
export type RecoveryIncarnationOrigin = (typeof RECOVERY_INCARNATION_ORIGINS)[number];

export interface RestoreIncarnationContext {
  readonly origin: "RESTORE";
  readonly restoreCommandId: string;
  readonly backupGenerationDigest: string;
}

export interface GenesisIncarnationContext {
  readonly origin: "GENESIS";
  readonly projectId: string;
  readonly storeContextDigest: string;
}

export type RecoveryIncarnationContext = GenesisIncarnationContext | RestoreIncarnationContext;

export interface RecoveryIncarnationDerivationInput {
  readonly context: RecoveryIncarnationContext;
  readonly incarnationDigest: string;
  readonly verificationKeyFingerprint: string;
  readonly publicKeySpkiHex: string;
}

export interface RecoveryIncarnationDerivation {
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly bindingDigest: string;
  readonly challengeDigest: string;
}

const MAX_COMMAND_ID_CHARS = 200;
const HEX64 = /^[0-9a-f]{64}$/;
/** Whitespace, control and format characters: an identifier nobody can retype. */
const UNSAFE_ID = /[\s\p{Cc}\p{Cf}]/u;
const REQUEST_KEYS = Object.freeze(["backupGenerationDigest", "restoreCommandId"]);
const GENESIS_CONTEXT_KEYS = Object.freeze(["projectId"]);

const isCommandId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_COMMAND_ID_CHARS &&
  !UNSAFE_ID.test(value) &&
  value.normalize("NFC") === value;

const isGenerationDigest = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

const isDataProperty = (descriptor: PropertyDescriptor | undefined): boolean =>
  descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;

/**
 * One synchronous read of own property DESCRIPTORS, before any await. Values
 * come from the descriptors rather than from a second property access, so an
 * accessor or a proxy cannot answer differently the second time — and a caller
 * mutating the object while a mint is in flight cannot move the binding.
 *
 * Extra keys are refused rather than ignored: a caller-supplied `nonce`,
 * `keyEpoch`, `counter`, `timestamp` — or a `storeContextDigest` the daemon is
 * supposed to derive — is exactly what these mints must never accept, and
 * silently dropping one would look like it had been honoured.
 */
const exactDataValues = (
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length) return null;
  if (keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!isDataProperty(descriptor)) return null;
    values[key] = descriptor?.value;
  }
  return values;
};

export const snapshotRequest = (value: unknown): RecoveryIncarnationRequest | null => {
  const fields = exactDataValues(value, REQUEST_KEYS);
  if (fields === null) return null;
  const restoreCommandId: unknown = fields["restoreCommandId"];
  const backupGenerationDigest: unknown = fields["backupGenerationDigest"];
  if (!isCommandId(restoreCommandId) || !isGenerationDigest(backupGenerationDigest)) return null;
  return Object.freeze({ backupGenerationDigest, restoreCommandId });
};

/** The restore branch keeps the request's exact two fields and adds only the tag. */
export const snapshotRestoreContext = (value: unknown): RestoreIncarnationContext | null => {
  const request = snapshotRequest(value);
  if (request === null) return null;
  return Object.freeze({
    backupGenerationDigest: request.backupGenerationDigest,
    origin: "RESTORE" as const,
    restoreCommandId: request.restoreCommandId,
  });
};

/**
 * Takes the asserted project identity and NOTHING else. The store context digest
 * is derived here rather than accepted, because a caller who could choose it
 * could steer a fresh store's fence onto a value it picked.
 */
export const snapshotGenesisContext = (value: unknown): GenesisIncarnationContext | null => {
  const fields = exactDataValues(value, GENESIS_CONTEXT_KEYS);
  if (fields === null) return null;
  const projectId: unknown = fields["projectId"];
  if (!isCommandId(projectId)) return null;
  return Object.freeze({
    origin: "GENESIS" as const,
    projectId,
    storeContextDigest: digestOf("genesis-store", projectId),
  });
};

/** Origin tag first, for BOTH branches. See the module comment for why. */
export const contextParts = (context: RecoveryIncarnationContext): readonly string[] =>
  context.origin === "RESTORE"
    ? [context.origin, context.restoreCommandId, context.backupGenerationDigest]
    : [context.origin, context.projectId, context.storeContextDigest];

/**
 * The single derivation both mints run. Sharing it is what makes the async
 * restore service and the synchronous genesis shell one implementation of
 * identity rather than two that agree today and drift tomorrow.
 *
 * The complete canonical SPKI hex is part of the binding digest, so a binding
 * cannot be re-pointed at a different public key without moving the digest the
 * proof signs.
 */
export const deriveIncarnation = (
  input: RecoveryIncarnationDerivationInput,
): RecoveryIncarnationDerivation => {
  const { context, incarnationDigest, publicKeySpkiHex, verificationKeyFingerprint } = input;
  const parts = contextParts(context);
  const incarnationRef = digestOf("incarnation", incarnationDigest, ...parts);
  const keyEpochRef = digestOf("key-epoch", verificationKeyFingerprint, ...parts);
  const bindingDigest = digestOf(
    "binding",
    RECOVERY_INCARNATION_SCHEMA_VERSION,
    ...parts,
    incarnationDigest,
    incarnationRef,
    keyEpochRef,
    verificationKeyFingerprint,
    publicKeySpkiHex,
  );
  return Object.freeze({
    bindingDigest,
    challengeDigest: digestOf("challenge", bindingDigest),
    incarnationRef,
    keyEpochRef,
  });
};
