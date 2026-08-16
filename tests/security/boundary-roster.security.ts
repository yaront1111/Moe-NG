/**
 * DECLARED-BOUNDARY ROSTER — the enumeration the security fault matrix consumes.
 *
 * A DECLARED BOUNDARY is a constant a PRODUCTION module exports to name a refusal
 * layer. Not declarations, and excluded by `isProductionModule`: `*.test.ts`,
 * `*.spec.ts`, `*.test-fixtures.ts`, `*-fixtures.ts`, anything under
 * `packages/testkit/`, and constants that merely LIST other boundaries' names. The
 * `.test-fixtures.ts` case is the subtle one — it contains no `.test.` segment, so a
 * `grep -v '\.test\.'` filter does not exclude it. That gap inflated an earlier count;
 * the two named exclusion cases below are its regression test.
 *
 * HAND-WRITTEN AND SOURCE-COMPARED, both directions. A table derived from the scan
 * cannot police the scan — and the scan is what needs policing, since this artifact
 * exists because a scan pattern was wrong. A hand list alone under-covers silently the
 * day an 88th boundary lands. Only both together catch a bad scanner AND a stale roster.
 *
 * CARDINALITY AND DISTRIBUTION ARE ASSERTED SEPARATELY because set-equality passes
 * vacuously when both sides are empty, and passes just as happily when a
 * silently-narrowed scan is compared against a roster built from that same narrow scan.
 *
 * THE COVERAGE RATCHET IS DELIBERATELY OPEN. This file asserts only that the roster
 * matches source and that every axis tag is used. It does NOT assert that every
 * boundary has hostile coverage — no sibling slice has landed that coverage yet, so
 * closing the ratchet here would fail permanently and block the very tasks meant to
 * satisfy it. task-3b1cbdf9bd39405bb32230552d3ab242 owns that flip.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertRefusedWith,
  cleanupHostileRoots,
  HostileBoundExceededError,
  HostileHarnessMisuseError,
  MAX_BOUND_MS,
  probeAfter,
  probeBefore,
  probeRacing,
  withHostileRoot,
} from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";

/**
 * The five coverage axes, one per sibling slice. Closed union: a typo in an entry's
 * axis is a compile error rather than an orphaned tag nobody ever claims.
 */
export type CoverageAxis =
  | "transport"
  | "integrity"
  | "durable-store"
  | "runtime-provider"
  | "scheduler-activation";

const COVERAGE_AXES: readonly CoverageAxis[] = Object.freeze([
  "transport",
  "integrity",
  "durable-store",
  "runtime-provider",
  "scheduler-activation",
]);

export interface RosterEntry {
  /** The exported constant's identifier. */
  readonly constant: string;
  /** Declaring file, repo-root-relative, forward slashes. */
  readonly file: string;
  /** The sibling slice that owns hostile coverage of this boundary. */
  readonly axis: CoverageAxis;
}

interface ScannedBoundary {
  readonly constant: string;
  readonly file: string;
}

/**
 * HAND-WRITTEN, ordered by declaring path. Every entry was typed out from its
 * declaration site, and every `axis` is a judgement about which sibling slice owns
 * hostile coverage — no part of this table is emitted by the scanner it polices.
 *
 * TAGGING RULE, so a later reader can audit a tag rather than guess at it. The axis is
 * chosen by the constant's SUBJECT, not merely by its directory:
 *   transport            — wire, IPC and UI surfaces carrying authority between processes
 *   integrity            — codecs, digests, authentication, approval authority, config
 *   durable-store        — durable persistence: store, ledgers, install, anchor, inventory
 *   runtime-provider     — process, platform and provider runtime surfaces
 *   scheduler-activation — admission, scheduling, activation, expansion, planning, goal
 *
 * Where directory and subject disagree the SUBJECT wins: four `apps/daemon/src/recovery/`
 * constants are integrity rather than durable-store (digest, approval, reducer and
 * key-provider layers), and `apps/daemon/src/work/foundation-attempt-contracts.ts`
 * splits across two axes, declaring a runner-workspace and a scheduler-graph layer.
 *
 * Axis totals for the sibling slices: transport 15, integrity 13, durable-store 14,
 * runtime-provider 23, scheduler-activation 24 — sums to 89. These tags, NOT the subset
 * counts in the siblings' own descriptions, are the authority. (87→89 on 2026-08-16:
 * BENCHMARK_PROJECTION_LAYERS runtime-provider, FOUNDATION_VERIFICATION_LAYERS
 * scheduler-activation — producer-registers rule, governor entries.)
 */
