/**
 * LAYER-VISIBILITY CASES — the populations the declared-boundary roster does NOT enumerate.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, and the arms that
 * consume this module live in `boundary-roster.security.ts` beside the roster arms, which is
 * where a reader looking for an enumeration claim will look. This module only SCANS and
 * DECLARES; it judges nothing and asserts nothing.
 *
 * WHY IT EXISTS. `boundary-roster.security.ts` asserts "scan minus roster is empty" and a
 * cardinality of 168. Both are true, and both are narrower than they read: `DECLARATION_PATTERN`
 * is anchored `^export const`, so the claim covers EXPORTED declarations only. Two live
 * populations sit outside it, and neither was measured before this module landed.
 *
 *   MODULE-PRIVATE DECLARATIONS — a column-0 `const *_LAYER`. Structurally unreachable by an
 *   `^export const` anchor, and not dead code: ADMISSION_GATE_LAYER, GOAL_CATALOG_READ_LAYER,
 *   CUTOVER_ACTIVATION_MARKER_LAYER, PLANNING_RUN_READ_LAYER, DURABLE_STORE_LAYER (three
 *   product-contract sites) and the ten `apps/control-room/src/live/*` layers all stamp live
 *   refusals. Measured 60 at HEAD 6d0ce466.
 *
 *   BARE LITERALS AT THE REFUSAL SITE — a layer that is never a declaration at all, so no
 *   declaration pattern of any width can reach it. Bounded further down this module.
 *
 * WHAT THIS MODULE DOES NOT DO, stated so no one widens it. It does NOT backfill these into
 * `BOUNDARY_ROSTER`: that is 60 roster entries plus 60 BEFORE/AFTER/RACE arm sets, and
 * exporting a layer is precisely what today's incentive punishes — exporting costs a roster
 * entry, a distribution key, an axis tag and a set of arms, while not exporting costs nothing
 * and is invisible. It does NOT re-key the roster on emitted layer VALUES. Both are separate
 * rows. What it does is turn each blind spot into a DECLARED DECISION carrying an exact count
 * that reds when the population moves.
 *
 * THE ALLOWLISTS ARE ASSERTED IN BOTH DIRECTIONS, and that is not a stylistic preference. An
 * arm that iterates only its own allowlist shrinks with it: delete an entry and the arm stays
 * green while a live layer silently leaves the enumeration. That is the exact defect this
 * module exists to close, so reproducing it here would be self-defeating.
 *
 * NOTHING HERE IS COMPUTED AT MODULE INIT. `boundary-roster.security.ts` imports this module
 * and this module imports it back; the cycle is safe only while every scan stays inside a
 * function body, so a top-level `const X = scanPrivateLayerDeclarations()` would hit the
 * temporal dead zone on `findRepoRoot`. The scans are lazy and memoized instead.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  DECLARATION_PATTERN,
  findRepoRoot,
  isProductionModule,
  SCAN_ROOTS,
} from "./boundary-roster.security.js";

/** One layer declaration: the constant's name and the production module that declares it. */
interface LayerDeclaration {
  readonly constant: string;
  readonly file: string;
}

/**
 * The module-private twin of `DECLARATION_PATTERN`. It differs from the exported pattern in
 * exactly ONE token — the missing `export ` — so a reader can see that the ANCHOR, not the
 * character class, is what hides these sixty. Same `[A-Z0-9_]+` width, same optional type
 * annotation group, same column-0 anchoring that stops it matching prose in a doc comment.
 */
const PRIVATE_DECLARATION_PATTERN = /^const ([A-Z0-9_]+(?:LAYERS|LAYER|BOUNDARIES))\s*(?::[^=]+)?=/u;

/** The token whose absence is the ONLY difference between the two patterns. */
const EXPORT_ANCHOR = "^export const ";

/**
 * The exported pattern's source with the `export ` token removed — what
 * `PRIVATE_DECLARATION_PATTERN` must equal. Asserted rather than commented, because the two
 * literals are in different files and a widened exported class would otherwise leave the
 * private twin narrow, silently shrinking the private population instead of reddening.
 *
 * LAZY BY NECESSITY. `DECLARATION_PATTERN` is declared far below the import statement that
 * pulls this module in, so at THIS module's init it is still in the temporal dead zone.
 * Reading it inside a function defers the access to test time, when the cycle has settled.
 */
