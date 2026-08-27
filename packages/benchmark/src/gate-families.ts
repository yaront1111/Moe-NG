export type GateFamilyId =
  | "repository"
  | "property"
  | "fault"
  | "security"
  | "migration"
  | "integration"
  | "e2e"
  | "packaging"
  | "benchmark"
  | "independent-review";

type ExecutableGateFamilyId = Exclude<GateFamilyId, "independent-review">;

export interface ExecutableGateFamily {
  readonly id: ExecutableGateFamilyId;
  readonly commands: readonly string[];
  readonly packageLeg: string | null;
  readonly packageScript: string | null;
}

export interface IndependentReviewGateFamily {
  readonly id: "independent-review";
  readonly command: null;
  readonly commands: readonly [];
  readonly packageLeg: null;
  readonly packageScript: null;
  readonly reason: string;
}

export type GateFamily = ExecutableGateFamily | IndependentReviewGateFamily;

export interface CompositeScript {
  readonly script: string;
  readonly composes: readonly string[];
}

export interface ExcludedScript {
  readonly script: string;
  readonly reason: string;
}

function family(
  id: ExecutableGateFamilyId,
  commands: readonly string[],
  packageLeg: string | null = null,
  packageScript: string | null = null,
): ExecutableGateFamily {
  return Object.freeze({
    commands: Object.freeze([...commands]),
    id,
    packageLeg,
    packageScript,
  });
}

function composite(script: string, composes: readonly string[]): CompositeScript {
  return Object.freeze({ composes: Object.freeze([...composes]), script });
}

function excluded(script: string, reason: string): ExcludedScript {
  return Object.freeze({ reason, script });
}

/**
 * Root script ownership is intentionally separate from composition. A direct gate leg
 * has one family even when a composite invokes it; composite wrappers are recorded below.
 */
export const GATE_FAMILIES: readonly GateFamily[] = Object.freeze([
  family("repository", ["typecheck", "test", "test:meta", "test:store"]),
  family("property", ["test:property"]),
  family("fault", ["test:fault"]),
  family("security", ["test:security"]),
  family("migration", ["test:migration"]),
  family("integration", ["test:integration", "typecheck:import"]),
  family("e2e", ["test:e2e", "test:e2e:browser"]),
  family("packaging", [
    "pack:windows",
    "typecheck:packaging",
    "release:observe-windows-pack",
    "typecheck:release",
    "release:evidence",
  ]),
  family("benchmark", [], "@moe/benchmark", "test"),
  Object.freeze({
    command: null,
    commands: Object.freeze([]) as readonly [],
    id: "independent-review",
    packageLeg: null,
    packageScript: null,
    reason: "a human/third-party act with no repository command",
  }),
]);

/**
 * These wrappers add no family: their leaf scripts retain the ownership above. The
 * test:integration overlap is explicit because it is both the integration gate and a
 * wrapper around packaging/import checks plus non-script test legs.
 */
export const COMPOSITE_SCRIPTS: readonly CompositeScript[] = Object.freeze([
  composite("verify:foundation", ["typecheck", "test:meta"]),
  composite("verify:store", ["typecheck", "test:store"]),
  composite("verify:release", ["typecheck:release", "test:integration", "release:evidence"]),
  composite("test:integration", ["typecheck:packaging", "typecheck:import"]),
]);

export const EXCLUDED_SCRIPTS: readonly ExcludedScript[] = Object.freeze([
  excluded("start", "runtime launcher; it does not verify a repository gate"),
  excluded("seed", "runtime fixture launcher; it does not verify a repository gate"),
]);
