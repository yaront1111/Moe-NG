import {
  deepFreeze, exact, snapshotDataBounded, validHex64,
} from "../planning/planning-snapshot.js";
import {
  VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS,
  VERIFICATION_RECIPE_LIMITS,
  VERIFICATION_RECIPE_OUTPUT_MOUNTS,
  VERIFICATION_RECIPE_VERSION,
  verificationRecipeRefusal,
  type VerificationRecipeExpectedOutput,
  type VerificationRecipeExpectedRefusal,
  type VerificationRecipeImageRef,
  type VerificationRecipeRefusal,
  type VerificationRecipeRevision,
  type VerificationRecipeRevisionDraft,
  type VerificationRecipeToolRef,
} from "./verification-recipe-contract.js";
import {
  readVerificationEnvironmentAllowlist,
  readVerificationEvidenceParser,
  readVerificationNetworkPolicy,
  readVerificationResourceCaps,
  readVerificationWorkingDirectory,
} from "./verification-recipe-execution-admission.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | VerificationRecipeRefusal;
type ParsedRevision = Readonly<{ body: VerificationRecipeRevisionDraft; revisionDigest?: string }>;
export type VerificationRecipeDraftAdmission =
  | Readonly<{ draft: VerificationRecipeRevisionDraft; ok: true }>
  | VerificationRecipeRefusal;
export type VerificationRecipeAdmission =
  | Readonly<{ ok: true; revision: VerificationRecipeRevision }>
  | VerificationRecipeRefusal;

const encoder = new TextEncoder();
const DRAFT_KEYS = Object.freeze([
  "argv", "environmentNameAllowlist", "evidenceParser", "executionProfileRevisionDigest",
  "expectedExitCode", "expectedOutputs", "expectedRefusal", "image", "networkPolicy",
  "recipeId", "resourceCaps", "revisionId", "sourceSnapshotDigest", "tool",
  "workingDirectory",
]);
const FULL_KEYS = Object.freeze([...DRAFT_KEYS, "revisionDigest", "version"]);
const IMAGE_KEYS = Object.freeze(["imageDigest", "imageRef"]);
const TOOL_KEYS = Object.freeze(["toolDigest", "toolRef"]);
const OUTPUT_KEYS = Object.freeze(["mount", "relativePath", "sha256"]);
const REFUSAL_KEYS = Object.freeze(["code", "layer"]);
const IMAGE_REF = /^image:[a-z0-9][a-z0-9._-]{0,255}$/u;
const TOOL_REF = /^tool:[a-z0-9][a-z0-9._-]{0,255}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REFUSAL_TOKEN = /^[A-Z][A-Z0-9_]{0,255}$/u;
const RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

const refusal = (
  code: Parameters<typeof verificationRecipeRefusal>[0],
  layer: Parameters<typeof verificationRecipeRefusal>[1],
): VerificationRecipeRefusal => verificationRecipeRefusal(code, layer);
const malformed = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_MALFORMED", "VERIFICATION_RECIPE_ADMISSION",
);
const exceeded = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_LIMIT_EXCEEDED", "VERIFICATION_RECIPE_LIMITS",
);
const bindingInvalid = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_BINDING_INVALID", "VERIFICATION_RECIPE_BINDING",
);
const outputInvalid = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_OUTPUT_INVALID", "VERIFICATION_RECIPE_OUTPUT",
);
const outcomeInvalid = (): VerificationRecipeRefusal => refusal(
  "VERIFICATION_RECIPE_OUTCOME_INVALID", "VERIFICATION_RECIPE_OUTCOME",
);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function readRef(value: unknown): ReadResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || CONTROL.test(value) || !value.isWellFormed() || value.normalize("NFC") !== value) {
    return malformed();
  }
  return encoder.encode(value).byteLength <= VERIFICATION_RECIPE_LIMITS.maxRefBytes
    ? success(value) : exceeded();
}

function readArgv(value: unknown): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > VERIFICATION_RECIPE_LIMITS.maxArgs) return exceeded();
  const argv: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || CONTROL.test(candidate) || !candidate.isWellFormed()
      || candidate.normalize("NFC") !== candidate) return malformed();
    if (encoder.encode(candidate).byteLength > VERIFICATION_RECIPE_LIMITS.maxArgBytes) {
      return exceeded();
    }
    argv.push(candidate);
  }
  return success(Object.freeze(argv));
}

