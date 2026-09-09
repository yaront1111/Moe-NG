import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "./controlled-profile/controlled-profile-generator.js";
import { nodeGitRunner } from "./git-landing-port.js";
import { createBootstrapGitPort, createBootstrapGhPort, nodeTreeWriter } from "./repository-bootstrap-ports.js";
import { bootstrapRefusal } from "./repository-bootstrap-contracts.js";
import type { BootstrapPorts, BootstrapRequest, GhRunner } from "./repository-bootstrap-contracts.js";
import * as contracts from "./repository-bootstrap-contracts.js";
import * as service from "./repository-bootstrap-service.js";
const sha = "a".repeat(40);
const request = (dir: string): BootstrapRequest => ({
  dir, projectId: "project-example", productName: "sample", profileVersion: CONTROLLED_PROFILE_VERSION,
});
const github = { owner: "moe-example", name: "sample", visibility: "private" } as const;
const refusal = (code: string, detail?: string) => ({ code, refusedBy: "DAEMON_INGRESS", ...(detail ? { detail } : {}) });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function injected(): BootstrapPorts {
  return { tree: nodeTreeWriter, git: { commit: vi.fn(async () => ({ ok: true as const, sha })) },
    gh: createBootstrapGhPort(async () => ({ code: null, executableAbsent: true, stdout: "", stderr: "" })),
    bindRepository: vi.fn(async () => {}), registerCatalog: vi.fn(async () => {}), now: () => "2026-09-05T00:00:00Z" };
}

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "moe-bootstrap-service-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("bootstrap contracts", () => {
  it("publishes stable codes and the version from the generator", () => {
    expect(contracts).toMatchObject({
      BOOTSTRAP_RECEIPT_VERSION: "moe-bootstrap-receipt/1",
      BOOTSTRAP_DIR_NOT_EMPTY: "BOOTSTRAP_DIR_NOT_EMPTY",
      BOOTSTRAP_GIT_UNAVAILABLE: "BOOTSTRAP_GIT_UNAVAILABLE",
      BOOTSTRAP_GH_UNAVAILABLE: "BOOTSTRAP_GH_UNAVAILABLE",
      BOOTSTRAP_PROFILE_VERSION_UNKNOWN: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN",
    });
  });
});