function derivedPrivatePatternSource(): string {
  const exported = DECLARATION_PATTERN.source;
  if (!exported.startsWith(EXPORT_ANCHOR)) {
    throw new Error(`DECLARATION_PATTERN no longer starts with ${EXPORT_ANCHOR}: ${exported}`);
  }
  return `^const ${exported.slice(EXPORT_ANCHOR.length)}`;
}

/** Keyed the way `boundary-roster.security.ts` keys a roster entry, so the two populations compare. */
const keyOfDeclaration = (entry: LayerDeclaration): string => `${entry.constant}@${entry.file}`;

function collectInto(directory: string, repoRoot: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectInto(absolute, repoRoot, into);
      continue;
    }
    const relativePath = relative(repoRoot, absolute).replaceAll("\\", "/");
    if (isProductionModule(relativePath)) {
      into.push(relativePath);
    }
  }
}

let productionSourceCache: readonly string[] | undefined;

/**
 * The same file set the roster scans, reached through the roster's OWN exported
 * `isProductionModule` and `SCAN_ROOTS` rather than through a second copy of the exclusion
 * rule — a private reimplementation would drift from the surface it is meant to be measuring.
 */
function productionSources(): readonly string[] {
  if (productionSourceCache === undefined) {
    const repoRoot = findRepoRoot();
    const files: string[] = [];
    for (const area of SCAN_ROOTS) {
      collectInto(join(repoRoot, area), repoRoot, files);
    }
    productionSourceCache = files.sort();
  }
  return productionSourceCache;
}

let privateScanCache: readonly LayerDeclaration[] | undefined;

/**
 * Live scan of module-private layer declarations. Reads real files on the first call, so a new
 * `const FOO_LAYER` in any production module is visible to the very next run — which is what
 * the scan-minus-allowlist direction exists to notice.
 */
function scanPrivateLayerDeclarations(): readonly LayerDeclaration[] {
  if (privateScanCache === undefined) {
    const repoRoot = findRepoRoot();
    const found: LayerDeclaration[] = [];
    for (const file of productionSources()) {
      for (const line of readFileSync(join(repoRoot, file), "utf8").split("\n")) {
        const constant = PRIVATE_DECLARATION_PATTERN.exec(line)?.[1];
        if (constant !== undefined) {
          found.push({ constant, file });
        }
      }
    }
    privateScanCache = found;
  }
  return privateScanCache;
}

/**
 * Stated at the WIDE pattern width (`[A-Z0-9_]+`). The narrow `[A-Z_]+` width measures 61 at
 * this HEAD; the single wide-only name is PRODUCT_CONTRACT_GATE_1_READ_LAYER, hidden twice
 * over — module-private AND digit-bearing. Quoting a private count against an exported count
 * of a DIFFERENT width is the recurring error in this area, so every ratio built on this
 * constant must name the width it measures.
 */
const EXPECTED_PRIVATE_COUNT = 66;

/**
 * The frozen census, measured at HEAD 6d0ce466 through `isProductionModule` + `SCAN_ROOTS`,
 * plus the two control-room layers PR #16 (d49c9c17) added: LIVE_GOAL_SOURCE_LAYER and
 * POLICY_INSTALL_LAYER, absorbed at the 20d28fbe merge.
 * An ALLOWLIST OF KNOWN-INVISIBLE BOUNDARIES, not an approval of the invisibility: its job is
 * to make the population a number that cannot move without an arm going red.
 */
