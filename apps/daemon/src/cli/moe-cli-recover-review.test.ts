import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseCliArgv } from "./moe-cli-argv.js";
import { runMoeCli } from "./moe-cli-main.js";
import type { CliIo } from "./moe-cli-main.js";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture(overrides: Partial<CliIo> = {}) {
  const root = mkdtempSync(join(tmpdir(), "moe-review-cli-")); scratch.push(root);
  const events: string[] = []; const lines: string[] = [];
  const io: CliIo = { artifactRoot: root, argv: ["init"], cwd: root, env: {},
    log: (line) => lines.push(line), nodeVersion: "v24.16.0", packageVersion: "test",
    randomHex: () => "ab".repeat(32), startManager: async () => { events.push("manager"); return 0; },
    startStack: async () => { events.push("start"); return 0; }, ...overrides };
  expect(await runMoeCli(io)).toBe(0); lines.length = 0;
  return { root, io, events, lines };
}

it("parses recover-review with the project path and explicit operator input", () => {
  expect(parseCliArgv(["recover-review", "D:\\My Project", "--operator-stdin"]))
    .toEqual({ ok: true, command: "recover-review", targetDir: "D:\\My Project", operatorStdin: true });
  expect(parseCliArgv(["recover-review", "--force"]))
    .toMatchObject({ ok: false, code: "MOE_CLI_UNKNOWN_OPTION" });
  expect(parseCliArgv(["recover-review", "one", "two"]))
    .toMatchObject({ ok: false, code: "MOE_CLI_TOO_MANY_ARGUMENTS" });
});

it("recovers the configured project before starting the repaired foreground runtime", async () => {
  const f = await fixture();
  const code = await runMoeCli({ ...f.io, argv: ["recover-review", ".", "--operator-stdin"],
    recoverReview: async (request) => {
      expect(request.projectRoot).toBe(f.root); expect(request.config.projectId).toBeTruthy();
      f.events.push("recovered"); return { ok: true };
    }, startStack: async (request) => {
      expect(request.projectRoot).toBe(f.root); expect(request.operatorStdin).toBe(true);
      f.events.push("start"); return 17;
    } });
  expect(code).toBe(17); expect(f.events).toEqual(["recovered", "start"]);
  expect(f.lines.join("\n")).not.toContain("ab".repeat(32));
});

it("does not start another runtime after an explicit recovery refusal", async () => {
  const f = await fixture();
  const code = await runMoeCli({ ...f.io, argv: ["recover-review"], recoverReview: async () =>
    ({ ok: false, code: "REPOSITORY_REVIEW_DRAIN_ACCESS_DENIED" }) });
  expect(code).toBe(1); expect(f.events).toEqual([]);
  expect(f.lines.join("\n")).toContain("REPOSITORY_REVIEW_DRAIN_ACCESS_DENIED");
});

it("refuses unavailable recovery instead of treating the command as start", async () => {
  const f = await fixture();
  expect(await runMoeCli({ ...f.io, argv: ["recover-review"] })).toBe(1);
  expect(f.lines.join("\n")).toContain("MOE_CLI_REVIEW_RECOVERY_UNAVAILABLE");
  expect(f.events).toEqual([]);
});

it("does not leak a thrown recovery error or restart after it", async () => {
  const f = await fixture();
  expect(await runMoeCli({ ...f.io, argv: ["recover-review"], recoverReview: async () => {
    throw new Error("private credential");
  } })).toBe(1);
  expect(f.lines.join("\n")).not.toContain("private credential"); expect(f.events).toEqual([]);
});

it("refuses a changed project config between recovery and restart", async () => {
  const f = await fixture();
  expect(await runMoeCli({ ...f.io, argv: ["recover-review"], recoverReview: async () => {
    const path = join(f.root, "moe.config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...config, projectId: "another-project" }));
    return { ok: true };
  } })).toBe(1);
  expect(f.lines.join("\n")).toContain("MOE_CLI_REVIEW_RECOVERY_CONFIG_CHANGED"); expect(f.events).toEqual([]);
});
