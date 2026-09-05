import { describe, expect, it } from "vitest";

import { codeMission, compilerMission, mission } from "./agent-mission-text.js";

const EXPIRES = "2026-09-05T20:00:00.000Z";

describe("mission file permissions agree with the staffed role", () => {
  it("tells a coding seat to edit and test its assigned workspace", () => {
    const text = codeMission("node.deliver@api", "api", EXPIRES, {
      instructions: "Implement the API", test: "pnpm test", title: "API", workspace: "/product",
    }, { accept: null, submit: null }, "project-1");

    expect(text).toContain("You may edit files in your assigned workspace and run its tests");
    expect(text).not.toContain("no file-write tool");
    expect(text).not.toContain("do not try to write memories or files");
    expect(text).toContain("do not try to write memories");
    expect(text).toContain('graph_get takes exactly {"projectId": "project-1"} and nothing else');
  });

  it.each([
    ["compiler", compilerMission("planning.submit_decomposition@goal", "planning.submit_decomposition", EXPIRES, "goal")],
    ["chain", mission("plan.propose@run", "plan.propose", EXPIRES, null)],
  ])("keeps the %s seat's file restrictions", (_name, text) => {
    expect(text).toContain("no file-write tool");
    expect(text).toContain("do not try to write memories or files");
    expect(text).not.toContain("You may edit files");
  });
});