const UNSCANNED_PRIVATE_LAYERS: readonly LayerDeclaration[] = Object.freeze([
  { constant: "ACTIVATION_RECEIPTS_LAYER", file: "apps/daemon/src/bootstrap/activation-receipts.ts" },
  { constant: "ADMISSION_GATE_LAYER", file: "apps/daemon/src/activation/admission-gate-resolver.ts" },
  { constant: "AUTHORITY_LAYER", file: "packages/benchmark/src/confirmatory-freeze-authority-contracts.ts" },
  { constant: "BINDING_LAYER", file: "apps/daemon/src/activation/activation-budget-binding.ts" },
  { constant: "BOUNDED_JSON_CODEC_LAYER", file: "apps/daemon/src/cutover/cutover-generation-snapshot.ts" },
  { constant: "BUDGET_COMMITMENT_READ_LAYER", file: "apps/daemon/src/http/budget-commitment-read.ts" },
  { constant: "BUILD_LAYER", file: "apps/control-room/src/v2/approvals/offer-wire.ts" },
  { constant: "CODEC_LAYER", file: "apps/daemon/src/provider-profile/provider-profile-codec.ts" },
  { constant: "CODE_LAYERS", file: "apps/control-room/src/approvals/approval-gating.ts" },
  { constant: "CODE_LAYERS", file: "packages/core/src/expansion/expansion-planning-hold.ts" },
  { constant: "COMPLETION_LAYER", file: "apps/daemon/src/work/foundation-launch-completion-wiring.ts" },
  { constant: "COVERAGE_LAYER", file: "apps/daemon/src/budget/budget-coverage-reader.ts" },
  { constant: "CUTOVER_ACTIVATION_MARKER_LAYER", file: "apps/daemon/src/cutover/cutover-activation-marker.ts" },
  { constant: "CUTOVER_LAYER", file: "packages/core/src/cutover/cutover-reducer.ts" },
  { constant: "CUTOVER_QUIESCE_RECORD_READER_LAYER", file: "apps/daemon/src/cutover/cutover-quiesce-record-reader.ts" },
  { constant: "DURABLE_READ_LAYER", file: "apps/daemon/src/review/reviewer-calibration-record.ts" },
  { constant: "DURABLE_STORE_LAYER", file: "apps/daemon/src/product-contract/product-contract-gate-1-reader.ts" },
  { constant: "DURABLE_STORE_LAYER", file: "apps/daemon/src/product-contract/product-contract-revision-reader.ts" },
  { constant: "DURABLE_STORE_LAYER", file: "apps/daemon/src/product-contract/product-contract-revision-store.ts" },
  { constant: "ESCALATION_LAYER", file: "apps/control-room/src/v2/approvals/escalation-port.ts" },
  { constant: "EVIDENCE_LAYER", file: "apps/daemon/src/planning/graph-decision-evidence.ts" },
  { constant: "EVIDENCE_LAYER", file: "apps/daemon/src/work/release-terminal-evidence-contracts.ts" },
  { constant: "FOUNDATION_INPUT_HYDRATOR_LAYER", file: "apps/daemon/src/work/foundation-input-hydrator.ts" },
  { constant: "FOUNDATION_RECEIPTS_LAYER", file: "apps/daemon/src/host/foundation-receipts.ts" },
  { constant: "GATE_LAYER", file: "packages/core/src/planning/approval-authority.ts" },
  { constant: "GOAL_CATALOG_READ_LAYER", file: "apps/daemon/src/http/goal-catalog-read.ts" },
  { constant: "GOAL_CLOSE_LAYER", file: "apps/control-room/src/v2/approvals/goal-close-port.ts" },
  { constant: "REPLAN_LAYER", file: "apps/control-room/src/v2/approvals/replan-successor-port.ts" },
  { constant: "GRAPH_LAYER", file: "packages/scheduler/src/node-authority/node-authority-recursion.ts" },
  { constant: "GRAPH_QUERY_LAYER", file: "apps/daemon/src/planning/graph-query.ts" },
  { constant: "HISTORY_LAYER", file: "apps/daemon/src/planning/supersession-preparation-history.ts" },
  { constant: "LAUNCH_LIMITS_LAYER", file: "packages/runner/src/providers/claude/claude-launcher-input.ts" },
  { constant: "LEDGER_LAYER", file: "apps/daemon/src/budget/budget-ledger-contracts.ts" },
  { constant: "LEDGER_LAYER", file: "apps/daemon/src/work/effect-terminal-contracts.ts" },
  { constant: "LIVE_ACTIVITY_LAYER", file: "apps/control-room/src/live/live-activity.ts" },
  { constant: "LIVE_COVERAGE_LAYER", file: "apps/control-room/src/live/live-document-coverage.ts" },
  { constant: "LIVE_DOCUMENT_LAYER", file: "apps/control-room/src/live/live-document-dossier.ts" },
  { constant: "LIVE_DOCUMENT_LAYER", file: "apps/control-room/src/live/live-document-ingest.ts" },
  { constant: "LIVE_GOAL_SOURCE_LAYER", file: "apps/control-room/src/live/live-goal-source.ts" },
  { constant: "LIVE_OPS_LAYER", file: "apps/control-room/src/live/live-ops.ts" },
  { constant: "LIVE_PLANNING_LAYER", file: "apps/control-room/src/live/live-planning-run.ts" },
  { constant: "LIVE_RUNS_LAYER", file: "apps/control-room/src/live/live-runs.ts" },
  { constant: "LIVE_SESSIONS_LAYER", file: "apps/control-room/src/live/live-sessions.ts" },
  { constant: "NODE_CLOSURE_READER_LAYER", file: "apps/daemon/src/planning/node-closure-reader.ts" },
  { constant: "OBSERVATION_CODEC_LAYER", file: "apps/daemon/src/provider-profile/provider-runtime-observation.ts" },
  { constant: "OBSERVATION_READER_LAYER", file: "apps/daemon/src/provider-profile/provider-runtime-observation-reader.ts" },
  { constant: "PLANNING_RUN_READ_LAYER", file: "apps/daemon/src/http/planning-run-read.ts" },
  { constant: "POLICY_INSTALL_LAYER", file: "apps/control-room/src/v2/ops/policy-install-port.ts" },
  { constant: "PUBLISH_LAYER", file: "apps/control-room/src/v2/goals/publish-port.ts" },
  { constant: "PRODUCER_LAYER", file: "apps/daemon/src/work/launch-template-authority.ts" },
  { constant: "PRODUCT_CONTRACT_GATE_1_READ_LAYER", file: "apps/daemon/src/http/product-contract-gate-1-read.ts" },
  { constant: "PROJECTION_LAYER", file: "apps/daemon/src/budget/budget-ledger-contracts.ts" },
  { constant: "READER_LAYER", file: "apps/daemon/src/product-contract/product-contract-gate-1-reader.ts" },
  { constant: "READER_LAYER", file: "apps/daemon/src/product-contract/product-contract-revision-reader.ts" },
  { constant: "PRODUCT_CONTRACT_READ_LAYER", file: "apps/daemon/src/product-contract/product-contract-read-port.ts" },
  { constant: "READER_LAYER", file: "apps/daemon/src/provider-profile/provider-profile-reader-checks.ts" },
  { constant: "READ_LAYER", file: "apps/daemon/src/telemetry/provider-run-reader-bindings.ts" },
  { constant: "RECURSION_LAYER", file: "packages/scheduler/src/node-authority/node-authority-recursion.ts" },
  { constant: "REGISTRATION_LAYER", file: "apps/daemon/src/provider-profile/provider-profile-codec.ts" },
  { constant: "RUNNER_SCOPE_LAYER", file: "apps/daemon/src/work/foundation-input-hydrator.ts" },
  { constant: "SECTION_LAYER", file: "apps/daemon/src/work/launch-runtime-section.ts" },
  { constant: "SESSION_CHALLENGE_OPERANDS_READ_LAYER", file: "apps/daemon/src/http/session-challenge-operands-read.ts" },
  { constant: "SET_LAYER", file: "packages/scheduler/src/supersession/supersession-dispositions.ts" },
  { constant: "TRANSPORT_LAYER", file: "apps/control-room/src/v2/approvals/offer-wire.ts" },
  { constant: "WRITER_LAYER", file: "apps/daemon/src/product-contract/product-contract-revision-store.ts" },
  { constant: "WRITER_LAYER", file: "apps/daemon/src/product-contract/product-contract-v2-store.ts" },
]);

