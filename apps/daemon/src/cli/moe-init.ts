import { createHash, randomBytes } from "node:crypto";
import { join, win32 } from "node:path";

/**
 * `moe init`'s decision layer, kept PURE over its inputs: the caller probes the
 * filesystem and hands the observations in, so every refusal is unit-testable
 * without a directory, a store, or a process.
 *
 * The credential is MINTED here and disclosed by provenance only — the same
 * discipline `moe-up-env.ts` ships, for the same reason: a credential printed
 * into a scrollback is a credential in every screen recording of the demo it
 * was minted for. It is written to the config on the operator's machine and
 * never travels inside the distributed artifact.
 */

/** The target cannot be written at all; nothing else is worth reporting. */
export const MOE_INIT_TARGET_UNWRITABLE = "MOE_INIT_TARGET_UNWRITABLE" as const;
/** A config is already there. `--force` does NOT overwrite an existing store identity. */
export const MOE_INIT_CONFIG_PRESENT = "MOE_INIT_CONFIG_PRESENT" as const;
/** The target holds files. `--force` waives this one, and only this one. */
export const MOE_INIT_TARGET_NOT_EMPTY = "MOE_INIT_TARGET_NOT_EMPTY" as const;
/**
 * The packed manifest carries no `engines` field, so this CLI is the artifact's
 * only enforcement point: a Node 22 operator must read this code, not an
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` stack out of a stripped-types entry.
 */
export const MOE_CLI_NODE_UNSUPPORTED = "MOE_CLI_NODE_UNSUPPORTED" as const;

/** The config bytes are not JSON at all. */
export const MOE_CONFIG_UNREADABLE = "MOE_CONFIG_UNREADABLE" as const;
/** The config parsed but a field this CLI requires is absent, empty, or foreign. */
export const MOE_CONFIG_INVALID = "MOE_CONFIG_INVALID" as const;

export const MOE_CONFIG_FILENAME = "moe.config.json" as const;
export const MOE_CONFIG_SCHEMA_VERSION = "moe-cli-config/1" as const;

const STORE_FILENAME = "store.sqlite";
const FALLBACK_PROJECT_ID = "moe-local";
const CREDENTIAL_BYTES = 32;
const PROJECT_ID_HASH_CHARACTERS = 12;
const PROJECT_ID_SLUG_CHARACTERS = 110;
/** The documented prerequisite: `>=24.16.0 <25`, the root manifest's own range. */
const SUPPORTED_NODE_MAJOR = 24;
const SUPPORTED_NODE_MINIMUM_MINOR = 16;

export type InitRefusalCode =
  | typeof MOE_CLI_NODE_UNSUPPORTED
  | typeof MOE_INIT_CONFIG_PRESENT
  | typeof MOE_INIT_TARGET_NOT_EMPTY
  | typeof MOE_INIT_TARGET_UNWRITABLE;

export interface InitRefusal {
  readonly code: InitRefusalCode;
  /** The EXACT subject of the refusal — the operator's whole fix. */
  readonly detail: string;
  readonly message: string;
}

/** What the caller observed at the target. `entries` is empty when it is absent. */
export interface InitProbe {
  readonly entries: readonly string[];
  readonly writable: boolean;
}

export interface InitInputs {
  readonly force: boolean;
  readonly probe: InitProbe;
  /** INJECTED so two runs over identical inputs produce an identical plan. */
  readonly randomHex: (bytes: number) => string;
  /** Absolute; the caller resolves it before probing. */
  readonly targetDir: string;
}

export interface PlannedFile {
  readonly contents: string;
  readonly path: string;
}

export interface InitPlan {
  readonly configPath: string;
  readonly credential: string;
  /** Operator-facing provenance lines; the credential's VALUE is never among them. */
  readonly disclosures: readonly string[];
  readonly files: readonly PlannedFile[];
  readonly ok: true;
  readonly projectId: string;
  readonly storePath: string;
}

export interface InitRefused {
  readonly ok: false;
  readonly refusals: readonly InitRefusal[];
}

export type InitResolution = InitPlan | InitRefused;

export interface MoeConfig {
  readonly credential: string;
  readonly projectId: string;
  readonly schemaVersion: string;
  readonly storePath: string;
}

export interface ConfigRead {
  readonly config: MoeConfig;
  readonly ok: true;
}

export interface ConfigRefused {
  readonly code: typeof MOE_CONFIG_INVALID | typeof MOE_CONFIG_UNREADABLE;
  readonly detail: string;
  readonly message: string;
  readonly ok: false;
}

export type ConfigResolution = ConfigRead | ConfigRefused;

function refusal(code: InitRefusalCode, detail: string): InitRefusal {
  return Object.freeze({ code, detail, message: `${code}: ${detail}` });
}