const BOUNDARY_ROSTER: readonly RosterEntry[] = Object.freeze([
  { constant: "IDE_ADAPTER_LAYER", file: "adapters/ide-contract/src/index.ts", axis: "transport" },
  { constant: "IDE_ADAPTER_LAYERS", file: "adapters/ide-contract/src/index.ts", axis: "transport" },
  { constant: "EFFORT_ADMISSION_LAYER", file: "apps/control-room/src/performance/effort-records.ts", axis: "transport" },
  { constant: "EFFORT_COLLECTOR_LAYER", file: "apps/control-room/src/performance/effort-records.ts", axis: "transport" },
  { constant: "EFFORT_LAYERS", file: "apps/control-room/src/performance/effort-records.ts", axis: "transport" },
  { constant: "TIMELINE_REFUSAL_LAYERS", file: "apps/control-room/src/timeline/timeline-contract.ts", axis: "transport" },
  { constant: "ACTIVATION_BUDGET_LAYER", file: "apps/daemon/src/activation/activation-ingress-contracts.ts", axis: "scheduler-activation" },
  { constant: "ACTIVATION_INGRESS_LAYER", file: "apps/daemon/src/activation/activation-ingress-contracts.ts", axis: "scheduler-activation" },
  { constant: "ACTIVATION_SLOT_LAYER", file: "apps/daemon/src/activation/activation-ingress-contracts.ts", axis: "scheduler-activation" },
  { constant: "ACTIVATION_LEDGER_LAYER", file: "apps/daemon/src/activation/activation-ledger-contracts.ts", axis: "scheduler-activation" },
  { constant: "FOUNDATION_ACTIVATION_BINDING_LAYER", file: "apps/daemon/src/activation/foundation-activation-transition.ts", axis: "scheduler-activation" },
  { constant: "PROJECT_CONFIGURATION_SELECTION_LAYER", file: "apps/daemon/src/configuration/project-configuration-selection.ts", axis: "integrity" },
  { constant: "DAEMON_ENTRY_LAYER", file: "apps/daemon/src/daemon-entry.ts", axis: "transport" },
  { constant: "DOCUMENT_WORK_SERVICE_LAYERS", file: "apps/daemon/src/documents/document-work-service-contract.ts", axis: "scheduler-activation" },
  // Verification activation authority: FOUNDATION_* dispatch/verification family per the
  // subject-wins rule (governor entry 2026-08-16, producer task-44d4873e).
  { constant: "FOUNDATION_VERIFICATION_LAYERS", file: "apps/daemon/src/evidence/foundation-verification-contracts.ts", axis: "scheduler-activation" },
  { constant: "AFFORDANCE_SURFACE_LAYER", file: "apps/daemon/src/http/affordance-contract.ts", axis: "transport" },
  { constant: "EVENT_STREAM_LAYER", file: "apps/daemon/src/http/event-stream-observation.ts", axis: "transport" },
  { constant: "CONTROL_ROOM_LISTENER_LAYER", file: "apps/daemon/src/http/http-listener-guards.ts", axis: "transport" },
  { constant: "SESSION_AUTHORITY_DAEMON_LAYERS", file: "apps/daemon/src/identity/session-authority-contracts.ts", axis: "integrity" },
  { constant: "AGENT_STAFFING_LAYER", file: "apps/daemon/src/orchestrator/agent-session-fence.ts", axis: "scheduler-activation" },
  { constant: "SPAWN_INVOCATION_LAYER", file: "apps/daemon/src/orchestrator/agent-spawn-invocation.ts", axis: "scheduler-activation" },
  { constant: "DOCTOR_VERSION_LAYERS", file: "apps/daemon/src/recovery/doctor-version-contract.ts", axis: "durable-store" },
  { constant: "DURABLE_INVENTORY_ADAPTER_LAYER", file: "apps/daemon/src/recovery/durable-recovery-inventory-contract.ts", axis: "durable-store" },
  { constant: "RECOVERY_COMPLETION_LAYER", file: "apps/daemon/src/recovery/recovery-completion-digest.ts", axis: "integrity" },
  { constant: "CORE_APPROVAL_LAYER", file: "apps/daemon/src/recovery/recovery-completion-evidence.ts", axis: "integrity" },
  { constant: "DAEMON_INGRESS_LAYER", file: "apps/daemon/src/recovery/recovery-completion-evidence.ts", axis: "transport" },
  { constant: "DURABLE_STORE_LAYER", file: "apps/daemon/src/recovery/recovery-completion-evidence.ts", axis: "durable-store" },
  { constant: "PROJECT_REDUCER_LAYER", file: "apps/daemon/src/recovery/recovery-completion-evidence.ts", axis: "integrity" },
  { constant: "RECOVERY_INCARNATION_LAYER", file: "apps/daemon/src/recovery/recovery-incarnation-contract.ts", axis: "durable-store" },
  { constant: "RECOVERY_INVENTORY_LAYER", file: "apps/daemon/src/recovery/recovery-inventory-contract.ts", axis: "durable-store" },
  { constant: "RECOVERY_INVENTORY_LEDGER_LAYER", file: "apps/daemon/src/recovery/recovery-inventory-contract.ts", axis: "durable-store" },
  { constant: "RECOVERY_INVENTORY_UPSTREAM_LAYERS", file: "apps/daemon/src/recovery/recovery-inventory-contract.ts", axis: "durable-store" },
  { constant: "RECOVERY_KEY_PROVIDER_LAYER", file: "apps/daemon/src/recovery/recovery-key-provider-contract.ts", axis: "integrity" },
  { constant: "RECOVERY_SUCCESSION_LAYER", file: "apps/daemon/src/recovery/recovery-succession-contract.ts", axis: "durable-store" },
  { constant: "RESTORE_CONTROLLER_LAYER", file: "apps/daemon/src/recovery/restore-controller-contract.ts", axis: "durable-store" },
  { constant: "RESTORE_REFUSAL_LAYERS", file: "apps/daemon/src/recovery/restore-controller-contract.ts", axis: "durable-store" },
  { constant: "PROVIDER_RUN_LEDGER_LAYERS", file: "apps/daemon/src/telemetry/provider-run-refusals.ts", axis: "runtime-provider" },
  { constant: "RUNNER_WORKSPACE_LAYER", file: "apps/daemon/src/work/foundation-attempt-contracts.ts", axis: "runtime-provider" },
  { constant: "SCHEDULER_GRAPH_LAYER", file: "apps/daemon/src/work/foundation-attempt-contracts.ts", axis: "scheduler-activation" },
  { constant: "WORK_LAYERS", file: "apps/daemon/src/work/work-kernel.ts", axis: "scheduler-activation" },
  // Provider-run record projection: consumes the provider-run family, same subject as
  // PROVIDER_RUN_LEDGER_LAYERS (governor entry 2026-08-16, producer task-b937811e).
  { constant: "BENCHMARK_PROJECTION_LAYERS", file: "packages/benchmark/src/benchmark-projection-vocabulary.ts", axis: "runtime-provider" },
  { constant: "PROJECT_CONFIGURATION_REFUSAL_LAYERS", file: "packages/contracts/src/configuration/project-configuration-contract.ts", axis: "integrity" },
  { constant: "DISTRIBUTION_REFUSAL_LAYERS", file: "packages/contracts/src/distribution/distribution-contract.ts", axis: "integrity" },
  { constant: "DOCUMENT_WORK_PROPOSAL_LAYERS", file: "packages/contracts/src/document-work/document-work-proposal-contract.ts", axis: "integrity" },
  { constant: "CONTROL_ROOM_TRANSPORT_LAYER", file: "packages/control-room-client/src/client-transport.ts", axis: "transport" },
  { constant: "COORDINATION_LAYERS", file: "packages/coordination/src/coordination-contracts.ts", axis: "transport" },
  { constant: "PROJECT_CONFIGURATION_CODEC_LAYERS", file: "packages/core/src/configuration/project-configuration-manifest.ts", axis: "integrity" },
  { constant: "EXPANSION_APPROVAL_LAYERS", file: "packages/core/src/expansion/expansion-approval.ts", axis: "scheduler-activation" },
  { constant: "EXPANSION_HOLD_LAYERS", file: "packages/core/src/expansion/expansion-planning-hold.ts", axis: "scheduler-activation" },
  { constant: "EXPANSION_PREPARATION_LAYERS", file: "packages/core/src/expansion/expansion-preparation.ts", axis: "scheduler-activation" },
  { constant: "GOAL_LAYER", file: "packages/core/src/goal/goal-results.ts", axis: "scheduler-activation" },
  { constant: "SESSION_AUTH_LAYERS", file: "packages/core/src/identity/authenticate-session.ts", axis: "integrity" },
  { constant: "APPROVAL_AUTHORITY_LAYERS", file: "packages/core/src/planning/approval-authority.ts", axis: "integrity" },
  { constant: "GRAPH_REVISION_LAYER", file: "packages/core/src/planning/graph-revision-contract.ts", axis: "scheduler-activation" },
  { constant: "PLANNING_EXPANSION_LAYERS", file: "packages/core/src/planning/planning-expansion-validation.ts", axis: "scheduler-activation" },
  { constant: "SUPERSESSION_KERNEL_LAYER", file: "packages/core/src/supersession/supersession-engine.ts", axis: "scheduler-activation" },
  { constant: "IMPORT_REFUSAL_LAYERS", file: "packages/import/src/import-contract.ts", axis: "transport" },
  { constant: "HTTP_SHUTDOWN_LAYER", file: "packages/mcp/src/http/http-shutdown.ts", axis: "transport" },
  { constant: "REVIEW_DECISION_LAYERS", file: "packages/review/src/review-contract.ts", axis: "integrity" },
  { constant: "ARTIFACT_ENUMERATION_LAYERS", file: "packages/runner/src/artifacts/artifact-contract.ts", axis: "runtime-provider" },
  { constant: "EVIDENCE_REFUSAL_LAYERS", file: "packages/runner/src/evidence/evidence-contract.ts", axis: "runtime-provider" },
  { constant: "VERIFIER_PROCESS_LAYERS", file: "packages/runner/src/evidence/verifier-process-contract.ts", axis: "runtime-provider" },
  { constant: "MATERIALIZATION_REFUSAL_LAYERS", file: "packages/runner/src/materialization/materialization-kernel.ts", axis: "runtime-provider" },
  { constant: "PLATFORM_LINUX_LAYER", file: "packages/runner/src/platform/linux-facts.ts", axis: "runtime-provider" },
  { constant: "PLATFORM_MACOS_LAYER", file: "packages/runner/src/platform/macos/macos-facts.ts", axis: "runtime-provider" },
  { constant: "PLATFORM_BOUNDARIES", file: "packages/runner/src/platform/platform-contract.ts", axis: "runtime-provider" },
  { constant: "PLATFORM_LAYERS", file: "packages/runner/src/platform/platform-contract.ts", axis: "runtime-provider" },
  { constant: "WINDOWS_PROCESS_LAYERS", file: "packages/runner/src/platform/windows/windows-process-contract.ts", axis: "runtime-provider" },
  { constant: "CLAUDE_LAUNCH_SELECTION_LAYER", file: "packages/runner/src/providers/claude/claude-launch-selection.ts", axis: "runtime-provider" },
  { constant: "CLAUDE_LAUNCH_LAYERS", file: "packages/runner/src/providers/claude/claude-launcher-contract.ts", axis: "runtime-provider" },
  { constant: "CLAUDE_RENDER_LAYERS", file: "packages/runner/src/providers/claude/claude-render.ts", axis: "runtime-provider" },
  { constant: "CLAUDE_RUNTIME_PIN_LAYER", file: "packages/runner/src/providers/claude/claude-runtime-pin-closure.ts", axis: "runtime-provider" },
  { constant: "CODEX_RENDER_LAYERS", file: "packages/runner/src/providers/codex/codex-render.ts", axis: "runtime-provider" },
  { constant: "PROVIDER_TELEMETRY_LAYERS", file: "packages/runner/src/providers/telemetry/provider-telemetry-contracts.ts", axis: "runtime-provider" },
  { constant: "PROVIDER_USAGE_LAYERS", file: "packages/runner/src/providers/telemetry/provider-usage-contracts.ts", axis: "runtime-provider" },
  { constant: "RECOVERY_INVENTORY_LAYERS", file: "packages/runner/src/recovery-inventory/recovery-inventory-contract.ts", axis: "runtime-provider" },
  { constant: "RECOVERY_LAYERS", file: "packages/runner/src/recovery/recovery-contract.ts", axis: "runtime-provider" },
  { constant: "SCOPE_OBSERVER_LAYERS", file: "packages/runner/src/scope/scope-contract.ts", axis: "runtime-provider" },
  { constant: "SUPERVISOR_LAYERS", file: "packages/runner/src/supervisor/effect-kernel.ts", axis: "runtime-provider" },
  { constant: "MEASUREMENT_ISSUE_LAYERS", file: "packages/scheduler/src/budget/budget-measurement.ts", axis: "scheduler-activation" },
  { constant: "CONVERGENCE_BREAKER_LAYER", file: "packages/scheduler/src/convergence/breaker-contract.ts", axis: "scheduler-activation" },
  { constant: "EXPANSION_BINDING_LAYERS", file: "packages/scheduler/src/expansion/expansion-current-hold.ts", axis: "scheduler-activation" },
  { constant: "EXPANSION_EVIDENCE_LAYERS", file: "packages/scheduler/src/expansion/expansion-receipt.ts", axis: "scheduler-activation" },
  { constant: "FAIRNESS_CONTRACT_LAYERS", file: "packages/scheduler/src/fairness/fairness-contract.ts", axis: "scheduler-activation" },
  { constant: "READINESS_LAYERS", file: "packages/scheduler/src/readiness/readiness-model.ts", axis: "scheduler-activation" },
  { constant: "SUPERSESSION_DISPOSITION_LAYERS", file: "packages/scheduler/src/supersession/supersession-disposition-contract.ts", axis: "scheduler-activation" },
  { constant: "RECOVERY_ANCHOR_LAYER", file: "packages/store/src/recovery-anchor-contracts.ts", axis: "durable-store" },
  { constant: "RECOVERY_BINDING_CODEC_LAYER", file: "packages/store/src/recovery-install-contracts.ts", axis: "durable-store" },
  { constant: "RECOVERY_INSTALL_LAYERS", file: "packages/store/src/recovery-install-contracts.ts", axis: "durable-store" },
  { constant: "RECOVERY_INSTALL_TRANSACTION_LAYER", file: "packages/store/src/recovery-install-contracts.ts", axis: "durable-store" },
]);