/**
 * BARE LITERALS AT THE REFUSAL SITE — the class no declaration pattern of any width can reach,
 * because there is no declaration. Two shapes are scanned:
 *
 *   PROPERTY POSITION — `layer: "X"` / `refusedBy: "X"`. Keyed on the property name rather than
 *   on ALL-CAPS text, because an ALL-CAPS literal grep over production returns thousands of
 *   candidates and settles nothing.
 *
 *   POSITIONAL ARGUMENT — `new DomainRefusal("CODE", "LAYER", …)`. Added because the canonical
 *   pair lives HERE and nowhere else: daemon-command-registry.ts passes "DAEMON_AUTHORIZATION"
 *   and "DAEMON_COMPOSITION" positionally, and DAEMON_COMPOSITION appears at no `layer:`
 *   property in ANY production module. A property-position-only scan reports it as
 *   non-existent while it stamps a live refusal — so omitting this shape would have made the
 *   "bare-literal class is bounded" claim exclude its own headline example.
 *
 * COMMENT LINES ARE STRIPPED BEFORE MATCHING, and that is load-bearing rather than tidy:
 * live-dispatch.ts:60 discusses `layer: "this run is bound to no goal"` in prose, and without
 * the strip that sentence enters the census as a layer. It is the same failure the exported
 * pattern's column-0 anchor exists to prevent.
 */
