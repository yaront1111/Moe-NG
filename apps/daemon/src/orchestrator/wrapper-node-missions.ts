import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NodeMission } from "./agent-wrapper.js";
import { COMPILED_EXECUTION_REF_PREFIX } from "./compiled-execution-ref.js";
import { listNodeSpecs } from "./node-spec-listing.js";

interface WrapperNodeMissionsConfig {
  readonly nodeSpecsDir?: string | undefined;
  readonly compiled: () => {
    mission(nodeRef: string): NodeMission | null;
    nodes(): readonly { nodeRef: string }[];
  } | null;
  readonly log: (line: string) => void;
}

/** Operator specs and sealed graph identities have disjoint execution namespaces. */
export function createWrapperNodeMissions(config: WrapperNodeMissionsConfig) {
  const specMission = (nodeRef: string): NodeMission | null => {
    if (nodeRef.startsWith(COMPILED_EXECUTION_REF_PREFIX) || config.nodeSpecsDir === undefined) return null;
    let names: string[];
    try { names = readdirSync(config.nodeSpecsDir).filter((name) => name.endsWith(".json")); }
    catch { return null; }
    for (const name of names) {
      try {
        const spec = JSON.parse(readFileSync(join(config.nodeSpecsDir, name), "utf8")) as Partial<NodeMission> & { nodeRef?: string };
        if (spec.nodeRef !== nodeRef) continue;
        if (typeof spec.instructions !== "string" || typeof spec.test !== "string" || typeof spec.workspace !== "string"
          || (spec.title !== undefined && typeof spec.title !== "string")) return null;
        return { instructions: spec.instructions, test: spec.test, title: spec.title ?? nodeRef, workspace: spec.workspace };
      } catch { /* The list reader reports malformed files. They grant no mission. */ }
    }
    return null;
  };
  const nodeMission = (nodeRef: string): NodeMission | null => specMission(nodeRef) ?? config.compiled()?.mission(nodeRef) ?? null;
  const listNodes = (): readonly { nodeRef: string }[] => {
    const specs: { nodeRef: string }[] = [];
    if (config.nodeSpecsDir !== undefined) {
      const listing = listNodeSpecs(config.nodeSpecsDir); specs.push(...listing.nodes);
      for (const entry of listing.skipped) config.log(`[wrapper] node spec skipped: ${entry}`);
    }
    const listed = new Set(specs.map((spec) => spec.nodeRef));
    for (const node of config.compiled()?.nodes() ?? []) if (!listed.has(node.nodeRef)) specs.push({ nodeRef: node.nodeRef });
    return specs;
  };
  return Object.freeze({ nodeMission, listNodes });
}