function readImage(value: unknown): ReadResult<VerificationRecipeImageRef> {
  if (!exact(value, IMAGE_KEYS) || typeof value["imageRef"] !== "string"
    || !IMAGE_REF.test(value["imageRef"]) || typeof value["imageDigest"] !== "string"
    || !OCI_DIGEST.test(value["imageDigest"])) return bindingInvalid();
  return success(Object.freeze({
    imageDigest: value["imageDigest"], imageRef: value["imageRef"],
  }));
}

function readTool(value: unknown): ReadResult<VerificationRecipeToolRef> {
  if (!exact(value, TOOL_KEYS) || typeof value["toolRef"] !== "string") {
    return bindingInvalid();
  }
  const normalizedRef = value["toolRef"].toLowerCase();
  const unqualified = normalizedRef.startsWith("tool:") ? normalizedRef.slice(5) : normalizedRef;
  const toolName = unqualified.split(/[\\/]/u).at(-1) ?? unqualified;
  if (VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS.some((shell) => shell === toolName)) {
    return refusal("VERIFICATION_RECIPE_SHELL_FORBIDDEN", "VERIFICATION_RECIPE_COMMAND");
  }
  if (!TOOL_REF.test(value["toolRef"]) || !validHex64(value["toolDigest"])) {
    return bindingInvalid();
  }
  return success(Object.freeze({ toolDigest: value["toolDigest"], toolRef: value["toolRef"] }));
}

function readOutputPath(value: unknown): ReadResult<string> {
  if (typeof value !== "string" || !value.isWellFormed()
    || value.normalize("NFC") !== value) return outputInvalid();
  if (encoder.encode(value).byteLength > VERIFICATION_RECIPE_LIMITS.maxOutputPathBytes) {
    return exceeded();
  }
  const parts = value.split("/");
  if (!RELATIVE_PATH.test(value) || value.startsWith("/") || value.includes("\\")
    || value.includes(":") || parts.some((part) => part === "" || part === "." || part === "..")) {
    return outputInvalid();
  }
  return success(value);
}

function readOutputs(value: unknown): ReadResult<readonly VerificationRecipeExpectedOutput[]> {
  if (!Array.isArray(value)) return outputInvalid();
  if (value.length > VERIFICATION_RECIPE_LIMITS.maxOutputs) return exceeded();
  const outputs: VerificationRecipeExpectedOutput[] = [];
  for (const candidate of value) {
    if (!exact(candidate, OUTPUT_KEYS)
      || !VERIFICATION_RECIPE_OUTPUT_MOUNTS.some((mount) => mount === candidate["mount"])
      || !validHex64(candidate["sha256"])) return outputInvalid();
    const relativePath = readOutputPath(candidate["relativePath"]); if (!relativePath.ok) return relativePath;
    const key = `${String(candidate["mount"])}\0${relativePath.value}`;
    const previous = outputs.at(-1);
    if (previous !== undefined
      && `${previous.mount}\0${previous.relativePath}` >= key) return outputInvalid();
    outputs.push(Object.freeze({
      mount: candidate["mount"] as "OUTPUT" | "EVIDENCE",
      relativePath: relativePath.value,
      sha256: candidate["sha256"],
    }));
  }
  return success(Object.freeze(outputs));
}

function readExpectedRefusal(value: unknown): ReadResult<VerificationRecipeExpectedRefusal | null> {
  if (value === null) return success(null);
  if (!exact(value, REFUSAL_KEYS)) return outcomeInvalid();
  const code = value["code"]; const layer = value["layer"];
  if (typeof code !== "string" || typeof layer !== "string") return outcomeInvalid();
  if (encoder.encode(code).byteLength > VERIFICATION_RECIPE_LIMITS.maxRefBytes
    || encoder.encode(layer).byteLength > VERIFICATION_RECIPE_LIMITS.maxRefBytes) return exceeded();
  if (!REFUSAL_TOKEN.test(code) || !REFUSAL_TOKEN.test(layer)) return outcomeInvalid();
  return success(Object.freeze({ code, layer }));
}

