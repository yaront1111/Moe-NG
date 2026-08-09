import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";

import {
  HOST,
  parseJsonOrNull,
  readTextOrNull,
  readWorkspaceComponents,
  resolveRepoRoot,
  stringField,
  unreadablePin,
} from "./doctor-version-components.node.js";
import { buildDoctorVersionReport, known, unknown } from "./doctor-version-contract.js";
import type { DoctorVersionReport, ObservedValue } from "./doctor-version-contract.js";

/**
 * The Node boundary of the doctor's version report: everything that touches a
 * process or a child process. Every comparison lives in the contract module —
 * nothing below decides whether a pin is met.
 *
 * Every reader is total. A missing file, an unparseable manifest, an absent tool
 * or a spawn that times out all return a coded UNKNOWN under DOCTOR_VERSION_HOST
 * and none of them throws: a doctor that crashes reports nothing, and a doctor
 * that omits a value it could not read is indistinguishable from one reporting a
 * satisfied pin.
 */
const execFileAsync = promisify(execFile);

// Re-exported so consumers and tests reach the whole boundary through one module.
export { resolveRepoRoot, readWorkspaceComponents };
export type { WorkspaceInventory } from "./doctor-version-components.node.js";

/** Values are READ from the live process. A literal here would be the defect. */
export function readObservedRuntime(): {
  readonly node: ObservedValue;
  readonly platform: ObservedValue;
  readonly arch: ObservedValue;
} {
  const read = (value: unknown): ObservedValue =>
    typeof value === "string" && value.length > 0
      ? known(value)
      : unknown("DOCTOR_RUNTIME_VERSION_UNREADABLE", HOST);
  return {
    node: read(process.version),
    platform: read(process.platform),
    arch: read(process.arch),
  };
}

/**
 * The DECLARED half. Raw strings are preserved exactly as the repo wrote them —
 * `.node-version` keeps its trailing newline and `packageManager` keeps its
 * `pnpm@` prefix — because normalising here would hide from a consumer what the
 * repo actually declares. The contract normalises at comparison time instead.
 */
export function readDeclaredPins(repoRoot: string | null): DoctorVersionReport["declared"] {
  if (repoRoot === null) {
    return {
      nodeVersionFile: unreadablePin(),
      packageManager: unreadablePin(),
      enginesNode: unreadablePin(),
      enginesPnpm: unreadablePin(),
    };
  }
  const nodeVersionRaw = readTextOrNull(join(repoRoot, ".node-version"));
  const manifest = parseJsonOrNull(readTextOrNull(join(repoRoot, "package.json")));
  const engines = manifest?.["engines"];
  const engineFields =
    typeof engines === "object" && engines !== null && !Array.isArray(engines)
      ? (engines as Record<string, unknown>)
      : null;
  return {
    nodeVersionFile:
      nodeVersionRaw !== null && nodeVersionRaw.trim().length > 0
        ? known(nodeVersionRaw)
        : unreadablePin(),
    packageManager: stringField(manifest, "packageManager"),
    enginesNode: stringField(engineFields, "node"),
    enginesPnpm: stringField(engineFields, "pnpm"),
  };
}

const SPAWN_OPTIONS = {
  timeout: 10_000,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  shell: false,
} as const;

/**
 * `.cmd`, `.bat` and `.ps1` are excluded deliberately: Node 24 cannot spawn them
 * with `shell:false`, and a shell is not an option at an external boundary. A
 * `.js` on PATH is not an executable image either, so the allowlist is real
 * program images only, intersected with the host's PATHEXT.
 */
const SPAWNABLE_IMAGES = new Set([".exe", ".com"]);

const pathCandidates = (): readonly string[] => {
  const entries = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE")
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter((extension) => SPAWNABLE_IMAGES.has(extension))
      : [""];
  return entries.flatMap((entry) => extensions.map((extension) => join(entry, `pnpm${extension}`)));
};

/** Exactly one semver-shaped line. Extra output means something else answered. */
const parseVersionOutput = (stdout: string): ObservedValue => {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const only = lines.length === 1 ? lines[0]?.trim() : undefined;
  return only !== undefined && /^\d+\.\d+\.\d+/.test(only)
    ? known(only)
    : unknown("DOCTOR_TOOL_VERSION_UNREADABLE", HOST);
};

/** null means "this candidate did not answer"; the caller tries the next one. */
async function runVersion(command: string, args: readonly string[]): Promise<ObservedValue | null> {
  try {
    const { stdout } = await execFileAsync(command, [...args], SPAWN_OPTIONS);
    const parsed = parseVersionOutput(stdout);
    return parsed.known ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The measured candidate ladder. Every miss falls through to the next and the
 * final miss is a coded UNKNOWN — on a host where no non-shim pnpm resolves,
 * "I could not read it" is the correct and only honest answer.
 */
export async function readPnpmVersion(): Promise<ObservedValue> {
  const execPath = process.env["npm_execpath"] ?? "";
  const viaNode = [
    ...(/\.[cm]?js$/.test(execPath) ? [execPath] : []),
    join(process.cwd(), "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ].filter(
    // `npm_execpath` is environment-controlled, and this function runs it through
    // `process.execPath`. The name guard keeps an inherited variable from turning
    // a version probe into "execute whatever script the environment names".
    (candidate) => basename(candidate).toLowerCase().startsWith("pnpm") && existsSync(candidate),
  );

  for (const script of viaNode) {
    const answer = await runVersion(process.execPath, [script, "--version"]);
    if (answer !== null) return answer;
  }
  for (const image of pathCandidates()) {
    if (!existsSync(image)) continue;
    const answer = await runVersion(image, ["--version"]);
    if (answer !== null) return answer;
  }
  return unknown("DOCTOR_TOOL_VERSION_UNREADABLE", HOST);
}

export async function collectDoctorVersionReport(): Promise<DoctorVersionReport> {
  const repoRoot = resolveRepoRoot();
  const runtime = readObservedRuntime();
  const { components, inventory } = readWorkspaceComponents(repoRoot);
  return buildDoctorVersionReport({
    observed: { ...runtime, pnpm: await readPnpmVersion() },
    declared: readDeclaredPins(repoRoot),
    components,
    componentInventory: inventory,
  });
}
