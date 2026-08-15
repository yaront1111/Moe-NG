/**
 * The one canonical, content-addressed project-configuration manifest codec.
 *
 * WHY CANONICALIZATION IS WRITTEN HERE rather than imported. @moe/contracts
 * owns canonicalization helpers of its own, but deliberately keeps them OFF its
 * package root, and this package may only compose the bare `@moe/contracts`
 * specifier — there is no tsconfig `paths` entry and no project reference, so a
 * deep relative import fails with TS6059. Re-deriving the rule here is the only
 * legal path, not an oversight.
 *
 * WHY node:crypto IS LEGAL HERE. @moe/contracts loads inside browser bundles and
 * must import no node builtin. @moe/core is Node-only and already hashes in
 * expansion-preparation.ts and supersession-engine.ts, so the digest belongs on
 * this side of the boundary.
 */
import { createHash } from "node:crypto";

import {
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  decodeBoundedJsonBytes,
  parseProjectConfigurationManifest,
  parseProjectConfigurationSettings,
} from "@moe/contracts";
import type {
  ProjectConfigurationManifest,
  ProjectConfigurationRefusal,
  ProjectConfigurationRefusalCode,
  ProjectConfigurationRefusalLayer,
  ProjectConfigurationSettings,
} from "@moe/contracts";

/** The closed codec vocabulary. Nothing outside this list is ever emitted. */
export const PROJECT_CONFIGURATION_CODEC_CODES = Object.freeze([
  "PROJECT_CONFIGURATION_BYTES_INVALID",
  "PROJECT_CONFIGURATION_DUPLICATE_KEY",
  "PROJECT_CONFIGURATION_NONCANONICAL",
  "PROJECT_CONFIGURATION_DIGEST_MISMATCH",
] as const);

/** Which stage refused. A contract refusal keeps ITS layer instead of one of these. */
export const PROJECT_CONFIGURATION_CODEC_LAYERS = Object.freeze([
  "PROJECT_CONFIGURATION_CODEC",
  "PROJECT_CONFIGURATION_CANONICALIZATION",
  "PROJECT_CONFIGURATION_DIGEST",
] as const);

/**
 * Domain separation tag. The digest preimage is this tag, a NUL byte no bounded
 * text can contain, then the canonical settings bytes — so a digest over these
 * bytes can never be confused with one taken over the same bytes elsewhere.
 */
export const PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN =
  "moe-project-configuration-settings/1";

export type ProjectConfigurationCodecCode = (typeof PROJECT_CONFIGURATION_CODEC_CODES)[number];
export type ProjectConfigurationCodecLayer = (typeof PROJECT_CONFIGURATION_CODEC_LAYERS)[number];

/**
 * `upstream` is the contract's own frozen refusal when @moe/contracts refused,
 * and null when this codec refused. A forwarded refusal keeps the contract's
 * code and layer VERBATIM: flattening them into a codec code would destroy the
 * evidence of which authority actually said no.
 */
export interface ProjectConfigurationCodecRefusal {
  readonly code: ProjectConfigurationCodecCode | ProjectConfigurationRefusalCode;
  readonly layer: ProjectConfigurationCodecLayer | ProjectConfigurationRefusalLayer;
  readonly ok: false;
  readonly upstream: ProjectConfigurationRefusal | null;
}

export type ProjectConfigurationManifestCreateResult =
  | { readonly manifest: ProjectConfigurationManifest; readonly ok: true }
  | ProjectConfigurationCodecRefusal;

export type ProjectConfigurationManifestEncodeResult =
  | { readonly bytes: Uint8Array; readonly ok: true }
  | ProjectConfigurationCodecRefusal;

export type ProjectConfigurationManifestDecodeResult =
  | { readonly manifest: ProjectConfigurationManifest; readonly ok: true }
  | ProjectConfigurationCodecRefusal;

function codecRefusal(
  code: ProjectConfigurationCodecCode,
  layer: ProjectConfigurationCodecLayer,
): ProjectConfigurationCodecRefusal {
  return Object.freeze({ code, layer, ok: false as const, upstream: null });
}

// Module-constant refusals: frozen singletons carrying nothing observed at the
// failure site, so a refusal can never leak the hostile input that produced it.
const BYTES_INVALID = codecRefusal(
  "PROJECT_CONFIGURATION_BYTES_INVALID", "PROJECT_CONFIGURATION_CODEC",
);
const DUPLICATE_KEY = codecRefusal(
  "PROJECT_CONFIGURATION_DUPLICATE_KEY", "PROJECT_CONFIGURATION_CODEC",
);
const NONCANONICAL = codecRefusal(
  "PROJECT_CONFIGURATION_NONCANONICAL", "PROJECT_CONFIGURATION_CANONICALIZATION",
);
const DIGEST_MISMATCH = codecRefusal(
  "PROJECT_CONFIGURATION_DIGEST_MISMATCH", "PROJECT_CONFIGURATION_DIGEST",
);

function forwarded(refusal: ProjectConfigurationRefusal): ProjectConfigurationCodecRefusal {
  return Object.freeze({
    code: refusal.code, layer: refusal.layer, ok: false as const, upstream: refusal,
  });
}

