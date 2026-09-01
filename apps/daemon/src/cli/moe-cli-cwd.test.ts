import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { runMoeCli } from "./moe-cli-main.js";
import { MOE_CONFIG_FILENAME } from "./moe-init.js";

const scratch: string[] = [];

function temporaryDirectory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `moe-cli-cwd-${label}-`));
  scratch.push(path);
  return path;
}

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop() as string, { force: true, recursive: true });
  }
});

it("resolves init and start targets from the caller cwd while retaining the artifact root", async () => {
  const artifactRoot = temporaryDirectory("artifact");
  const operatorCwd = temporaryDirectory("operator");
  const starts: unknown[] = [];
  const io = {
    argv: ["init", "."],
    cwd: operatorCwd,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    log: (): void => undefined,
    nodeVersion: "v24.16.0",
    packageVersion: "0.1.0",
    randomHex: (): string => "5c".repeat(32),
    artifactRoot,
    startManager: async (): Promise<number> => 0,
    startStack: async (request: unknown): Promise<number> => {
      starts.push(request);
      return 0;
    },
  };

  expect(await runMoeCli(io)).toBe(0);
  expect(existsSync(join(operatorCwd, MOE_CONFIG_FILENAME))).toBe(true);
  expect(existsSync(join(artifactRoot, MOE_CONFIG_FILENAME))).toBe(false);

  expect(await runMoeCli({ ...io, argv: ["start", "."] })).toBe(0);
  expect(starts).toHaveLength(1);
  const request = starts[0] as {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly projectRoot?: string;
    readonly artifactRoot: string;
  };
  expect(request.artifactRoot).toBe(artifactRoot);
  expect(request.projectRoot ?? dirname(request.env["MOE_STORE_PATH"] as string)).toBe(operatorCwd);
});
