import { readFileSync } from "node:fs";

import type { BootstrapRefusedBy } from "../../bootstrap/bootstrap-contracts.js";
import { controlledProfilePackageFiles } from "./controlled-profile-package-templates.js";
import { controlledProfileRootFiles } from "./controlled-profile-root-templates.js";

/**
 * The controlled profile: ONE product shape, pinned by a version constant, emitted byte-for-byte
 * identically for the same inputs.
 *
 * Determinism is the contract, not a nicety. Everything the loop claims downstream — the verifier
 * recipe, the deployment requirements, the migration tool — is written against what a product
 * STARTED as. If two bootstraps of `controlled-2` could differ, none of those claims hold across
 * products, so the generator reads no clock, no random source, no cwd, no host tool version and no
 * `os.EOL`: its only input is this request, and its only file read is the pinned lockfile asset.
 *
 * A change to the emitted tree is a VERSION BUMP, never an edit in place (task rail 4), because a
 * later row needs to know which shape a given product came from.
 *
 * This module is INTERNAL to `@moe/daemon`. It is deliberately absent from `src/index.ts`: the
 * published surface there is guarded by `index-surface.test.ts`, and the command edge that raises
 * these refusals imports the generator by relative path inside the package.
 */

/** The single source DoD 4 names. Everything else in the profile is an artifact of this string. */
export const CONTROLLED_PROFILE_VERSION = "controlled-2" as const;

/** Raised when a caller asks for a profile version this build does not know how to emit. */
export const BOOTSTRAP_PROFILE_VERSION_UNKNOWN = "BOOTSTRAP_PROFILE_VERSION_UNKNOWN" as const;

/**
 * Raised when the product name is not safe to interpolate. The name reaches JSON string bodies and
 * Markdown, and a caller-supplied `"` or `..` would emit a tree that does not parse or that escapes
 * its own directory — a correctness hole, not a policy preference.
 */
export const BOOTSTRAP_PRODUCT_NAME_INVALID = "BOOTSTRAP_PRODUCT_NAME_INVALID" as const;

/**
 * Missing workspace `db:migrate` script. Defined here for the verifier and deployment migration
 * consumers (children 2 and 3); THEY detect and raise it, not this deterministic emitter.
 * Its refusal uses the existing DAEMON_INGRESS layer via ControlledProfileRefusal/BootstrapRefusedBy.
 */
export const MIGRATION_TOOL_MISSING = "MIGRATION_TOOL_MISSING" as const;

/**
 * Lowercase, digit- or letter-initial, hyphen-joined, at most 64 characters: the intersection of a
 * legal npm package name, a legal directory name on every host, and a string that needs no JSON
 * escaping. No `/g` flag, so `.test()` holds no cursor between calls.
 */
export const CONTROLLED_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ControlledProfileRefusalCode =
  | typeof BOOTSTRAP_PROFILE_VERSION_UNKNOWN
  | typeof BOOTSTRAP_PRODUCT_NAME_INVALID
  | typeof MIGRATION_TOOL_MISSING;

export interface ControlledProfileRequest {
  readonly productName: string;
  readonly profileVersion: string;
  /**
   * Environment-variable NAMES the approved contract's deployment requirements require, from
   * `requiredVariableNames` in `environment/environment-required-variables.ts`. Names only — the
   * emitter writes each as `NAME=` with nothing after the `=`, because `.env.example` is
   * committed and pushed.
   *
   * OPTIONAL, and absent is not the same as unsupported: omitted or empty emits `.env.example`
   * byte-identically to a build from before this field existed, so the profile version still
   * means one shape for every product that does not use it. Optional also keeps existing callers
   * valid, including `bootstrapRepository`, which passes its whole `BootstrapRequest` here.
   */
  readonly requiredVariableNames?: readonly string[];
}

/** Paths are forward-slash relative, sorted by UTF-16 code unit; values are the file's full bytes. */
export interface ControlledProfileTree {
  readonly ok: true;
  readonly files: ReadonlyMap<string, string>;
}

/**
 * `refusedBy` reuses the EXISTING `BootstrapRefusedBy` literal rather than minting a new layer
 * constant: the daemon command edge that raises these codes IS the ingress layer, and the security
 * lane carries a boundary roster over layer constants that a new one would silently desynchronize.
 */
export interface ControlledProfileRefusal {
  readonly ok: false;
  readonly code: ControlledProfileRefusalCode;
  readonly refusedBy: BootstrapRefusedBy;
}

export type ControlledProfileResult = ControlledProfileTree | ControlledProfileRefusal;

/** Only the current version is accepted; a profile bump retires its predecessor's requests. */
export function isKnownProfileVersion(value: string): value is typeof CONTROLLED_PROFILE_VERSION {
  return value === CONTROLLED_PROFILE_VERSION;
}

export function isValidProductName(value: string): boolean {
  return CONTROLLED_PROFILE_NAME_PATTERN.test(value);
}

export function refuseControlledProfile(code: ControlledProfileRefusalCode): ControlledProfileRefusal {
  return { ok: false, code, refusedBy: "DAEMON_INGRESS" };
}

/**
 * The lockfile is the one emitted file too large to live as a line array (a React + Vite + vitest +
 * Playwright lockfile runs to thousands of lines), so it ships as an on-disk asset.
 *
 * ONE STATIC ASSET CAN SERVE EVERY PRODUCT because pnpm keys `importers` by DIRECTORY, not by
 * package name: the product name never appears in it. Step 5 measured that property rather than
 * assuming it.
 *
 * The CRLF normalization is not cosmetic. This repo can be checked out with CRLF endings, and the
 * asset would then carry them; emitting those bytes would make the generated tree host-dependent
 * and break the golden. Normalizing on READ keeps the emitted bytes identical on every host.
 */
const LOCKFILE_ASSET = new URL("./assets/controlled-profile-v2-lock.yaml", import.meta.url);

function lockfileBytes(): string {
  return readFileSync(LOCKFILE_ASSET, "utf8").replaceAll("\r\n", "\n");
}

/**
 * Generate the controlled profile as DATA. Nothing here writes to the filesystem — the caller owns
 * where the tree lands — and the module holds no mutable state, so two concurrent calls cannot
 * interfere.
 *
 * THE VERSION IS CHECKED FIRST, before the product name, so `BOOTSTRAP_PROFILE_VERSION_UNKNOWN`
 * stays reachable when BOTH inputs are bad. A caller who asked for a profile this build cannot emit
 * should hear that, not a complaint about a name that belongs to a shape we were never going to
 * produce.
 */
export function generateControlledProfile(request: ControlledProfileRequest): ControlledProfileResult {
  if (!isKnownProfileVersion(request.profileVersion)) {
    return refuseControlledProfile(BOOTSTRAP_PROFILE_VERSION_UNKNOWN);
  }
  if (!isValidProductName(request.productName)) {
    return refuseControlledProfile(BOOTSTRAP_PRODUCT_NAME_INVALID);
  }

  // The name reaches exactly two files, each through its own explicit call site. A blanket replace
  // over the assembled tree would silently enrol any future template that happened to contain the
  // same string, and the name-only diff assertion would stop meaning what it says.
  const entries: [string, string][] = [
    ...controlledProfileRootFiles(request.productName, request.requiredVariableNames ?? []),
    ...controlledProfilePackageFiles(),
    ["pnpm-lock.yaml", lockfileBytes()],
  ];

  // UTF-16 code-unit order, NOT localeCompare: a locale-dependent sort would make the golden
  // manifest differ between hosts, which is the exact failure this row exists to prevent.
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return { ok: true, files: new Map(entries) };
}