const LAYER_LITERAL_PATTERN = /(?:^|[^A-Za-z0-9_])(?:layer|refusedBy):\s*"([^"]+)"/gu;
const POSITIONAL_REFUSAL_PATTERN = /new DomainRefusal\(\s*"[^"]+",\s*"([^"]+)"/gsu;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/** One literal layer value and every production module that spells it. */
interface LayerLiteral {
  readonly value: string;
  readonly files: readonly string[];
}

const stripComments = (raw: string): string =>
  raw
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");

let literalScanCache: readonly LayerLiteral[] | undefined;

/** Distinct literal layer values across production sources, sorted, with their sites. */
function scanLayerLiterals(): readonly LayerLiteral[] {
  if (literalScanCache === undefined) {
    const repoRoot = findRepoRoot();
    const byValue = new Map<string, Set<string>>();
    for (const file of productionSources()) {
      const code = stripComments(readFileSync(join(repoRoot, file), "utf8"));
      for (const pattern of [LAYER_LITERAL_PATTERN, POSITIONAL_REFUSAL_PATTERN]) {
        for (const match of code.matchAll(pattern)) {
          const value = match[1] as string;
          const sites = byValue.get(value) ?? new Set<string>();
          sites.add(file);
          byValue.set(value, sites);
        }
      }
    }
    literalScanCache = [...byValue.entries()]
      .map(([value, sites]) => ({ value, files: [...sites].sort() }))
      .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
  }
  return literalScanCache;
}

let declaredValueCache: ReadonlySet<string> | undefined;

/**
 * The VALUES on the right-hand side of every layer declaration, exported and module-private
 * alike. A literal equal to a declared layer's value is already covered by the roster or by
 * `UNSCANNED_PRIVATE_LAYERS` and is NOT a finding; resolving against values rather than against
 * constant NAMES is the whole difference between measuring the gap and re-listing the roster.
 */
function declaredLayerValues(): ReadonlySet<string> {
  if (declaredValueCache === undefined) {
    const repoRoot = findRepoRoot();
    const values = new Set<string>();
    for (const file of productionSources()) {
      const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const declares =
          DECLARATION_PATTERN.exec(line) !== null || PRIVATE_DECLARATION_PATTERN.exec(line) !== null;
        if (!declares) {
          continue;
        }
        let block = line;
        for (let next = index + 1; next < lines.length && !block.includes(";"); next += 1) {
          block += `\n${lines[next] ?? ""}`;
        }
        for (const match of block.matchAll(/"([^"]+)"/gu)) {
          values.add(match[1] as string);
        }
      }
    }
    declaredValueCache = values;
  }
  return declaredValueCache;
}

/** Literal values that match NO declared layer value. Measured 29 of 94 at HEAD 6d0ce466. */
const unresolvedLayerLiterals = (): readonly string[] => {
  const declared = declaredLayerValues();
  return scanLayerLiterals()
    .map((literal) => literal.value)
    .filter((value) => !declared.has(value));
};

/**
 * Literal values that DO match a declared layer value. Computed independently rather than as
 * `total - unresolved`: a subtraction makes `resolved + unresolved === total` an identity that
 * holds no matter what the scan does, so the partition arm would assert nothing beyond the
 * total it already pins. Computed as its own filter, the sum is a real cross-check — a literal
 * that fell out of BOTH filters, or landed in both, breaks it.
 */
const resolvedLayerLiterals = (): readonly string[] => {
  const declared = declaredLayerValues();
  return scanLayerLiterals()
    .map((literal) => literal.value)
    .filter((value) => declared.has(value));
};

const EXPECTED_LITERAL_COUNT = 94;
const EXPECTED_UNRESOLVED_LITERAL_COUNT = 29;

/**
 * The frozen unresolved census. THE ALLOWLIST IS THE DELIVERABLE, NOT A TODO: closing these
 * — by naming each as a constant, or by re-keying the roster on emitted values — is a separate
 * row, and doing it here would drag in the 60-entry backfill this module exists to avoid.
 * `live-quiesce-actor` is lower-case on purpose: it is a real literal layer value in
 * `cutover-quiesce-evidence.ts`, and an ALL-CAPS-shaped census would have missed it.
 */
