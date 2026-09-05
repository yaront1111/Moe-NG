import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWrapperNodeMissions } from "./wrapper-node-missions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("reserves scoped execution refs for the graph source while preserving ordinary operator specs", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-wrapper-missions-")); roots.push(root);
  const nodeRef = `node:v1:${"a".repeat(64)}`;
  const compiled = { instructions: "sealed graph mission", test: "node test.mjs", workspace: root, title: "local api" };
  writeFileSync(join(root, "override.json"), JSON.stringify({ ...compiled, instructions: "operator override", nodeRef }));
  writeFileSync(join(root, "ordinary.json"), JSON.stringify({ ...compiled, instructions: "operator task", nodeRef: "ordinary" }));
  writeFileSync(join(root, "broken.json"), "{");
  const skipped: string[] = [];
  const source = createWrapperNodeMissions({ nodeSpecsDir: root, log: (line) => skipped.push(line),
    compiled: () => ({ mission: (ref) => ref === nodeRef ? compiled : null, nodes: () => [{ nodeRef }] }) });
  expect(source.nodeMission(nodeRef)).toEqual(compiled);
  expect(source.nodeMission("ordinary")?.instructions).toBe("operator task");
  expect(source.listNodes()).toEqual([{ nodeRef: "ordinary" }, { nodeRef }]);
  expect(skipped.join("\n")).toContain("broken.json");
});
it("missing or malformed spec authority does not manufacture a coding brief", () => {
  const source = createWrapperNodeMissions({ compiled: () => null, log: () => {} });
  expect(source.nodeMission("unknown")).toBeNull();
  expect(source.listNodes()).toEqual([]);
});
