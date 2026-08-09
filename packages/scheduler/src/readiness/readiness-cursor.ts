/**
 * Builds the `FrontierCursor` that `partitionFrontier` is documented to wait
 * for, plus this area's refusal helpers.
 *
 * `NodeAvailabilityFact.admissionEligible` and `.dispatchAvailable` are
 * "supplied by the caller (never derived here)" (graph-model.ts:246-249) and
 * `false` must never encode UNKNOWN (graph-model.ts:256). Both hold here:
 *
 *  - When EVERY execution-bearing node has both folds CONFIRMED (either arm),
 *    each boolean is a faithful encoding of a confirmed caller fact and the
 *    resulting partition is publishable.
 *  - When any is UNKNOWN, the cursor switches to a UNIFORM structural sentinel
 *    — `false` for every node alike — which encodes no per-node claim at all.
 *    Only `logicalReady` and `blocked`, which frontier.ts derives from hard-edge
 *    facts before it reads any availability value, are then used; the partition
 *    itself is withheld so analysis widths stay UNKNOWN.
 */
import { dense, deepFreeze, record } from "../admission/admission-model.js";
import type { GraphIssueCode, NodeAvailabilityFact, ValidatedGraph } from "../graph-model.js";
import {
  parseNodeReadinessFacts,
  type NodeReadinessFacts,
} from "./readiness-facts.js";
import type {
  ReadinessIssue,
  ReadinessIssueCode,
  ReadinessWithholdReason,
} from "./readiness-model.js";

const INPUT_KEYS = ["hardEdgeFacts", "nodeFacts"] as const;

export interface ReadinessCursor {
  readonly hardEdgeFacts: unknown;
  readonly nodeAvailabilityFacts: readonly NodeAvailabilityFact[];
}

export type ReadinessCursorResult =
  | {
    readonly ok: true;
    readonly facts: ReadonlyMap<string, NodeReadinessFacts>;
    readonly cursor: ReadinessCursor;
    readonly withheld: ReadinessWithholdReason | null;
  }
  | { readonly ok: false; readonly issues: readonly ReadinessIssue[] };

export function makeReadinessIssue(
  code: ReadinessIssueCode | GraphIssueCode,
  message: string,
  nodeKeys: readonly string[] = [],
): ReadinessIssue {
  return deepFreeze({ code, message, nodeKeys: [...nodeKeys] });
}

export function refuseReadiness(
  issues: readonly ReadinessIssue[],
): { readonly ok: false; readonly issues: readonly ReadinessIssue[] } {
  const sorted = [...issues].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return deepFreeze({ ok: false, issues: sorted });
}

function parseBundles(
  graph: ValidatedGraph,
  value: unknown,
): { facts: Map<string, NodeReadinessFacts>; issues: ReadinessIssue[] } {
  const facts = new Map<string, NodeReadinessFacts>();
  const issues: ReadinessIssue[] = [];
  const entries = dense(value);
  if (entries === null) {
    issues.push(makeReadinessIssue("READINESS_INPUT_MALFORMED", "nodeFacts must be a bounded dense array"));
    return { facts, issues };
  }
  const nodeKeys = new Set(graph.nodes.map((node) => node.nodeKey));
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = parseNodeReadinessFacts(entries[index]);
    if (parsed === null) {
      issues.push(makeReadinessIssue("READINESS_INPUT_MALFORMED", `nodeFacts[${index}] is malformed`));
      continue;
    }
    if (!nodeKeys.has(parsed.nodeKey)) {
      issues.push(makeReadinessIssue(
        "READINESS_NODE_FACTS_UNKNOWN_NODE",
        `nodeFacts references unknown node "${parsed.nodeKey}"`,
        [parsed.nodeKey],
      ));
      continue;
    }
    if (facts.has(parsed.nodeKey)) {
      issues.push(makeReadinessIssue(
        "READINESS_NODE_FACTS_DUPLICATE",
        `duplicate fact bundle for node "${parsed.nodeKey}"`,
        [parsed.nodeKey],
      ));
      continue;
    }
    facts.set(parsed.nodeKey, parsed);
  }
  for (const node of graph.nodes) {
    if (!facts.has(node.nodeKey)) {
      issues.push(makeReadinessIssue(
        "READINESS_NODE_FACTS_MISSING",
        `no fact bundle supplied for node "${node.nodeKey}"`,
        [node.nodeKey],
      ));
    }
  }
  return { facts, issues };
}

/**
 * An execution-bearing node with an UNKNOWN fold is the only thing that can
 * withhold the partition. A non-execution-bearing node never enters any ready
 * set, so its unknowns can never narrow one.
 */
function withholdReason(
  graph: ValidatedGraph,
  facts: ReadonlyMap<string, NodeReadinessFacts>,
): ReadinessWithholdReason | null {
  for (const node of graph.nodes) {
    const supplied = facts.get(node.nodeKey);
    if (!node.executionBearing || supplied === undefined) {
      continue;
    }
    if (supplied.admission === "UNKNOWN" || supplied.dispatch === "UNKNOWN") {
      return "AVAILABILITY_UNKNOWN";
    }
  }
  return null;
}

export function buildReadinessCursor(
  graph: ValidatedGraph,
  input: unknown,
): ReadinessCursorResult {
  const item = record(input, INPUT_KEYS);
  if (item === null) {
    return refuseReadiness([
      makeReadinessIssue(
        "READINESS_INPUT_MALFORMED",
        "readiness input requires only own hardEdgeFacts and nodeFacts",
      ),
    ]);
  }
  const { facts, issues } = parseBundles(graph, item["nodeFacts"]);
  if (issues.length > 0) {
    return refuseReadiness(issues);
  }
  const withheld = withholdReason(graph, facts);
  const nodeAvailabilityFacts = graph.nodes.map((node) => {
    // An advisory/organizational node has NO execution authority (design 8.3
    // rule 5), so `false` is the confirmed truth about it rather than an
    // encoding of its (possibly UNKNOWN) facts. partitionFrontier skips these
    // nodes before it reads either value in any case.
    if (!node.executionBearing || withheld !== null) {
      return { nodeKey: node.nodeKey, admissionEligible: false, dispatchAvailable: false };
    }
    const supplied = facts.get(node.nodeKey)!;
    return {
      nodeKey: node.nodeKey,
      admissionEligible: supplied.admission === "CONFIRMED_TRUE",
      dispatchAvailable: supplied.dispatch === "CONFIRMED_TRUE",
    };
  });
  return {
    ok: true,
    facts,
    cursor: { hardEdgeFacts: item["hardEdgeFacts"], nodeAvailabilityFacts },
    withheld,
  };
}
