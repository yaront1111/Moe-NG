import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describeThrown } from "@moe/contracts";

import type { NodeSpec } from "./http/affordance-contract.js";
import { COMPILED_EXECUTION_REF_PREFIX } from "./orchestrator/compiled-execution-ref.js";
import { isRepositoryWorkflowRef } from "./repository/repository-workflow-ref.js";

/**
 * File-authored node specs (`MOE_NODE_SPECS_DIR`), loaded for the affordance surface. Carved
 * out of the store composition so the two things that used to vanish here can be SAID:
 *
 * - a directory that cannot be read answered an empty list, so a mistyped path read as "this
 *   project has no nodes" and the wrapper reported nothing to staff;
 * - a spec that failed to parse, named no `nodeRef` or `title`, or used a reserved ref was
 *   dropped without a word.
 *
 * Both are still answered the same way — absence, never an invented node — and reported once
 * per distinct line through `report`, because the loader runs on every affordance read and a
 * line repeated per read would drown the plane.
 */

export type NodeSpecReport = (line: string) => void;

function reason(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "not an object";
  const { nodeRef, title } = parsed as { nodeRef?: unknown; title?: unknown };
  if (typeof nodeRef !== "string" || nodeRef.length === 0) return "nodeRef missing";
  if (nodeRef.startsWith(COMPILED_EXECUTION_REF_PREFIX)) return "COMPILED_EXECUTION_REF_RESERVED";
  if (isRepositoryWorkflowRef(nodeRef)) return "REPOSITORY_WORKFLOW_REF_RESERVED";
  if (typeof title !== "string") return "title missing";
  return null;
}

export function nodeSpecLoader(directory: string, report?: NodeSpecReport): () => readonly NodeSpec[] {
  const said = new Set<string>();
  const say = (line: string): void => {
    if (report === undefined || said.has(line)) return;
    said.add(line);
    try {
      report(line);
    } catch {
      // A failed diagnostic sink must not change what the surface answers.
    }
  };
  return () => {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch (error) {
      const thrown = describeThrown(error);
      say(`node specs directory unreadable: ${directory}: ${thrown.code ?? thrown.name}: ${thrown.message}`);
      return [];
    }
    const specs: NodeSpec[] = [];
    for (const name of entries.sort()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(directory, name), "utf8"));
      } catch (error) {
        say(`node spec skipped: ${name}: ${describeThrown(error).message}`);
        continue;
      }
      const why = reason(parsed);
      if (why !== null) {
        say(`node spec skipped: ${name}: ${why}`);
        continue;
      }
      const { nodeRef, title } = parsed as { nodeRef: string; title: string };
      // A file-authored spec carries no sealed build order — this format has no dependency
      // field to read — so it declares none rather than inventing one. Only compiled-graph
      // nodes can gate on dependencies.
      specs.push({ dependsOn: [], nodeRef, title });
    }
    return specs;
  };
}