/**
 * The corrected enumeration size. Measured at HEAD abc3dcf; see step 1.
 *
 * 89 -> 90 for AGENT_STAFFING_LAYER (task-05b0a693, the wrapper's durable
 * staffing fence). Declaring an exported layer constant is what this scan
 * counts, so a boundary must be rostered in the task that declares it — no
 * package test or repo-wide typecheck can see this gate.
 */
const EXPECTED_ROSTER_SIZE = 90;

/**
 * The nine-way per-area split. A scanner that silently matched only one directory
 * satisfies set-equality against a roster built from that same broken scan; only the
 * distribution catches it.
 */
const EXPECTED_DISTRIBUTION: Readonly<Record<string, number>> = Object.freeze({
  "apps/daemon": 34,
  "packages/benchmark": 1,
  "packages/runner": 20,
  "packages/core": 10,
  "packages/scheduler": 7,
  "packages/store": 4,
  "apps/control-room": 4,
  "packages/contracts": 3,
  "adapters/ide-contract": 2,
  "packages/review": 1,
  "packages/mcp": 1,
  "packages/import": 1,
  "packages/coordination": 1,
  "packages/control-room-client": 1,
});

/** Scan roots. Every workspace area that can declare a production boundary. */
const SCAN_ROOTS: readonly string[] = Object.freeze(["apps", "packages", "adapters"]);

