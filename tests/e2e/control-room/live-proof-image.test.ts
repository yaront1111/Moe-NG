import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONTROLLED_PROFILE_VERSION, generateControlledProfile }
  from "../../../apps/daemon/src/repository/controlled-profile/controlled-profile-generator.js";
import { writeDeployableSurface } from "./live-proof-image.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    const rel = relative(tmpdir(), dir);
    if (isAbsolute(rel) || rel.startsWith("..") || rel === "") throw new Error("fixture escaped temporary root");
    rmSync(dir, { recursive: true, force: true });
  }
});

function scaffold() {
  const tree = generateControlledProfile({ productName: "standup", profileVersion: CONTROLLED_PROFILE_VERSION });
  if (!tree.ok) throw new Error(tree.code);
  const dir = mkdtempSync(join(tmpdir(), "moe-live-image-test-"));
  created.push(dir);
  for (const [path, bytes] of tree.files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes, "utf8");
  }
  return { dir, files: tree.files };
}

function frozenAgreement(dir: string) {
  // Invoke the installed package manager directly. Standalone pnpm does not
  // provide npm_execpath; Windows has its executable rather than a .cmd shim.
  const cli = process.env["npm_execpath"];
  const javascript = cli !== undefined && /\.[cm]?js$/u.test(cli);
  return spawnSync(javascript ? process.execPath : process.platform === "win32" ? "pnpm.exe" : "pnpm",
    [...(javascript ? [cli] : []), "install", "--offline", "--frozen-lockfile", "--lockfile-only",
    "--ignore-scripts", "--ignore-pnpmfile", "--store-dir", ".moe-preview-cache",
    "--modules-dir", "node_modules", "--virtual-store-dir", "node_modules/.pnpm"], {
    cwd: dir, encoding: "utf8", shell: false, timeout: 20_000, windowsHide: true,
  });
}

describe("live proof deployable input", () => {
  it("adds its start command without replacing the generated package and lock inputs", () => {
    const { dir, files } = scaffold();
    const original = JSON.parse(files.get("package.json")!) as { scripts: Record<string, string> };
    writeDeployableSurface(dir);
    const actual = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    expect(actual).toEqual({ ...original, scripts: { ...original.scripts, start: "node server.mjs" } });
    for (const [path, bytes] of files) {
      if (path === "pnpm-lock.yaml" || path === "pnpm-workspace.yaml" || path.endsWith("/package.json")) {
        expect(readFileSync(join(dir, path), "utf8"), path).toBe(bytes);
      }
    }
  });

  it("passes the actual offline frozen lock check and rejects a changed dependency", () => {
    const { dir, files } = scaffold();
    writeDeployableSurface(dir);
    const accepted = frozenAgreement(dir);
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toBe(files.get("pnpm-lock.yaml"));

    const file = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies["pg"] = "0.0.0";
    writeFileSync(file, JSON.stringify(manifest), "utf8");
    const refused = frozenAgreement(dir);
    expect(refused.error).toBeUndefined();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  }, 45_000);
});