function parseRevision(value: unknown, full: boolean): ReadResult<ParsedRevision> {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: VERIFICATION_RECIPE_LIMITS.maxArrayLength,
    maxDepth: VERIFICATION_RECIPE_LIMITS.maxSnapshotDepth,
    maxNodes: VERIFICATION_RECIPE_LIMITS.maxNodes,
  });
  if (!snapshot.ok) return snapshot.limitExceeded ? exceeded() : malformed();
  if (!exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== VERIFICATION_RECIPE_VERSION) return refusal(
    "VERIFICATION_RECIPE_VERSION_UNSUPPORTED", "VERIFICATION_RECIPE_VERSION",
  );
  const recipeId = readRef(record["recipeId"]); const revisionId = readRef(record["revisionId"]);
  const argv = readArgv(record["argv"]); const image = readImage(record["image"]);
  const tool = readTool(record["tool"]); const outputs = readOutputs(record["expectedOutputs"]);
  const expectedRefusal = readExpectedRefusal(record["expectedRefusal"]);
  const environment = readVerificationEnvironmentAllowlist(record["environmentNameAllowlist"]);
  const evidenceParser = readVerificationEvidenceParser(record["evidenceParser"]);
  const networkPolicy = readVerificationNetworkPolicy(record["networkPolicy"]);
  const resourceCaps = readVerificationResourceCaps(record["resourceCaps"]);
  const workingDirectory = readVerificationWorkingDirectory(record["workingDirectory"]);
  if (!recipeId.ok) return recipeId; if (!revisionId.ok) return revisionId;
  if (!argv.ok) return argv; if (!image.ok) return image; if (!tool.ok) return tool;
  if (!outputs.ok) return outputs; if (!expectedRefusal.ok) return expectedRefusal;
  if (!environment.ok) return environment; if (!evidenceParser.ok) return evidenceParser;
  if (!networkPolicy.ok) return networkPolicy; if (!resourceCaps.ok) return resourceCaps;
  if (!workingDirectory.ok) return workingDirectory;
  if (!validHex64(record["executionProfileRevisionDigest"])
    || !validHex64(record["sourceSnapshotDigest"])) return bindingInvalid();
  const exitCode = record["expectedExitCode"];
  if (exitCode !== null && (!Number.isSafeInteger(exitCode)
    || (exitCode as number) < 0 || (exitCode as number) > 255)) return outcomeInvalid();
  const successOutcome = exitCode !== null && expectedRefusal.value === null
    && outputs.value.length > 0;
  const refusalOutcome = exitCode === null && expectedRefusal.value !== null
    && outputs.value.length === 0;
  if (!successOutcome && !refusalOutcome) return outcomeInvalid();
  const body: VerificationRecipeRevisionDraft = Object.freeze({
    argv: argv.value,
    environmentNameAllowlist: environment.value,
    evidenceParser: evidenceParser.value,
    executionProfileRevisionDigest: record["executionProfileRevisionDigest"],
    expectedExitCode: exitCode as number | null,
    expectedOutputs: outputs.value,
    expectedRefusal: expectedRefusal.value,
    image: image.value,
    networkPolicy: networkPolicy.value,
    recipeId: recipeId.value,
    resourceCaps: resourceCaps.value,
    revisionId: revisionId.value,
    sourceSnapshotDigest: record["sourceSnapshotDigest"],
    tool: tool.value,
    workingDirectory: workingDirectory.value,
  });
  if (!full) return success(Object.freeze({ body }));
  return validHex64(record["revisionDigest"])
    ? success(Object.freeze({ body, revisionDigest: record["revisionDigest"] }))
    : bindingInvalid();
}

export function admitVerificationRecipeRevisionDraft(
  value: unknown,
): VerificationRecipeDraftAdmission {
  const parsed = parseRevision(value, false); if (!parsed.ok) return parsed;
  return Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const });
}

export function admitVerificationRecipeRevision(value: unknown): VerificationRecipeAdmission {
  const parsed = parseRevision(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({
    ok: true as const,
    revision: deepFreeze({
      ...parsed.value.body,
      revisionDigest: parsed.value.revisionDigest!,
      version: VERIFICATION_RECIPE_VERSION,
    }),
  });
}
