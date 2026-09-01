/** Current-run portability authority. Historical receipts live in a Git-independent module. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  SOURCE_COMMIT_CODES, refuseSourceCommit, type SourceCommitRefused,
} from "./portability-source-contract.js";
export {
  PORTABILITY_EVIDENCE_LAYER, SOURCE_COMMIT_CODES, type SourceCommitCode,
  type SourceCommitRefused,
} from "./portability-source-contract.js";

export const SOURCE_COMMIT_ENV = "MOE_PORTABILITY_SOURCE_COMMIT";
export const SOURCE_COMMIT_EVIDENCE_ENV = "MOE_PORTABILITY_EVIDENCE_MODE";
export const SOURCE_COMMIT_GIT_ENV = "MOE_PORTABILITY_GIT_EXECUTABLE";
export interface SourceCommitResolved {
  readonly boundBy: "CHECKOUT"; readonly ok: true; readonly sourceCommit: string;
}
export type SourceCommitOutcome = SourceCommitRefused | SourceCommitResolved;
export interface SourceCommitInputs {
  readonly actualCheckoutCommit: string | undefined;
  readonly declaredCommit?: string | undefined;
  /** Evidence jobs require one declaration shared outside Vitest workers. */
  readonly requireDeclaration?: boolean | undefined;
}
export interface CheckoutObservationResolved {
  readonly ok: true; readonly sourceCommit: string;
}
export type CheckoutObservation = CheckoutObservationResolved | SourceCommitRefused;
export interface CheckoutObservationOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined; readonly gitExecutable?: string | undefined;
  readonly requireAbsoluteExecutable?: boolean | undefined; readonly requireClean?: boolean | undefined;
}