/**
 * Line-anchored at column 0. The optional `(?::[^=]+)?` annotation group is the whole
 * point: a pattern demanding ` = ` right after the name misses every annotated constant,
 * which is how `PLATFORM_LINUX_LAYER: PlatformLayer` and its macOS sibling went
 * uncounted. Column-0 anchoring stops it matching prose in a doc comment; terminating on
 * `=` stops it matching a longer identifier by prefix.
 */
const DECLARATION_PATTERN = /^export const ([A-Z_]+(?:LAYERS|LAYER|BOUNDARIES))\s*(?::[^=]+)?=/u;

/**
 * Find the repo root by SEARCHING for the workspace marker, never by hop-counting — a
 * `../../..` join silently narrows the scan root the day this file moves, and a scan
 * rooted one directory too deep returns fewer constants while the roster still matches
 * whatever it found. Mirrors `packages/runner/src/platform/windows/windows-broker-path.ts`.
 */
function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsAsFile(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("repo root not found: no pnpm-workspace.yaml above this file");
    }
    current = parent;
  }
}

function existsAsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The exclusion rule, encoded as one predicate so a future loosening reddens here. */
function isProductionModule(relativePath: string): boolean {
  if (!relativePath.endsWith(".ts")) {
    return false;
  }
  if (relativePath.startsWith("packages/testkit/")) {
    return false;
  }
  return !(
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".spec.ts") ||
    relativePath.endsWith(".test-fixtures.ts") ||
    relativePath.endsWith("-fixtures.ts")
  );
}

