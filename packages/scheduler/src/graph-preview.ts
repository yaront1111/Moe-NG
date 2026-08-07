import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { deepFreeze, makeIssue } from "./graph-internal.js";
import { computeGraphPreviewIdentity } from "./graph-preview-identity.js";
import {
  hasOnlyOwnStringKeys,
  isPlainRecord,
  readOwnDataProperty,
} from "./runtime-shape.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { FrontierPartition } from "./graph-model.js";
import type {
  GraphPreviewOptions,
  GraphPreviewOptionsInvalid,
  GraphPreviewResult,
} from "./graph-preview-model.js";

const OPTION_KEYS = Object.freeze([
  "frontierCursor",
  "policyOverride",
] as const);

type ParsedOptions =
  | GraphPreviewOptionsInvalid
  | {
    readonly ok: true;
    readonly frontierSupplied: boolean;
    readonly frontierCursor: unknown;
    readonly policyOverride: unknown;
  };

/**
 * Compose validation, optional frontier partitioning, and structural analysis.
 *
 * This is a pure advisory calculation over supplied values. It never stores or
 * mutates a graph, grants approval/admission/dispatch authority, or turns a
 * structural observation into a semantic dependency verdict. An omitted or
 * undefined options.frontierCursor means facts were absent and readiness
 * widths remain null. Any other supplied value is validated and fails closed.
 * External adapters must reject bodies over 1 MiB before parsing and enforce
 * the design's depth and string caps before invoking this bounded-value API.
 */
export function previewGraphSnapshot(
  snapshot: unknown,
  options?: GraphPreviewOptions,
): GraphPreviewResult {
  const parsed = parseOptions(options);
  if (!parsed.ok) {
    return parsed;
  }

  const validation = validateGraphSnapshot(snapshot, parsed.policyOverride);
  if (!validation.ok) {
    const outcome = validation.issues.some(
      (issue) => issue.code === "GRAPH_MALFORMED_POLICY",
    )
      ? "POLICY_INVALID"
      : "GRAPH_INVALID";
    return deepFreeze({
      advisoryOnly: true,
      authority: "NONE",
      issues: validation.issues,
      ok: false,
      outcome,
    });
  }

  let frontier: FrontierPartition | undefined;
  let frontierFacts: "ABSENT" | "CALLER_SUPPLIED_UNVERIFIED" = "ABSENT";
  if (parsed.frontierSupplied) {
    frontierFacts = "CALLER_SUPPLIED_UNVERIFIED";
    const partitioned = partitionFrontier(
      validation.graph,
      parsed.frontierCursor,
    );
    if (!partitioned.ok) {
      return deepFreeze({
        advisoryOnly: true,
        authority: "NONE",
        graphIdentity: validation.graph.graphIdentity,
        issues: partitioned.issues,
        ok: false,
        outcome: "FRONTIER_INVALID",
      });
    }
    frontier = partitioned.partition;
  }

  return deepFreeze({
    advisoryOnly: true,
    analysis: analyzeGraphStructure(validation.graph, frontier),
    authority: "NONE",
    frontierFacts,
    graphIdentity: validation.graph.graphIdentity,
    ok: true,
    outcome: "ANALYZED",
    previewIdentity: computeGraphPreviewIdentity(validation.graph, frontier),
  });
}

function parseOptions(options: GraphPreviewOptions | undefined): ParsedOptions {
  if (options === undefined) {
    return {
      frontierCursor: undefined,
      frontierSupplied: false,
      ok: true,
      policyOverride: undefined,
    };
  }
  if (!isPlainRecord(options) || !hasOnlyOwnStringKeys(options, OPTION_KEYS)) {
    return malformedOptions();
  }

  const frontier = readOwnDataProperty(options, "frontierCursor");
  const policy = readOwnDataProperty(options, "policyOverride");
  if (!frontier.ok || !policy.ok) {
    return malformedOptions();
  }
  return {
    frontierCursor: frontier.present ? frontier.value : undefined,
    frontierSupplied: frontier.present && frontier.value !== undefined,
    ok: true,
    policyOverride: policy.present ? policy.value : undefined,
  };
}

function malformedOptions(): GraphPreviewOptionsInvalid {
  return deepFreeze({
    advisoryOnly: true,
    authority: "NONE",
    issues: [
      makeIssue(
        "GRAPH_PREVIEW_MALFORMED_OPTIONS",
        "preview options require only own policyOverride and frontierCursor data properties",
        [],
        [],
      ),
    ],
    ok: false,
    outcome: "OPTIONS_INVALID",
  });
}