const OBJECT_NAME = /^[0-9a-f]{40}$/u;
const GIT_MAX_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const STRICT_STAT_ARGS = ["-c", "core.trustctime=true", "-c", "core.checkStat=default"] as const;
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
export function resolveSourceCommit(inputs: SourceCommitInputs): SourceCommitOutcome {
  const actual = typeof inputs.actualCheckoutCommit === "string"
    ? inputs.actualCheckoutCommit.trim()
    : undefined;
  if (actual === undefined || actual === "") return refuseSourceCommit(SOURCE_COMMIT_CODES.absent);
  if (!OBJECT_NAME.test(actual)) return refuseSourceCommit(SOURCE_COMMIT_CODES.malformed);
  const rawDeclaration = inputs.declaredCommit;
  if (inputs.requireDeclaration === true && rawDeclaration === undefined) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.absent);
  }
  const declared = typeof rawDeclaration === "string" ? rawDeclaration.trim() : rawDeclaration;
  if (declared !== undefined && (declared === "" || !OBJECT_NAME.test(String(declared)))) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.malformed);
  }
  if (declared !== undefined && declared !== actual) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.checkoutMismatch);
  }
  return Object.freeze({ boundBy: "CHECKOUT" as const, ok: true as const, sourceCommit: actual });
}
function isolatedGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  return environment;
}
function runGit(
  executable: string, repository: string, environment: NodeJS.ProcessEnv, args: readonly string[],
): string | undefined {
  try {
    const result = spawnSync(executable, [
      "--no-replace-objects",
      "-c", `safe.directory=${repository}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      "-C", repository,
      ...args,
    ], {
      cwd: repository,
      encoding: "utf8",
      env: environment,
      maxBuffer: GIT_MAX_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
      return undefined;
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}
function parseIdentity(output: string | undefined): readonly [string, string] | undefined {
  if (output === undefined || output.includes("\0")) return undefined;
  const lines = output.replaceAll("\r\n", "\n").replace(/\n$/u, "").split("\n");
  if (lines.length !== 2 || lines[0] === "" || !OBJECT_NAME.test(lines[1] ?? "")) return undefined;
  return [lines[0] ?? "", lines[1] ?? ""] as const;
}
function hasSpecialIndexFlags(output: string | undefined): boolean | undefined {
  if (output === undefined) return undefined;
  if (output === "") return false;
  if (!output.endsWith("\0")) return undefined;
  return output.slice(0, -1).split("\0").some((entry) => !entry.startsWith("H "));
}
function singleLine(output: string | undefined): string | undefined {
  if (output === undefined || output.includes("\0")) return undefined;
  const value = output.replace(/\r?\n$/u, "");
  return value !== "" && !value.includes("\r") && !value.includes("\n") ? value : undefined;
}
function exactWorktreeTree(executable: string, repository: string,
  environment: NodeJS.ProcessEnv, commit: string): "DIRTY" | "MATCH" | undefined {
  const expectedTree = singleLine(runGit(
    executable, repository, environment, ["rev-parse", "--verify", `${commit}^{tree}`],
  ));
  const rawObjects = singleLine(runGit(executable, repository, environment, [
    "rev-parse", "--path-format=absolute", "--git-path", "objects",
  ]));
  if (!OBJECT_NAME.test(expectedTree ?? "") || rawObjects === undefined) return undefined;
  let scratch: string | undefined;
  let outcome: "DIRTY" | "MATCH" | undefined;
  try {
    const realObjects = realpathSync(rawObjects);
    scratch = mkdtempSync(join(tmpdir(), "moe-portability-tree-"));
    const scratchRoot = realpathSync(scratch);
    const fromRepository = relative(repository, scratchRoot);
    if (fromRepository === "" || (fromRepository !== ".."
      && !fromRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(fromRepository))) throw new Error("scratch directory is inside checkout");
    const template = join(scratchRoot, "template"), gitDirectory = join(scratchRoot, "git");
    mkdirSync(template);
    const initialized = runGit(executable, repository, environment,
      ["init", "--bare", "--quiet", `--template=${template}`, gitDirectory]);
    if (initialized !== "") throw new Error("scratch repository initialization failed");
    const treeEnvironment = { ...environment,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects,
      GIT_DIR: gitDirectory, GIT_INDEX_FILE: join(scratchRoot, "index"),
      GIT_OBJECT_DIRECTORY: join(gitDirectory, "objects"), GIT_WORK_TREE: repository,
    };
    const read = runGit(executable, repository, treeEnvironment, [
      ...STRICT_STAT_ARGS, "read-tree", "--no-sparse-checkout", `${commit}^{tree}`,
    ]);
    const add = read === "" ? runGit(
      executable, repository, treeEnvironment, [
        ...STRICT_STAT_ARGS, "add", "--update", "--", ".",
      ],
    ) : undefined;
    const actualTree = add === "" ? singleLine(runGit(
      executable, repository, treeEnvironment, [...STRICT_STAT_ARGS, "write-tree"],
    )) : undefined;
    outcome = actualTree === undefined ? undefined : actualTree === expectedTree ? "MATCH" : "DIRTY";
  } catch {
    outcome = undefined;
  }
  if (scratch !== undefined) {
    try { rmSync(scratch, { force: true, recursive: true }); } catch { return undefined; }
  }
  return outcome;
}
/** Observes one repository with Git routing/config isolated from the caller. */
export function observeCheckoutCommit(
  repository: string,
  options: CheckoutObservationOptions = {},
): CheckoutObservation {
  const executable = options.gitExecutable ?? "git";
  if (options.requireAbsoluteExecutable === true && !isAbsolute(executable)) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
  }
  let expectedRoot: string;
  try {
    expectedRoot = realpathSync(repository);
  } catch {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
  }
  const environment = isolatedGitEnvironment(options.environment ?? process.env);
  const before = parseIdentity(runGit(
    executable, expectedRoot, environment, ["rev-parse", "--show-toplevel", "--verify", "HEAD"],
  ));
  if (before === undefined) return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
  try {
    if (realpathSync(before[0]) !== expectedRoot) {
      return refuseSourceCommit(SOURCE_COMMIT_CODES.repositoryMismatch);
    }
  } catch {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.repositoryMismatch);
  }
  if (options.requireClean === true) {
    const specialFlags = hasSpecialIndexFlags(runGit(
      executable, expectedRoot, environment, ["ls-files", "-v", "-z", "--"],
    ));
    if (specialFlags === undefined) {
      return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
    }
    if (specialFlags) return refuseSourceCommit(SOURCE_COMMIT_CODES.checkoutDirty);
    const exactTree = exactWorktreeTree(executable, expectedRoot, environment, before[1]);
    if (exactTree !== "MATCH") return refuseSourceCommit(SOURCE_COMMIT_CODES.checkoutDirty);
    const status = runGit(executable, expectedRoot, environment, [
      "status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none",
    ]);
    if (status === undefined) return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
    if (status !== "") return refuseSourceCommit(SOURCE_COMMIT_CODES.checkoutDirty);
  }
  const after = parseIdentity(runGit(
    executable, expectedRoot, environment, ["rev-parse", "--show-toplevel", "--verify", "HEAD"],
  ));
  if (after === undefined || after[0] !== before[0] || after[1] !== before[1]) {
    return refuseSourceCommit(SOURCE_COMMIT_CODES.observationFailed);
  }
  return Object.freeze({ ok: true as const, sourceCommit: before[1] });
}
function capturePortabilitySourceCommit(): SourceCommitOutcome {
  const evidenceMode = process.env[SOURCE_COMMIT_EVIDENCE_ENV] === "1";
  const observed = observeCheckoutCommit(REPOSITORY_ROOT, {
    environment: process.env,
    gitExecutable: evidenceMode ? process.env[SOURCE_COMMIT_GIT_ENV] : undefined,
    requireAbsoluteExecutable: evidenceMode,
    requireClean: evidenceMode,
  });
  if (!observed.ok) return observed;
  return resolveSourceCommit({
    actualCheckoutCommit: observed.sourceCommit,
    declaredCommit: process.env[SOURCE_COMMIT_ENV],
    requireDeclaration: evidenceMode,
  });
}
/** One immutable per-process decision; evidence mode shares its declaration outside workers. */
const CAPTURED_PORTABILITY_SOURCE = capturePortabilitySourceCommit();
export function resolvePortabilitySourceCommit(): SourceCommitOutcome {
  return CAPTURED_PORTABILITY_SOURCE;
}

export function readPortabilitySourceCommit(): string {
  const outcome = resolvePortabilitySourceCommit();
  if (!outcome.ok) {
    throw new Error(`${outcome.code}@${outcome.layer}: portability checkout identity is not proven`);
  }
  return outcome.sourceCommit;
}

export const PORTABILITY_SOURCE_COMMIT: string = readPortabilitySourceCommit();