/**
 * Collect production `.ts` files under one scan root. `node_modules` and dot-directories
 * are skipped, the latter load-bearing rather than cosmetic: `apps/daemon` currently
 * carries 21 committed `.project-configuration-smoke-<id>` probe directories, each
 * holding a `consumer.ts`, and scratch of that shape must never enter the roster.
 */
function collectProductionSources(directory: string, repoRoot: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectProductionSources(absolute, repoRoot, into);
      continue;
    }
    const relativePath = relative(repoRoot, absolute).replaceAll("\\", "/");
    if (isProductionModule(relativePath)) {
      into.push(relativePath);
    }
  }
}

/**
 * The live source scan. Reads real files every run — nothing is cached, so a rename in a
 * production module changes this result on the next run, which is what the bidirectional
 * comparison exists to notice. Paths come back repo-root-relative with forward slashes so
 * roster entry and scan result compare as plain strings on every platform.
 */
function scanDeclaredBoundaries(): readonly ScannedBoundary[] {
  const repoRoot = findRepoRoot();
  const sources: string[] = [];
  for (const area of SCAN_ROOTS) {
    collectProductionSources(join(repoRoot, area), repoRoot, sources);
  }
  const found: ScannedBoundary[] = [];
  for (const file of sources.sort()) {
    for (const line of readFileSync(join(repoRoot, file), "utf8").split("\n")) {
      const constant = DECLARATION_PATTERN.exec(line)?.[1];
      if (constant !== undefined) {
        found.push({ constant, file });
      }
    }
  }
  return found;
}