describe("bootstrap service", () => {
  it("exports the bootstrap sequence", () => {
    expect(service).toMatchObject({ bootstrapRepository: expect.any(Function) });
  });

  it("refuses ONE existing file without writing anything", async () => {
    await scratch(async (root) => {
      const file = join(root, "keep");
      writeFileSync(file, "operator bytes");
      const before = { entries: readdirSync(root), hash: hash(file) };
      const ports = injected();
      const result = await service.bootstrapRepository(request(root), ports);
      expect(result).toMatchObject({ outcome: "REFUSED", sha: null,
        refusal: refusal("BOOTSTRAP_DIR_NOT_EMPTY", "DIRECTORY_NOT_EMPTY") });
      expect({ entries: readdirSync(root), hash: hash(file) }).toEqual(before);
      expect(ports.git.commit).not.toHaveBeenCalled();
      expect(ports.bindRepository).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("accepts an empty target (exists=%s)", async (exists) => {
    await scratch(async (root) => {
      const dir = join(root, "target");
      if (exists) mkdirSync(dir);
      const result = await service.bootstrapRepository(request(dir), injected());
      expect(result).toMatchObject({ outcome: "BOOTSTRAPPED", dir: resolve(dir), sha, remoteUrl: null, refusal: null });
      expect(existsSync(join(dir, "package.json"))).toBe(true);
    });
  });

  it.each([false, true])("version wins before filesystem contact (nonempty=%s)", async (nonempty) => {
    await scratch(async (root) => {
      const dir = join(root, "target");
      if (nonempty) { mkdirSync(dir); writeFileSync(join(dir, "keep"), "keep"); }
      const ports = injected();
      const prepare = vi.fn(nodeTreeWriter.prepare);
      const result = await service.bootstrapRepository({ ...request(dir), profileVersion: "unknown" },
        { ...ports, tree: { ...nodeTreeWriter, prepare } });
      expect(result).toMatchObject({ outcome: "REFUSED", sha: null, refusal: refusal("BOOTSTRAP_PROFILE_VERSION_UNKNOWN") });
      expect(prepare).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(nonempty);
      if (nonempty) expect(readdirSync(dir)).toEqual(["keep"]);
    });
  });

  it("reports absent Git with code and layer, retaining the tree honestly", async () => {
    await scratch(async (root) => {
      const result = await service.bootstrapRepository(request(root), { ...injected(),
        git: createBootstrapGitPort(async () => ({ code: null, stdout: "", stderr: "" })) });
      expect(result).toMatchObject({ outcome: "REFUSED", sha: null,
        refusal: refusal("BOOTSTRAP_GIT_UNAVAILABLE", "GIT_EXECUTABLE_UNAVAILABLE") });
      expect(existsSync(join(root, "package.json"))).toBe(true);
    });
  });

  it("local success survives absent gh, binds once, and refuses a second bootstrap", async () => {
    await scratch(async (root) => {
      const ports = { ...injected(), git: createBootstrapGitPort() };
      const input = { ...request(root), github };
      const result = await service.bootstrapRepository(input, ports);
      expect(result).toMatchObject({ version: "moe-bootstrap-receipt/1", outcome: "BOOTSTRAPPED", remoteUrl: null,
        sha: expect.stringMatching(/^[a-f0-9]{40}$/), refusal: null,
        githubRefusal: refusal("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTABLE_ABSENT") });
      expect(existsSync(join(root, ".git"))).toBe(true);
      const generated = generateControlledProfile(input);
      expect(generated.ok).toBe(true);
      if (!generated.ok) throw new Error(generated.code);
      expect(generated.files.size).toBe(23);
      for (const [path, bytes] of generated.files) expect(readFileSync(join(root, path), "utf8")).toBe(bytes);
      const bound = { dir: resolve(root), sha: result.sha, remoteUrl: null, projectId: input.projectId, productName: input.productName };
      expect(ports.bindRepository).toHaveBeenCalledExactlyOnceWith(bound);
      expect(ports.registerCatalog).toHaveBeenCalledExactlyOnceWith(bound);
      expect(vi.mocked(ports.bindRepository).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(ports.registerCatalog).mock.invocationCallOrder[0]!);
      expect(await service.bootstrapRepository(input, ports)).toMatchObject({
        outcome: "REFUSED", refusal: refusal("BOOTSTRAP_DIR_NOT_EMPTY") });
      const log = await nodeGitRunner(root, ["log", "--oneline"]);
      expect(log.code).toBe(0);
      expect(log.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^[a-f0-9]+ chore: scaffold by Moe$/)]);
    });
  }, 300_000);

  it("requests GitHub offline using exact argv and records the remote", async () => {
    await scratch(async (root) => {
      const run = vi.fn<GhRunner>(async () => ({ code: 0, executableAbsent: false, stdout: "", stderr: "" }));
      const result = await service.bootstrapRepository({ ...request(root), github },
        { ...injected(), gh: createBootstrapGhPort(run) });
      expect(run).toHaveBeenCalledExactlyOnceWith(resolve(root),
        ["repo", "create", "moe-example/sample", "--private", "--source", ".", "--push"]);
      expect(result).toMatchObject({ outcome: "BOOTSTRAPPED", sha, refusal: null, githubRefusal: null,
        remoteUrl: "https://github.com/moe-example/sample" });
    });
  });

  it("nonzero GitHub exit still commits and binds the local repository", async () => {
    await scratch(async (root) => {
      const ports = { ...injected(), git: createBootstrapGitPort(),
        gh: createBootstrapGhPort(async () => ({ code: 1, executableAbsent: false, stdout: "", stderr: "" })) };
      const result = await service.bootstrapRepository({ ...request(root), github }, ports);
      expect(result).toMatchObject({ outcome: "BOOTSTRAPPED", refusal: null, remoteUrl: null,
        githubRefusal: refusal("BOOTSTRAP_GH_UNAVAILABLE", "GITHUB_REFUSED") });
      expect(ports.bindRepository).toHaveBeenCalledTimes(1);
      const count = await nodeGitRunner(root, ["rev-list", "--count", "HEAD"]);
      expect(count).toMatchObject({ code: 0, stdout: "1\n" });
    });
  }, 300_000);

  it("pairs SHA and refusal in both directions and never invokes unrequested GH", async () => {
    await scratch(async (root) => {
      const create = vi.fn();
      const ports = { ...injected(), gh: { create } };
      const success = await service.bootstrapRepository(request(root), ports);
      const rejected = await service.bootstrapRepository(request(root), ports);
      expect(success).toMatchObject({ outcome: "BOOTSTRAPPED", sha, refusal: null, githubRefusal: null });
      expect(rejected).toMatchObject({ outcome: "REFUSED", sha: null, remoteUrl: null, refusal: refusal("BOOTSTRAP_DIR_NOT_EMPTY") });
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("does not surface runtime-generated userinfo from the GH port", async () => {
    await scratch(async (root) => {
      const transient = randomUUID();
      const remoteUrl = `https://${transient}@github.com/moe-example/sample`;
      const result = await service.bootstrapRepository({ ...request(root), github }, { ...injected(),
        gh: { create: async () => ({ ok: true, remoteUrl }) } });
      // Boolean assertion cannot print the runtime value in a failing diff.
      expect(JSON.stringify(result).includes(transient)).toBe(false);
      expect(result).toMatchObject({ outcome: "BOOTSTRAPPED", remoteUrl: null,
        githubRefusal: refusal("BOOTSTRAP_GH_UNAVAILABLE", "REMOTE_URL_REJECTED") });
    });
  });

  it.each(["bindRepository", "registerCatalog"] as const)("returns a refusal receipt if %s throws after commit", async (port) => {
    await scratch(async (root) => {
      const ports = { ...injected(), git: createBootstrapGitPort() };
      const result = await service.bootstrapRepository(request(root), { ...ports, [port]: async () => { throw new Error("ignored"); } });
      expect(result).toMatchObject({ outcome: "REFUSED", sha: null, refusal: refusal(
        port === "bindRepository" ? "BOOTSTRAP_BIND_FAILED" : "BOOTSTRAP_CATALOG_FAILED") });
      expect(existsSync(join(root, "package.json"))).toBe(true);
      expect(existsSync(join(root, ".git"))).toBe(true);
      expect(await nodeGitRunner(root, ["rev-list", "--count", "HEAD"]))
        .toMatchObject({ code: 0, stdout: "1\n" });
      if (port === "bindRepository") expect(ports.registerCatalog).not.toHaveBeenCalled();
    });
  }, 300_000);

  it("contains a thrown GitHub error without exposing its diagnostic", async () => {
    await scratch(async (root) => {
      const transient = randomUUID();
      const result = await service.bootstrapRepository({ ...request(root), github }, { ...injected(),
        gh: { create: async () => { throw new Error(transient); } } });
      expect(JSON.stringify(result).includes(transient)).toBe(false);
      expect(result).toMatchObject({ outcome: "BOOTSTRAPPED", refusal: null, remoteUrl: null,
        githubRefusal: refusal("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTION_FAILED") });
    });
  });

  it("preserves a written tree and .git when the first commit fails", async () => {
    await scratch(async (root) => {
      const run: typeof nodeGitRunner = async (dir, args) => args.includes("commit")
        ? { code: 1, stdout: "", stderr: "ignored" } : nodeGitRunner(dir, args);
      const ports = { ...injected(), git: createBootstrapGitPort(run) };
      const result = await service.bootstrapRepository(request(root), ports);
      expect(result).toMatchObject({ outcome: "REFUSED", sha: null,
        refusal: refusal("BOOTSTRAP_GIT_UNAVAILABLE", "GIT_COMMAND_FAILED") });
      expect(existsSync(join(root, ".git"))).toBe(true);
      expect(existsSync(join(root, "package.json"))).toBe(true);
      expect(ports.bindRepository).not.toHaveBeenCalled();
      expect(await service.bootstrapRepository(request(root), ports)).toMatchObject({ outcome: "REFUSED",
        refusal: refusal("BOOTSTRAP_DIR_NOT_EMPTY") });
    });
  }, 300_000);

  it("preserves the tree writer refusal and does not invoke Git", async () => {
    await scratch(async (root) => {
      const ports = injected();
      const result = await service.bootstrapRepository(request(root), { ...ports, tree: { ...nodeTreeWriter,
        write: async () => ({ ok: false, refusal: bootstrapRefusal("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID") }) } });
      expect(result).toMatchObject({ outcome: "REFUSED", refusal: refusal("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID") });
      expect(ports.git.commit).not.toHaveBeenCalled();
    });
  });

  it.each(["prepare", "write"] as const)("contains a thrown %s failure", async (method) => {
    await scratch(async (root) => {
      const result = await service.bootstrapRepository(request(root), { ...injected(), tree: { ...nodeTreeWriter,
        [method]: async () => { throw new Error("untrusted"); } } });
      expect(result).toMatchObject({ outcome: "REFUSED", refusal: refusal(
        method === "prepare" ? "BOOTSTRAP_DIR_INVALID" : "BOOTSTRAP_TREE_WRITE_FAILED") });
    });
  });

  it.each([{ productName: "Invalid Name" }, { github: { ...github, owner: "--invalid" } }])
  ("rejects invalid input before directory creation: %j", async (invalid) => {
    await scratch(async (root) => {
      const dir = join(root, "not-created");
      expect(await service.bootstrapRepository({ ...request(dir), ...invalid }, injected())).toMatchObject({
        outcome: "REFUSED", refusal: refusal("productName" in invalid ? "BOOTSTRAP_PRODUCT_NAME_INVALID" : "BOOTSTRAP_PAYLOAD_INVALID") });
      expect(existsSync(dir)).toBe(false);
    });
  });
});
