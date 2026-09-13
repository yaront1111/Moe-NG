import { spawn as realSpawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startPreviewProcess } from "./preview-process.js";
import { cleanupFixtureWorkspaces, fixtureWorkspace } from "./preview-test-fixtures.js";

afterEach(cleanupFixtureWorkspaces);

/** Measure from the actual exit/error, so slow process creation does not grade host load. */
async function refusesAfterTermination(workspace: string, command: string, event: "exit" | "error") {
  let terminated!: () => void;
  const termination = new Promise<void>((resolve) => { terminated = resolve; });
  const start = startPreviewProcess({ command, port: null, workspace }, {
    startTimeoutMs: 5_000,
    spawn: (file, args, options) => {
      const child = realSpawn(file, [...args], options);
      child.once(event, terminated);
      return child;
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await termination;
    const result = await Promise.race([
      start,
      new Promise<"still waiting">((resolve) => { timer = setTimeout(() => resolve("still waiting"), 1_000); }),
    ]);
    expect(result).toMatchObject({ ok: false, code: "PREVIEW_START_TIMEOUT", layer: "RUNNER" });
  } finally {
    clearTimeout(timer);
    const result = await start;
    if (result.ok) await result.handle.stop();
  }
}

describe("preview startup termination", () => {
  it.each([0, 7])("refuses promptly when the command exits with code %i before listening", async (code) => {
    const workspace = fixtureWorkspace({ files: { "exit.mjs": `process.exit(${code});` }, scripts: {} });
    await refusesAfterTermination(workspace, "node exit.mjs", "exit");
  });

  it("refuses promptly when spawning fails asynchronously", async () => {
    const workspace = fixtureWorkspace({ scripts: {} });
    await refusesAfterTermination(join(workspace, "missing-directory"), "node missing.mjs", "error");
  });
});
