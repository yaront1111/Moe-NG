import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseVerifiedTree } from "./git-verified-workspace-capture.js";
import { VerifiedGitFailure, literalPaths, objectId, verifiedGitRefusal } from "./git-verified-workspace-runtime.js";

describe("verified workspace runtime boundary", () => {
  it("loads all runtime bridges in the production Node strip-only entrypoint", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const m = await import(process.argv[1]); process.stdout.write(typeof m.createVerifiedWorkspacePort);",
      new URL("./git-verified-workspace-port.js", import.meta.url).href], { encoding: "utf8", shell: false, windowsHide: true });
    expect(output).toBe("function");
  });
  it("parses exact leaf modes, object ids and NUL-delimited paths", () => {
    expect(parseVerifiedTree(`100755 blob ${"a".repeat(40)}\tbin/run\0`))
      .toEqual([{ mode: "100755", oid: "a".repeat(40), path: "bin/run" }]);
    expect(parseVerifiedTree(`120000 blob ${"b".repeat(64)}\tsymlink\0`))
      .toEqual([{ mode: "120000", oid: "b".repeat(64), path: "symlink" }]);
    expect(() => parseVerifiedTree(`160000 commit ${"a".repeat(40)}\tvendor\0`)).toThrow("VERIFIED_WORKSPACE_SUBMODULE_UNSUPPORTED");
    expect(() => parseVerifiedTree("malformed\0")).toThrow("VERIFIED_WORKSPACE_UNKNOWN");
  });
  it("recognizes only full object ids and quotes literal pathspecs", () => {
    expect(objectId("a".repeat(40))).toBe(true); expect(objectId("b".repeat(64))).toBe(true);
    expect(objectId("a".repeat(39))).toBe(false); expect(objectId("HEAD")).toBe(false);
    expect(literalPaths(["[name].ts", ":(glob)*"])).toEqual([":(literal)[name].ts", ":(literal):(glob)*"]);
  });
  it("maps failures without exposing native errors or machine paths", () => {
    expect(verifiedGitRefusal(new VerifiedGitFailure("VERIFIED_WORKSPACE_DRIFT")))
      .toEqual({ ok: false, code: "VERIFIED_WORKSPACE_DRIFT", detail: "VERIFIED_WORKSPACE_DRIFT" });
    expect(verifiedGitRefusal(new Error("private path and subprocess bytes")))
      .toEqual({ ok: false, code: "VERIFIED_WORKSPACE_UNKNOWN", detail: "VERIFIED_WORKSPACE_UNKNOWN" });
  });
});
