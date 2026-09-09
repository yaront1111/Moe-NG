import { execFileSync, spawn as realSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeploymentImageBuilder } from "./deploy-image-build.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function repository() {
  const context = mkdtempSync(join(tmpdir(), "moe-deploy-build-test-")); directories.push(context);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Review", "-c", "user.email=review@example.test", ...args], { cwd: context, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet");
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
  const binary = Buffer.from([0, 255, 128, 42, 13, 10, 254]);
  writeFileSync(join(context, "binary.bin"), binary);
  git("add", "--", "Dockerfile", "binary.bin"); git("commit", "--quiet", "-m", "source");
  return { context, git, sha: git("rev-parse", "HEAD"), binary };
}

it("streams only the requested commit's binary bytes despite dirty files and local archive attributes", async () => {
  const source = repository();
  writeFileSync(join(source.context, "binary.bin"), "dirty replacement");
  writeFileSync(join(source.context, "untracked.txt"), "untracked payload");
  writeFileSync(join(source.context, ".git", "info", "attributes"), "* export-ignore\n");
  const archive = join(source.context, "captured.tar");
  const dockerCalls: (readonly string[])[] = [];
  const build = createDeploymentImageBuilder({ spawn: (file, args, options) => {
    if (file !== "docker") return realSpawn(file, [...args], options);
    dockerCalls.push(args);
    return realSpawn(process.execPath, ["-e", `const fs=require('node:fs');const out=fs.createWriteStream(${JSON.stringify(archive)});process.stdin.pipe(out);`], options);
  } });
  const tag = `moe-deploy-production:${source.sha}`;
  expect((await build({ context: source.context, sha: source.sha, tag })).code).toBe(0);
  expect(dockerCalls).toEqual([["build", "--tag", tag, "-"]]);
  const bytes = readFileSync(archive);
  expect(bytes.includes(source.binary)).toBe(true);
  expect(bytes.includes(Buffer.from("dirty replacement"))).toBe(false);
  expect(bytes.includes(Buffer.from("untracked payload"))).toBe(false);
});

it("refuses missing commits and tree objects before spawning Docker", async () => {
  const source = repository(); let dockerCalls = 0;
  const build = createDeploymentImageBuilder({ spawn: (file, args, options) => {
    if (file === "docker") dockerCalls++;
    return realSpawn(file, [...args], options);
  } });
  for (const sha of ["f".repeat(40), source.git("rev-parse", "HEAD^{tree}")]) {
    expect((await build({ context: source.context, sha, tag: `moe-deploy-production:${sha}` })).code).toBe(1);
  }
  expect(dockerCalls).toBe(0);
});

it("propagates a local Docker build failure", async () => {
  const source = repository();
  const build = createDeploymentImageBuilder({ spawn: (file, args, options) => file === "docker"
    ? realSpawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(23));"], options)
    : realSpawn(file, [...args], options) });
  expect((await build({ context: source.context, sha: source.sha, tag: `moe-deploy-production:${source.sha}` })).code).toBe(23);
});

it("does not turn an archive producer failure into a successful build", async () => {
  const source = repository();
  const build = createDeploymentImageBuilder({ spawn: (file, _args, options) => realSpawn(process.execPath,
    ["-e", file === "git" ? "process.exit(29)" : "process.stdin.resume();"], options) });
  expect((await build({ context: source.context, sha: source.sha, tag: `moe-deploy-production:${source.sha}` })).code).not.toBe(0);
});