const UNRESOLVED_LAYER_LITERALS: readonly string[] = Object.freeze([
  "CARRY_EVIDENCE_ASSEMBLER",
  "CONFIRMATORY_FREEZE_GIT",
  "CONFIRMATORY_FREEZE_MANIFEST_ADMISSION",
  "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT",
  "CONTEXT_SELECTION",
  "CONTINUATION",
  "CONTROL_ROOM_PRESENTATION",
  "CONTROL_ROOM_PROJECT_HOME",
  "DAEMON",
  "DAEMON_APPROVAL_INTENT",
  "DAEMON_AUTHORIZATION",
  "DAEMON_COMPOSITION",
  "DAEMON_FOUNDATION_ATTEMPT",
  "DAEMON_GRAPH_INGRESS",
  "DAEMON_POLICY_AUTHORITY",
  "DAEMON_STEP_LIFECYCLE",
  "DAEMON_SUPERSESSION_POLICY_DECISION",
  "DEAD_END_JOURNAL",
  "DELIVERY_V2_NODE_PLANNING_SOURCE_RECORD",
  "DOCTOR",
  "EXPANSION_REQUEST_SERVICE",
  "FOUNDATION_CONTEXT_SEAL",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY",
  // The preview receipt/capture read routes' answer stamp (apps/daemon/src/http/preview-read.ts,
  // preview-capture-route.ts). Same class as every other `/*/read` route: a module-private
  // `const LAYER = "..."`, deliberately NOT a `*_LAYER` constant, so it owes the boundary roster
  // no entry and appears here instead. Registered by
  // task-4a6e7bdbef9a4344829a7ce49c6fb378 when it landed the routes.
  "PREVIEW_READ",
  "RELEASE_HANDOFF",
  "RETRY_PREDICATE",
  "REVIEW_KERNEL",
  "RUN_POLICY",
  "SCHEDULER_RESOURCE_AUTHORITY",
  "live-quiesce-actor",
]);

/** A top-level repo directory that declares layers and is NOT scanned, with why. */
interface UnscannedRoot {
  readonly directory: string;
  readonly reason: string;
  /** True when the directory need not exist — asserting its presence would be checkout-dependent. */
  readonly optional: boolean;
}

/**
 * ESCAPE (4): A LAYER DECLARED OUTSIDE `SCAN_ROOTS`. Three top-level directories declare layers
 * today and are not scanned, and each is a decision rather than an oversight.
 *
 * The step text asked for "no top-level directory containing production TypeScript sits outside
 * SCAN_ROOTS". Measured at HEAD 6d0ce466 that is FALSE on arrival — `dist`, `tests` and `tools`
 * all hold `.ts` that `isProductionModule` accepts, so the arm would red the day it landed and
 * would have to be deleted rather than fixed. What is asserted instead is the guard that
 * clause was reaching for: any DECLARING directory outside `SCAN_ROOTS` must be on this list,
 * so a NEW root cannot open silently, and every non-optional entry must still declare, so the
 * list cannot rot into a blanket exemption.
 */
const UNSCANNED_PRODUCTION_ROOTS: readonly UnscannedRoot[] = Object.freeze([
  {
    directory: "dist",
    reason: "gitignored build output; its .d.ts re-emit is not a source of truth",
    optional: true,
  },
  { directory: "tests", reason: "the test tree, excluded from the roster by design", optional: false },
  { directory: "tools", reason: "repo tooling, not a shipped refusal surface", optional: false },
]);

/** Top-level repo directories, `node_modules` and dot-directories excluded. */
function topLevelDirectories(): readonly string[] {
  return readdirSync(findRepoRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}

/** Top-level directories holding at least one layer declaration, exported or module-private. */
function declaringTopLevelDirectories(): readonly string[] {
  const repoRoot = findRepoRoot();
  const declaring: string[] = [];
  for (const directory of topLevelDirectories()) {
    const files: string[] = [];
    collectInto(join(repoRoot, directory), repoRoot, files);
    const declares = files.some((file) =>
      readFileSync(join(repoRoot, file), "utf8")
        .split("\n")
        .some(
          (line) =>
            DECLARATION_PATTERN.exec(line) !== null || PRIVATE_DECLARATION_PATTERN.exec(line) !== null,
        ),
    );
    if (declares) {
      declaring.push(directory);
    }
  }
  return declaring;
}

export {
  declaredLayerValues,
  declaringTopLevelDirectories,
  derivedPrivatePatternSource,
  EXPECTED_LITERAL_COUNT,
  EXPECTED_UNRESOLVED_LITERAL_COUNT,
  resolvedLayerLiterals,
  scanLayerLiterals,
  topLevelDirectories,
  UNRESOLVED_LAYER_LITERALS,
  UNSCANNED_PRODUCTION_ROOTS,
  unresolvedLayerLiterals,
  EXPECTED_PRIVATE_COUNT,
  keyOfDeclaration,
  PRIVATE_DECLARATION_PATTERN,
  productionSources,
  scanPrivateLayerDeclarations,
  UNSCANNED_PRIVATE_LAYERS,
};
export type { LayerDeclaration };