/**
 * A project id the store can key on, derived from what the operator typed. Not
 * reversible and not meant to be: it only has to be stable and non-empty.
 */
function projectIdFor(targetDir: string): string {
  const canonicalWindowsPath = win32.normalize(targetDir.replaceAll("/", "\\"))
    .replaceAll(/\\+$/gu, "").toLowerCase();
  const leaf = win32.basename(canonicalWindowsPath);
  const readable = leaf.replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "")
    .slice(0, PROJECT_ID_SLUG_CHARACTERS);
  const slug = readable === "" ? FALLBACK_PROJECT_ID : readable;
  const suffix = createHash("sha256").update(canonicalWindowsPath, "utf8").digest("hex")
    .slice(0, PROJECT_ID_HASH_CHARACTERS);
  return `${slug}-${suffix}`;
}

export function planInit(inputs: InitInputs): InitResolution {
  const { force, probe, targetDir } = inputs;
  const refusals: InitRefusal[] = [];
  if (!probe.writable) refusals.push(refusal(MOE_INIT_TARGET_UNWRITABLE, targetDir));
  // Checked BEFORE the emptiness rule and unaffected by `--force`: overwriting a
  // config silently orphans the store it points at, credential and all.
  if (probe.entries.includes(MOE_CONFIG_FILENAME)) {
    refusals.push(refusal(MOE_INIT_CONFIG_PRESENT, MOE_CONFIG_FILENAME));
  }
  if (probe.entries.length > 0 && !force) {
    refusals.push(refusal(MOE_INIT_TARGET_NOT_EMPTY, `${targetDir} (${String(probe.entries.length)} entries)`));
  }
  if (refusals.length > 0) return Object.freeze({ ok: false, refusals: Object.freeze(refusals) });

  const credential = inputs.randomHex(CREDENTIAL_BYTES);
  const projectId = projectIdFor(targetDir);
  const storePath = join(targetDir, STORE_FILENAME);
  const configPath = join(targetDir, MOE_CONFIG_FILENAME);
  // Key order is fixed by this literal, which is what makes the emitted bytes
  // reproducible rather than merely equivalent.
  const config: MoeConfig = {
    credential, projectId, schemaVersion: MOE_CONFIG_SCHEMA_VERSION, storePath,
  };
  return Object.freeze({
    configPath,
    credential,
    disclosures: Object.freeze([
      `  MOE_STORE_PATH=${storePath} (planned)`,
      `  MOE_PROJECT_ID=${projectId} (derived)`,
      "  MOE_DAEMON_CREDENTIAL=<minted, hidden> (minted)",
    ]),
    files: Object.freeze([Object.freeze({
      contents: `${JSON.stringify(config, null, 2)}\n`, path: configPath,
    })]),
    ok: true,
    projectId,
    storePath,
  });
}

const REQUIRED_CONFIG_FIELDS = ["credential", "projectId", "schemaVersion", "storePath"] as const;

function configRefusal(
  code: ConfigRefused["code"], detail: string,
): ConfigRefused {
  return Object.freeze({ code, detail, message: `${code}: ${detail}`, ok: false });
}

/**
 * The start command's read-back. Empty is absent, the same rule the daemon's own
 * `readStoreDependencyEnv` applies: a blank `storePath` must not open a store at
 * the empty path, it must name the field that is wrong.
 */
export function parseMoeConfig(raw: string): ConfigResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return configRefusal(MOE_CONFIG_UNREADABLE, (error as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return configRefusal(MOE_CONFIG_INVALID, "root");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_CONFIG_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value === "") return configRefusal(MOE_CONFIG_INVALID, field);
  }
  if (record["schemaVersion"] !== MOE_CONFIG_SCHEMA_VERSION) {
    return configRefusal(MOE_CONFIG_INVALID, "schemaVersion");
  }
  return Object.freeze({
    config: Object.freeze({
      credential: record["credential"] as string,
      projectId: record["projectId"] as string,
      schemaVersion: record["schemaVersion"] as string,
      storePath: record["storePath"] as string,
    }),
    ok: true,
  });
}

/** `null` when this Node can run the shipped sources; a named refusal otherwise. */
export function checkNodeVersion(version: string): InitRefusal | null {
  const parts = /^v?(?<major>\d+)\.(?<minor>\d+)\./u.exec(version)?.groups;
  if (parts === undefined) return refusal(MOE_CLI_NODE_UNSUPPORTED, version);
  const major = Number(parts["major"]);
  const minor = Number(parts["minor"]);
  const supported = major === SUPPORTED_NODE_MAJOR && minor >= SUPPORTED_NODE_MINIMUM_MINOR;
  return supported ? null : refusal(MOE_CLI_NODE_UNSUPPORTED, version);
}

/** The production randomness source, kept here so entries never reach for crypto. */
export function cryptoRandomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