/**
 * Scanned once per run, not once per assertion: the walk touches ~600 files and eight
 * cases consult it. Still a live read of real source on every run, so a rename in a
 * production module is visible to the very next run — which is what the drills prove.
 */
const SCANNED: readonly ScannedBoundary[] = scanDeclaredBoundaries();

const keyOf = (entry: ScannedBoundary | RosterEntry): string => `${entry.constant}@${entry.file}`;

const areaOf = (file: string): string => file.split("/").slice(0, 2).join("/");

describe("declared-boundary roster", () => {
  it("holds exactly the corrected number of hand-written entries", () => {
    expect(BOUNDARY_ROSTER).toHaveLength(EXPECTED_ROSTER_SIZE);
  });

  it("has no duplicate entries", () => {
    const keys = BOUNDARY_ROSTER.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the expected per-area distribution", () => {
    const actual: Record<string, number> = {};
    for (const entry of BOUNDARY_ROSTER) {
      actual[areaOf(entry.file)] = (actual[areaOf(entry.file)] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_DISTRIBUTION);
  });

  it("sums the per-area distribution to the roster size", () => {
    const total = Object.values(EXPECTED_DISTRIBUTION).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(EXPECTED_ROSTER_SIZE);
  });
});

describe("roster versus live source scan", () => {
  it("scans a non-empty set of declarations", () => {
    expect(SCANNED.length).toBeGreaterThan(0);
  });

  it("names every scanned constant in the roster (scan minus roster is empty)", () => {
    const rostered = new Set(BOUNDARY_ROSTER.map(keyOf));
    expect(SCANNED.filter((found) => !rostered.has(keyOf(found))).map(keyOf)).toEqual([]);
  });

  it("has no roster entry absent from source (roster minus scan is empty)", () => {
    const scanned = new Set(SCANNED.map(keyOf));
    expect(BOUNDARY_ROSTER.filter((e) => !scanned.has(keyOf(e))).map(keyOf)).toEqual([]);
  });

  it("scans exactly the roster's cardinality", () => {
    expect(SCANNED).toHaveLength(EXPECTED_ROSTER_SIZE);
  });
});

describe("scanner exclusion rule", () => {
  it("excludes EXPECTED_REFUSAL_LAYERS from project-configuration.test-fixtures.ts", () => {
    expect(SCANNED.filter((e) => e.constant === "EXPECTED_REFUSAL_LAYERS")).toEqual([]);
  });

  it("excludes CORE_FAULT_BOUNDARIES from packages/testkit", () => {
    expect(SCANNED.filter((e) => e.constant === "CORE_FAULT_BOUNDARIES")).toEqual([]);
  });

  it("classifies the four exclusion shapes and keeps ordinary production modules", () => {
    expect(isProductionModule("packages/contracts/src/x.test-fixtures.ts")).toBe(false);
    expect(isProductionModule("packages/testkit/src/schedule/tables.ts")).toBe(false);
    expect(isProductionModule("packages/core/src/x.test.ts")).toBe(false);
    expect(isProductionModule("packages/core/src/x.spec.ts")).toBe(false);
    expect(isProductionModule("packages/core/src/goal/goal-results.ts")).toBe(true);
  });
});

describe("scanner matches the annotated declaration form", () => {
  it("returns PLATFORM_LINUX_LAYER, which a ` = `-only pattern misses", () => {
    const found = SCANNED.find((e) => e.constant === "PLATFORM_LINUX_LAYER");
    expect(found?.file).toBe("packages/runner/src/platform/linux-facts.ts");
  });

  it("returns PLATFORM_MACOS_LAYER, which a ` = `-only pattern misses", () => {
    const found = SCANNED.find((e) => e.constant === "PLATFORM_MACOS_LAYER");
    expect(found?.file).toBe("packages/runner/src/platform/macos/macos-facts.ts");
  });

  it("matches the annotated form directly against the pattern", () => {
    const annotated = 'export const A_LAYER: PlatformLayer = "x";';
    expect(DECLARATION_PATTERN.exec(annotated)?.[1]).toBe("A_LAYER");
    expect(DECLARATION_PATTERN.exec('export const B_LAYERS = ["x"];')?.[1]).toBe("B_LAYERS");
    expect(DECLARATION_PATTERN.exec(' * export const C_LAYER = "prose";')).toBeNull();
    expect(DECLARATION_PATTERN.exec("export const NOT_A_BOUNDARY = 1;")).toBeNull();
  });
});

describe("coverage axis partition", () => {
  it("tags every entry with exactly one axis from the closed set", () => {
    expect(BOUNDARY_ROSTER.filter((e) => !COVERAGE_AXES.includes(e.axis)).map(keyOf)).toEqual([]);
  });

  it("uses every axis at least once", () => {
    const used = new Set(BOUNDARY_ROSTER.map((entry) => entry.axis));
    expect([...COVERAGE_AXES].filter((axis) => !used.has(axis))).toEqual([]);
  });

  it("assigns each constant to exactly one axis", () => {
    const axesByKey = new Map<string, Set<CoverageAxis>>();
    for (const entry of BOUNDARY_ROSTER) {
      const axes = axesByKey.get(keyOf(entry)) ?? new Set<CoverageAxis>();
      axes.add(entry.axis);
      axesByKey.set(keyOf(entry), axes);
    }
    const doubled = [...axesByKey.entries()].filter(([, axes]) => axes.size > 1).map(([key]) => key);
    expect(doubled).toEqual([]);
  });

  it("partitions the roster: the five axis groups sum to the roster size", () => {
    const total = COVERAGE_AXES.reduce(
      (sum, axis) => sum + BOUNDARY_ROSTER.filter((entry) => entry.axis === axis).length,
      0,
    );
    expect(total).toBe(EXPECTED_ROSTER_SIZE);
  });
});

describe("hostile harness drivers are bounded", () => {
  afterAll(() => {
    cleanupHostileRoots();
  });

  const bound = { timeoutMs: 1_000, label: "harness-self-check" };

  it("probeBefore runs the probe first, then the effect", async () => {
    const order: string[] = [];
    const result = await probeBefore(
      bound,
      async () => {
        order.push("probe");
        return "p";
      },
      async () => {
        order.push("effect");
        return "e";
      },
    );
    expect(order).toEqual(["probe", "effect"]);
    expect(result).toEqual({ probe: "p", effect: "e" });
  });

  it("probeAfter runs the effect first, then the probe", async () => {
    const order: string[] = [];
    await probeAfter(
      bound,
      async () => order.push("effect"),
      async () => order.push("probe"),
    );
    expect(order).toEqual(["effect", "probe"]);
  });

  it("probeRacing records which leg settled first", async () => {
    const outcome = await probeRacing(
      bound,
      async () => "fast",
      async () => await new Promise((resolve) => setTimeout(() => resolve("slow"), 40)),
    );
    expect(outcome.firstSettled).toBe("left");
    expect(outcome.left).toEqual({ status: "fulfilled", value: "fast" });
    expect(outcome.right).toEqual({ status: "fulfilled", value: "slow" });
  });

  it("probeRacing reports a refusing leg as settled rather than propagating it", async () => {
    const refusal = new Error("leg refused");
    const outcome = await probeRacing(
      bound,
      async () => {
        throw refusal;
      },
      async () => await new Promise((resolve) => setTimeout(() => resolve("slow"), 40)),
    );
    expect(outcome.firstSettled).toBe("left");
    expect(outcome.left).toEqual({ status: "rejected", reason: refusal });
  });

  it("fails loudly when a probe outlives its bound, naming the stalled label", async () => {
    const stalled = probeBefore(
      { timeoutMs: 20, label: "never-settles" },
      async () => await new Promise(() => undefined),
      async () => "unreached",
    );
    await expect(stalled).rejects.toThrow(HostileBoundExceededError);
    await expect(stalled).rejects.toThrow(/never-settles/u);
  });

  it("refuses a bound above MAX_BOUND_MS instead of letting setTimeout clamp it to 1ms", async () => {
    const overflowed = probeBefore(
      { timeoutMs: MAX_BOUND_MS + 1, label: "too-wide" },
      async () => "p",
      async () => "e",
    );
    await expect(overflowed).rejects.toThrow(HostileHarnessMisuseError);
  });

  it("removes a temp root on the throwing exit path", async () => {
    let captured = "";
    await expect(
      withHostileRoot("throwing-case", async (root) => {
        captured = root;
        expect(existsSync(root)).toBe(true);
        throw new Error("case failed");
      }),
    ).rejects.toThrow("case failed");
    expect(captured).not.toBe("");
    expect(existsSync(captured)).toBe(false);
  });
});

describe("refusal helper pins code AND layer", () => {
  const refusal = { code: "PROJECT_CONFIGURATION_INPUT_INVALID", layer: "PROJECT_CONFIGURATION_MANIFEST" };

  it("accepts a refusal whose code and layer both match", () => {
    expect(() => {
      assertRefusedWith(refusal, { code: refusal.code, layer: refusal.layer });
    }).not.toThrow();
  });

  it("rejects a mismatched code", () => {
    expect(() => {
      assertRefusedWith(refusal, { code: "SOME_OTHER_CODE", layer: refusal.layer });
    }).toThrow(/refusal code mismatch/u);
  });

  it("rejects a matching code answered by the WRONG layer", () => {
    expect(() => {
      assertRefusedWith(refusal, { code: refusal.code, layer: "SOME_OTHER_LAYER" });
    }).toThrow(/refusal layer mismatch/u);
  });

  it("REJECTS an expectation carrying only a code, so the weak form cannot be used", () => {
    const layerBlind = { code: refusal.code } as unknown as RefusalExpectation;
    expect(() => {
      assertRefusedWith(refusal, layerBlind);
    }).toThrow(HostileHarnessMisuseError);
  });

  it("rejects an actual value carrying no layer, rather than passing on the code alone", () => {
    expect(() => {
      assertRefusedWith({ code: refusal.code }, { code: refusal.code, layer: refusal.layer });
    }).toThrow(/no string `layer`/u);
  });

  it("reads the reasonCode/reasonLayer spelling production also uses", () => {
    expect(() => {
      assertRefusedWith(
        { reasonCode: refusal.code, reasonLayer: refusal.layer },
        { code: refusal.code, layer: refusal.layer },
      );
    }).not.toThrow();
  });
});

export { BOUNDARY_ROSTER, COVERAGE_AXES, findRepoRoot, isProductionModule, SCAN_ROOTS };
export type { ScannedBoundary };