/** Every number the contract admits passed `isSafeCount`, so this is total. */
function canonicalNumber(value: number): string {
  return Number.isSafeInteger(value) ? String(value) : JSON.stringify(value);
}

/**
 * Recursive canonical JSON: no whitespace, object keys SORTED, arrays left in
 * DECLARED ORDER.
 *
 * Arrays must never be sorted. `settings.limits` is a fixed positional table
 * whose order is part of the contract — the parser refuses a reordered table
 * rather than repairing one — so sorting it here would silently make two
 * different tables hash alike and retire the ordering guarantee.
 *
 * The key sort is a DEFENSIVE invariant, not the sole guarantee, and this
 * comment is the honest version: every record reaching this function was
 * rebuilt by the contract parser from a fixed object literal whose keys are
 * already alphabetical at every level, so the sort currently changes no byte.
 * It is kept so the canonical form stays pinned to a stated rule rather than to
 * an incidental property of another package's source order.
 */
function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`);
  return `{${fields.join(",")}}`;
}

const DOMAIN_SEPARATOR = Uint8Array.of(0);
const ENCODER = new TextEncoder();
// Mirrors the bounded decoder's own options: a BOM is DATA, never stripped.
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Hashes the SETTINGS value alone. `settingsDigest` lives on the manifest and
 * is structurally absent from settings, so it is excluded from its own preimage
 * by shape rather than by a filter anyone has to remember to keep.
 */
function settingsDigestOf(settings: ProjectConfigurationSettings): string {
  return createHash("sha256")
    .update(PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN, "utf8")
    .update(DOMAIN_SEPARATOR)
    .update(ENCODER.encode(canonicalText(settings)))
    .digest("hex");
}

/**
 * Validates settings through the contract, then binds them to a project under a
 * freshly computed digest. A settings record the contract refuses is forwarded
 * with the contract's own code; nothing is coerced, defaulted or repaired.
 */
export function createProjectConfigurationManifest(
  projectId: unknown,
  settings: unknown,
): ProjectConfigurationManifestCreateResult {
  const parsedSettings = parseProjectConfigurationSettings(settings);
  if (!parsedSettings.ok) return forwarded(parsedSettings);
  const parsed = parseProjectConfigurationManifest({
    projectId,
    schemaVersion: PROJECT_CONFIGURATION_SCHEMA_VERSION,
    settings: parsedSettings.settings,
    settingsDigest: settingsDigestOf(parsedSettings.settings),
  });
  if (!parsed.ok) return forwarded(parsed);
  return Object.freeze({ manifest: parsed.manifest, ok: true as const });
}

/**
 * Emits the canonical bytes of the FULL manifest including `settingsDigest`.
 * The digest is re-derived and compared first, so a manifest carrying a stale
 * or forged digest can never be serialized into something that would decode.
 *
 * The returned Uint8Array is built fresh on every call — a typed array cannot
 * be frozen, so detachment is what makes the result safe to hand out.
 */
export function encodeProjectConfigurationManifest(
  manifest: unknown,
): ProjectConfigurationManifestEncodeResult {
  const parsed = parseProjectConfigurationManifest(manifest);
  if (!parsed.ok) return forwarded(parsed);
  if (settingsDigestOf(parsed.manifest.settings) !== parsed.manifest.settingsDigest) {
    return DIGEST_MISMATCH;
  }
  return Object.freeze({ bytes: ENCODER.encode(canonicalText(parsed.manifest)), ok: true as const });
}

/**
 * Decodes bounded JSON bytes into a manifest, refusing at the exact layer and
 * never throwing for any input.
 *
 * `decodeBoundedJsonBytes` is composed rather than `JSON.parse` for one
 * specific reason: `JSON.parse` silently keeps the LAST of a duplicated object
 * key, which destroys the provenance `PROJECT_CONFIGURATION_DUPLICATE_KEY`
 * exists to report and would make that code unreachable.
 */
export function decodeProjectConfigurationManifestBytes(
  bytes: unknown,
): ProjectConfigurationManifestDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) {
    return decoded.code === "JSON_DUPLICATE_KEY" ? DUPLICATE_KEY : BYTES_INVALID;
  }
  // Reached only once the decoder's internal-slot brand checks have proven the
  // input is a genuine, fixed, non-shared, non-detached Uint8Array. This is the
  // codec's ONE snapshot, and the constructor form is load-bearing rather than
  // stylistic. `bytes.slice()` would alias caller memory for a Buffer, whose
  // own `slice` returns a shared view; `Uint8Array.prototype.slice.call` fixes
  // that but consults `Symbol.species`, so a subclass could run its own code
  // here — throwing out of a function that must only ever refuse, or handing
  // back a longer buffer so the canonical comparison reads bytes other than the
  // ones decoded above. The constructor copies from internal slots and calls
  // nothing the caller controls.
  const source = new Uint8Array(bytes as Uint8Array);
  const parsed = parseProjectConfigurationManifest(decoded.value);
  if (!parsed.ok) return forwarded(parsed);
  if (canonicalText(parsed.manifest) !== DECODER.decode(source)) return NONCANONICAL;
  if (settingsDigestOf(parsed.manifest.settings) !== parsed.manifest.settingsDigest) {
    return DIGEST_MISMATCH;
  }
  return Object.freeze({ manifest: parsed.manifest, ok: true as const });
}
