import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PACK_SOURCE_ERROR_CODES,
  PACKAGING_SOURCE_LAYER,
  PackSourceError,
  type MaterializedPackSource,
  type PackSourceCode,
  type PackSourceCommand,
  type PackSourceCommandResult,
  type PackSourceDependencies,
  type PackSourceRequest,
  withMaterializedPackSource as withBoundPackSource,
} from "./pack-source.js";
import { isGitExecutableMode, parseRoster } from "./pack-source-integrity.js";
import { isSensitivePackSourcePath } from "./pack-source-sensitive.js";
import { materializedPackSourceLeaseEntries } from "./pack-source-lease.js";
import { createPackSourceFixturePool } from "./pack-source-test-fixtures.js";

const SECRET = "must-never-escape-pack-source";
const SENSITIVE_BYTE_CASES = Object.freeze([
  { name: "cloud credential", contents: ["AWS_SECRET_ACCESS", "_KEY=", "A".repeat(40)].join("") },
  { name: "session credential", contents: ["MOE_SESSION", "_CREDENTIAL=", "s".repeat(64)].join("") },
  { name: "bearer authorization", contents: ["Authorization: Be", "arer ", "eyJhbGciOiJIUzI1NiJ9.payload.signature"].join("") },
  { name: "private key", contents: ["-----BEGIN ", "PRIVATE KEY-----\n", "ZmFrZS1rZXktbWF0ZXJpYWw=\n", "-----END PRIVATE KEY-----\n"].join("") },
]);
const HASH_BOUNDARY_OFFSETS = Object.freeze([-1, 0, 1]);
const roots: string[] = [];
// These cases execute real Git/archive processes. On a busy Windows host one unchanged
// case measured 25.57s; independent seeded fixtures reduced it to 7.27s. Bound only those
// integration cases at 30s. Pure guards and the global/default test budget stay unchanged.
const GIT_INTEGRATION_TIMEOUT_MS = 30_000;

function executableFromPath(name: string): string {
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const rawDirectory of (process.env["PATH"] ?? "").split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    if (!isAbsolute(directory)) continue;
    for (const candidate of candidates) {
      try {
        const executable = realpathSync(join(directory, candidate));
        if (statSync(executable).isFile()) return executable;
      } catch {
        // Keep searching absolute PATH entries; the production boundary never performs discovery.
      }
    }
  }
  throw new Error(`missing test executable: ${name}`);
}

const EXECUTABLES = Object.freeze({
  gitExecutable: executableFromPath("git"),
  tarExecutable: executableFromPath("tar"),
});

const tarVersion = spawnSync(EXECUTABLES.tarExecutable, ["--version"], {
  cwd: dirname(EXECUTABLES.tarExecutable), encoding: "utf8",
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "TAR_OPTIONS")),
  shell: false, windowsHide: true,
});
if (tarVersion.status !== 0) throw new Error("test tar --version failed");
const tarVersionText = String(tarVersion.stdout);
if (!tarVersionText.startsWith("bsdtar ") && !tarVersionText.startsWith("tar (GNU tar) ")) {
  throw new Error("test tar flavor unsupported");
}
const TEST_TAR_FLAVOR = tarVersionText.startsWith("bsdtar ") ? "bsdtar" : "gnu";
const TOOLCHAIN = Object.freeze({ ...EXECUTABLES, tarFlavor: TEST_TAR_FLAVOR as "bsdtar" | "gnu" });

function withMaterializedPackSource<T>(
  request: PackSourceRequest,
  consume: (source: MaterializedPackSource) => T,
  dependencies: Partial<PackSourceDependencies> = {},
): T {
  return withBoundPackSource(request, consume, { ...TOOLCHAIN, ...dependencies });
}

interface GitFixture {
  readonly blobSha: string;
  readonly headSha: string;
  readonly repositoryRoot: string;
  readonly selectedSha: string;
  readonly trackedPaths: readonly string[];
}

function run(command: string, args: readonly string[], cwd: string, input?: string): Buffer {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: null,
    input,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${String(result.stderr)}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

const systemCommand: PackSourceCommand = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: null,
    shell: false,
    windowsHide: true,
  });
  const answer: PackSourceCommandResult = {
    status: result.status,
    stderr: result.stderr ?? Buffer.alloc(0),
    stdout: result.stdout ?? Buffer.alloc(0),
  };
  return result.error === undefined ? answer : { ...answer, error: result.error };
};

function write(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function buildGitFixture(repositoryRoot: string, objectFormat: "sha1" | "sha256"): GitFixture {
  run("git", ["init", "--quiet", `--object-format=${objectFormat}`], repositoryRoot);
  run("git", ["config", "user.email", "pack-source@example.invalid"], repositoryRoot);
  run("git", ["config", "user.name", "Pack Source Test"], repositoryRoot);
  run("git", ["config", "core.autocrlf", "false"], repositoryRoot);
  // Fixture history has no signing authority; never inherit a host's signing process.
  run("git", ["config", "commit.gpgsign", "false"], repositoryRoot);

  write(repositoryRoot, ".gitignore", "packages/contracts/.env\n");
  write(repositoryRoot, "packaging/manifest.json", "{\"version\":1}\n");
  write(repositoryRoot, "src/name with space-μ.txt", "unicode path\n");
  write(repositoryRoot, "src/version.txt", "version-one\n");
  run("git", ["add", "--", ".gitignore", "packaging/manifest.json", "src"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "version one"], repositoryRoot);
  const selectedSha = run("git", ["rev-parse", "HEAD"], repositoryRoot).toString("utf8").trim();

  write(repositoryRoot, "src/version.txt", "version-two\n");
  run("git", ["add", "--", "src/version.txt"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "version two"], repositoryRoot);
  const headSha = run("git", ["rev-parse", "HEAD"], repositoryRoot).toString("utf8").trim();
  const blobSha = run("git", ["hash-object", "-w", "--stdin"], repositoryRoot, "not a commit")
    .toString("utf8").trim();

  write(repositoryRoot, "packages/contracts/.env", SECRET);
  write(repositoryRoot, "untracked-sentinel.txt", SECRET);
  return {
    blobSha,
    headSha,
    repositoryRoot,
    selectedSha,
    trackedPaths: Object.freeze([
      ".gitignore",
      "packaging/manifest.json",
      "src/name with space-μ.txt",
      "src/version.txt",
    ]),
  };
}

const fixturePool = createPackSourceFixturePool(buildGitFixture, (root) => roots.push(root));
const createGitFixture = (format: "sha1" | "sha256" = "sha1"): GitFixture => fixturePool.create(format);

// Real Git preparation is a suite setup cost, paid once per object format. Every case
// receives an independent copy; production limits and refusal assertions stay intact.
beforeAll(() => fixturePool.prepare(), 120_000);
afterAll(() => fixturePool.dispose());

function commitSymlink(fixture: GitFixture, path: string, target: string): string {
  const objectSha = run("git", ["hash-object", "-w", "--stdin"], fixture.repositoryRoot, target)
    .toString("utf8").trim();
  run("git", ["update-index", "--add", "--cacheinfo", `120000,${objectSha},${path}`], fixture.repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "host escaping symlink"], fixture.repositoryRoot);
  return run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot).toString("utf8").trim();
}

function isGitCommand(args: readonly string[], command: string): boolean {
  return args.includes(command);
}

function isExecutable(command: string, name: "git" | "tar"): boolean {
  return command === (name === "git" ? TOOLCHAIN.gitExecutable : TOOLCHAIN.tarExecutable);
}

function isTarExtraction(args: readonly string[]): boolean {
  return args.includes("-xf") || args.includes("--extract");
}

function tarDestination(args: readonly string[]): string | undefined {
  const option = args.includes("-C") ? "-C" : "--directory";
  return args[args.indexOf(option) + 1];
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected PackSourceError, but the operation succeeded");
}

function expectPackSourceError(action: () => unknown, code: PackSourceCode): PackSourceError {
  const error = captureError(action);
  expect(error).toBeInstanceOf(PackSourceError);
  expect(error).toMatchObject({ code, layer: PACKAGING_SOURCE_LAYER });
  expect(Object.isFrozen(error)).toBe(true);
  expect(String(error)).not.toContain(SECRET);
  return error as PackSourceError;
}

function temporaryOwner(dependencies: Partial<PackSourceDependencies> = {}): {
  readonly dependencies: Partial<PackSourceDependencies>;
  readonly owners: string[];
} {
  const owners: string[] = [];
  return {
    dependencies: {
      ...dependencies,
      makeTemporaryRoot: () => {
        const owner = realpathSync(mkdtempSync(join(tmpdir(), "moe-pack-source-owner-test-")));
        owners.push(owner);
        roots.push(owner);
        return owner;
      },
    },
    owners,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("exact-commit packaging source", () => {
  it.each(["sha1", "sha256"] as const)("isolates %s fixture Git and working bytes from sibling and future copies", (format) => {
    const first = createGitFixture(format);
    const sibling = createGitFixture(format);
    expect(readFileSync(join(sibling.repositoryRoot, ".git/config"), "utf8"))
      .toMatch(/^\s*gpgsign = false$/mu);
    const paths = ["src/version.txt", ".git/HEAD", ".git/index", ".git/config",
      `.git/objects/${first.blobSha.slice(0, 2)}/${first.blobSha.slice(2)}`];
    const original = paths.map((path) => readFileSync(join(sibling.repositoryRoot, path)));
    for (const path of paths) {
      // Git objects are read-only on Windows. Change only this copy, then mutate in place
      // so a hardlinked object would corrupt the sibling and fail the byte comparison.
      chmodSync(join(first.repositoryRoot, path), 0o600);
      writeFileSync(join(first.repositoryRoot, path), "mutated fixture bytes");
    }
    const later = createGitFixture(format);
    for (const fixture of [sibling, later]) {
      expect(fixture.repositoryRoot).not.toBe(first.repositoryRoot);
      expect(paths.map((path) => readFileSync(join(fixture.repositoryRoot, path)))).toEqual(original);
      expect(existsSync(join(fixture.repositoryRoot, ".git/objects/info/alternates"))).toBe(false);
    }
    expect(later.repositoryRoot).not.toBe(sibling.repositoryRoot);
  });

  it("treats only owner execute as Git executability", () => {
    expect(isGitExecutableMode(0o100755)).toBe(true);
    expect(isGitExecutableMode(0o100644)).toBe(false);
    expect(isGitExecutableMode(0o100641)).toBe(false);
    expect(isGitExecutableMode(0o100700)).toBe(true);
  });

  it.each([
    ".env",
    ".envrc",
    "apps/daemon/.env.production",
    "apps/daemon/production.env",
    ".git-credentials",
    ".npmrc",
    ".docker/config.json",
    "operator/.netrc",
    "release/operator-credentials.json",
    "release/secrets.yaml",
    "certificates/service.pem",
    "certificates/service.key",
    "certificates/service.p12",
    "certificates/service.pfx",
    "certificates/service.jks",
    "certificates/service.keystore",
    "certificates/AuthKey_ABC123.p8",
    "certificates/AuthKey_ABC123",
    "certificates/service-account.p8",
    "release/credentials.csv",
    "operator/.kube/config",
    "release/github-token.json",
    "release/access_token.yaml",
    "release/api-token.toml",
    "ssh/id_ed25519",
    "ssh/id_ed25519_sk",
    "operator/.aws/config",
    "operator/.aws/credentials",
    "operator/.aws/cli/cache/session.json",
    "operator/.aws/sso/cache/session.json",
    "operator/.config/gcloud/application_default_credentials.json",
    "operator/.config/gcloud/access_tokens.db",
    "operator/.config/gcloud/credentials.db",
    "operator/.config/gcloud/legacy_credentials/account/adc.json",
    "operator/.azure/accessTokens.json",
    "operator/.azure/msal_token_cache.json",
    "operator/.azure/service_principal_entries.json",
    "operator/.azure/TokenCache.dat",
    "operator/.credentials",
    "operator/auth.json",
    "operator/credentials.xml",
    "operator/service-account.json",
    "ssh/operator.ppk",
    ".env~",
    ".npmrc.bak",
    ".npmrc.tmp",
    ".vault-token",
    ".yarnrc.yml",
    "release/credentials.json.bak",
    "release/credentials.json.temp",
    "ssh/id_rsa.old",
    "certificates/service.key.backup",
    "release/serviceAccountKey.json",
    "operator/.config/gh/hosts.yml",
  ])("classifies tracked sensitive path %s for fail-closed release refusal", (path) => {
    expect(isSensitivePackSourcePath(path)).toBe(true);
  });

  it.each([
    "apps/daemon/environment.ts",
    "docs/credential-model.md",
    "packages/core/src/secret-redaction.ts",
    "certificates/service.pem.test.ts",
    "packages/contracts/src/api-token.ts",
    "packages/contracts/src/AuthKey.ts",
    "packages/runner/src/cloud/aws-credentials.ts",
    "docs/examples/.azure/README.md",
  ])("does not classify ordinary source path %s as a credential file", (path) => {
    expect(isSensitivePackSourcePath(path)).toBe(false);
  });

  it("excludes runtime-state entries before applying release-source budgets", () => {
    const objectNameLength = 40;
    const releaseObjectSha = "b".repeat(objectNameLength);
    const roster = Buffer.from(
      `100644 blob ${"a".repeat(objectNameLength)} ${80 * 1024 * 1024 + 1}\t.moe/runtime.db\0`
      + `100755 blob ${releaseObjectSha} 7\tbin/release.sh\0`,
    );

    expect(parseRoster(roster, objectNameLength)).toEqual([{
      mode: "100755",
      objectSha: releaseObjectSha,
      path: "bin/release.sh",
      size: 7,
    }]);
  });

  it("materializes a selected commit without its tracked runtime state", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const releaseContents = "#!/bin/sh\nexit 0\n";
    write(fixture.repositoryRoot, ".moe/runtime/state.json", "{\"state\":\"ephemeral\"}\n");
    write(fixture.repositoryRoot, "bin/release.sh", releaseContents);
    run("git", ["add", "--", ".moe/runtime/state.json", "bin/release.sh"], fixture.repositoryRoot);
    run("git", ["update-index", "--chmod=+x", "--", "bin/release.sh"], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "tracked runtime state"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    const releaseSha256 = createHash("sha256").update(releaseContents).digest("hex");

    withMaterializedPackSource({ repositoryRoot: fixture.repositoryRoot, sourceSha }, (source) => {
      expect(source.trackedPaths).toContain("bin/release.sh");
      expect(source.trackedPaths).not.toContain(".moe/runtime/state.json");
      expect(existsSync(join(source.sourceRoot, ".moe", "runtime", "state.json"))).toBe(false);
      expect(source.leaseEntries.some(({ path }) => path.startsWith(join(source.sourceRoot, ".moe"))))
        .toBe(false);
      expect(source.leaseEntries).toContainEqual(expect.objectContaining({
        kind: "file",
        path: realpathSync(join(source.sourceRoot, "bin", "release.sh")),
        sha256: releaseSha256,
        size: Buffer.byteLength(releaseContents),
      }));
    });
  });

  it("generates every high-signal sensitive-byte case", () => {
    expect(SENSITIVE_BYTE_CASES).toHaveLength(4);
    expect(HASH_BOUNDARY_OFFSETS).toHaveLength(3);
  });

  it.each(SENSITIVE_BYTE_CASES)("refuses $name bytes on an ordinary tracked path", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, ({ contents }) => {
    const fixture = createGitFixture();
    write(fixture.repositoryRoot, "docs/release-input.txt", contents);
    run("git", ["add", "--", "docs/release-input.txt"], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "ordinary path sensitive bytes"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    let consumed = false;

    // The ordinary path, bounded blob, mode, and roster all pass. The callback never runs, so
    // no downstream consumer can refuse first: only the materialized-byte fence can answer.
    expect(isSensitivePackSourcePath("docs/release-input.txt")).toBe(false);
    const error = expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha,
    }, () => { consumed = true; }), "PACK_SOURCE_SENSITIVE_PATH");
    expect(consumed).toBe(false);
    expect(String(error)).not.toContain(contents);
  });

  it.each(HASH_BOUNDARY_OFFSETS)(
    "refuses sensitive bytes split across the hash chunk boundary at offset %i",
    { timeout: GIT_INTEGRATION_TIMEOUT_MS }, (edgeOffset) => {
      const fixture = createGitFixture();
      const contents = SENSITIVE_BYTE_CASES[0]?.contents;
      if (contents === undefined) throw new Error("missing sensitive-byte boundary fixture");
      const markerSplit = 12;
      const prefix = Buffer.alloc((64 * 1024) - markerSplit + edgeOffset, 0x78);
      const target = join(fixture.repositoryRoot, "docs", "boundary-input.bin");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.concat([prefix, Buffer.from(contents, "ascii")]));
      run("git", ["add", "--", "docs/boundary-input.bin"], fixture.repositoryRoot);
      run("git", ["commit", "--quiet", "-m", "chunk boundary sensitive bytes"], fixture.repositoryRoot);
      const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
        .toString("utf8").trim();

      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha,
      }, () => { throw new Error("sensitive bytes reached the consumer"); }), "PACK_SOURCE_SENSITIVE_PATH");
    },
  );

  it("admits deterministic binary bytes without a sensitive marker", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const contents = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42, 0x69, 0x6e, 0x61, 0x72, 0x79]);
    const target = join(fixture.repositoryRoot, "docs", "binary-input.dat");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    run("git", ["add", "--", "docs/binary-input.dat"], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "ordinary binary bytes"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    let consumed = false;

    withMaterializedPackSource({ repositoryRoot: fixture.repositoryRoot, sourceSha }, (source) => {
      consumed = true;
      expect(readFileSync(join(source.sourceRoot, "docs", "binary-input.dat"))).toEqual(contents);
    });
    expect(consumed).toBe(true);
  });

  it.each([
    "packages/contracts/.env",
    "packages/contracts/.envrc",
    "packages/contracts/AuthKey_ABC123.p8",
    "packages/contracts/.kube/config",
    "packages/contracts/github-token.json",
    "packages/contracts/.env~",
    "packages/contracts/.npmrc.bak",
    "packages/contracts/.npmrc.tmp",
    "packages/contracts/.vault-token",
    "packages/contracts/.yarnrc.yml",
    "packages/contracts/credentials.json.bak",
    "packages/contracts/credentials.json.temp",
    "packages/contracts/id_rsa.old",
    "packages/contracts/service.key.backup",
    "packages/contracts/serviceAccountKey.json",
    "packages/contracts/.config/gh/hosts.yml",
  ])("refuses sensitive tracked Git object %s before archive extraction", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, (path) => {
    const fixture = createGitFixture();
    write(fixture.repositoryRoot, path, SECRET);
    run("git", ["add", "--force", "--", path], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "tracked credential"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    let consumed = false;

    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha,
    }, () => { consumed = true; }), "PACK_SOURCE_SENSITIVE_PATH");
    expect(consumed).toBe(false);
  });

  it("materializes only the selected commit's tracked bytes and cleans its callback-only root", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    let sourceRoot = "";
    const answer = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => {
      sourceRoot = source.sourceRoot;
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.trackedPaths)).toBe(true);
      expect(source.sourceSha).toBe(fixture.selectedSha);
      expect(source.trackedPaths).toEqual(fixture.trackedPaths);
      expect(readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"))
        .toBe("version-one\n");
      expect(existsSync(join(source.sourceRoot, "packages", "contracts", ".env"))).toBe(false);
      expect(existsSync(join(source.sourceRoot, "untracked-sentinel.txt"))).toBe(false);
      return Object.freeze({ selected: source.sourceSha, tracked: source.trackedPaths.length });
    });

    expect(answer).toEqual({ selected: fixture.selectedSha, tracked: fixture.trackedPaths.length });
    expect(sourceRoot).not.toBe("");
    expect(existsSync(dirname(sourceRoot))).toBe(false);
    expect(fixture.headSha).not.toBe(fixture.selectedSha);
  });

  it("reverifies every tracked blob after the synchronous consumer returns", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();

    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, ({ sourceRoot }) => {
      write(sourceRoot, "src/version.txt", "post-verification substitution\n");
      return 0;
    }), "PACK_SOURCE_CONTENT_MISMATCH");
  });

  it("refuses a lease snapshot whose bytes no longer match the Git-verified digest", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-pack-source-lease-binding-")));
    roots.push(root);
    write(root, "src/version.txt", "trusted-source\n");
    const trusted = readFileSync(join(root, "src", "version.txt"));
    const expected = Object.freeze({
      path: "src/version.txt",
      sha256: createHash("sha256").update(trusted).digest("hex"),
      size: trusted.byteLength,
    });
    write(root, "src/version.txt", "hostile-source\n");

    expect(() => materializedPackSourceLeaseEntries(root, [expected]))
      .toThrow("PACK_WINDOWS_LEASE_FAILED");
  });

  it.each([
    "packages/contracts/.env",
    "node_modules/dependency/.env.production",
    "apps/control-room/dist/operator-credentials.json",
    "apps/control-room/dist/.env~",
    "apps/control-room/dist/.npmrc.bak",
    "apps/control-room/dist/.npmrc.tmp",
    "apps/control-room/dist/.vault-token",
    "apps/control-room/dist/.yarnrc.yml",
    "apps/control-room/dist/credentials.json.bak",
    "apps/control-room/dist/credentials.json.temp",
    "apps/control-room/dist/id_rsa.old",
    "apps/control-room/dist/service.key.backup",
    "apps/control-room/dist/serviceAccountKey.json",
    "apps/control-room/dist/.config/gh/hosts.yml",
  ])("refuses sensitive path %s added by the consumer", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, (path) => {
    const fixture = createGitFixture();

    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, ({ sourceRoot }) => {
      write(sourceRoot, path, "VITE_RELEASE_SECRET=must-not-build\n");
      return 0;
    }), "PACK_SOURCE_SENSITIVE_PATH");
  });

  it.each([
    "packages/contracts/generated.txt",
    "apps/control-room/distributed/app.js",
    "apps/daemon/dist/app.js",
  ])("refuses non-generated path %s added by the consumer", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, (path) => {
    const fixture = createGitFixture();

    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, ({ sourceRoot }) => {
      write(sourceRoot, path, "consumer-created\n");
      return 0;
    }), "PACK_SOURCE_ROSTER_MISMATCH");
  });

  it.each([
    "node_modules/.pnpm/dependency/index.js",
    "apps/daemon/node_modules/@moe/contracts/package.json",
    "packages/contracts/node_modules/dependency/package.json",
    "apps/control-room/dist/assets/app.js",
  ])("permits generated build path %s after the consumer", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, (path) => {
    const fixture = createGitFixture();

    const answer = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, ({ sourceRoot }) => {
      write(sourceRoot, path, "generated-build-byte\n");
      return 17;
    });

    expect(answer).toBe(17);
  });

  it("accepts an exact lowercase SHA-256 commit without weakening the SHA-1 path", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture("sha256");
    expect(fixture.selectedSha).toMatch(/^[0-9a-f]{64}$/u);
    const observed = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => ({ sha: source.sourceSha, paths: source.trackedPaths }));
    expect(observed).toEqual({ sha: fixture.selectedSha, paths: fixture.trackedPaths });
  });

  it("ignores local Git replacement refs that try to restamp HEAD as the selected commit", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    run("git", ["replace", fixture.selectedSha, fixture.headSha], fixture.repositoryRoot);
    const materialized = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"));
    expect(materialized).toBe("version-one\n");
  });

  it("ignores inherited Git and tar environment overrides", () => {
    const fixture = createGitFixture();
    const previousGitDirectory = process.env["GIT_DIR"];
    const previousTarOptions = process.env["TAR_OPTIONS"];
    process.env["GIT_DIR"] = join(fixture.repositoryRoot, "attacker-selected-git-dir");
    process.env["TAR_OPTIONS"] = "--attacker-selected-option";
    try {
      const materialized = withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: fixture.selectedSha,
      }, (source) => readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"));
      expect(materialized).toBe("version-one\n");
    } finally {
      if (previousGitDirectory === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = previousGitDirectory;
      if (previousTarOptions === undefined) delete process.env["TAR_OPTIONS"];
      else process.env["TAR_OPTIONS"] = previousTarOptions;
    }
  }, 30_000);

  it("uses only pre-resolved absolute tools and runs tar outside the repository", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    write(fixture.repositoryRoot, process.platform === "win32" ? "git.exe" : "git", SECRET);
    write(fixture.repositoryRoot, process.platform === "win32" ? "tar.exe" : "tar", SECRET);
    let tarWorkingDirectory = "";
    let extractedSourceRoot = "";
    const materialized = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"), {
      command: (executable, args, cwd) => {
        expect(isAbsolute(executable)).toBe(true);
        expect([TOOLCHAIN.gitExecutable, TOOLCHAIN.tarExecutable]).toContain(executable);
        if (isExecutable(executable, "tar") && isTarExtraction(args)) {
          tarWorkingDirectory = cwd;
          extractedSourceRoot = tarDestination(args) ?? "";
        }
        return systemCommand(executable, args, cwd);
      },
    });
    expect(materialized).toBe("version-one\n");
    expect(tarWorkingDirectory).not.toBe("");
    expect(tarWorkingDirectory).toBe(dirname(TOOLCHAIN.tarExecutable));
    expect(tarWorkingDirectory).not.toBe(realpathSync(fixture.repositoryRoot));
    expect(extractedSourceRoot).not.toBe("");
    expect(existsSync(dirname(extractedSourceRoot))).toBe(false);
  });

  it("rejects a repository-local executable before spawning it", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      gitExecutable: join(fixture.repositoryRoot, "src", "version.txt"),
    }), "PACK_SOURCE_TOOLCHAIN_INVALID");
  });

  it("rejects a repository-local executable under a dot-dot-prefixed child", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const executable = repositoryPath(fixture.repositoryRoot, "..tools/git.exe");
    copyFileSync(TOOLCHAIN.gitExecutable, executable);
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, { gitExecutable: executable }), "PACK_SOURCE_TOOLCHAIN_INVALID");
  });

  it("snapshots request fields once before resolving authority", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    let sourceReads = 0;
    const request = Object.defineProperties({}, {
      repositoryRoot: { enumerable: true, get: () => fixture.repositoryRoot },
      sourceSha: {
        enumerable: true,
        get: () => ++sourceReads === 1 ? fixture.selectedSha : fixture.headSha,
      },
    }) as PackSourceRequest;
    const materialized = withMaterializedPackSource(request, (source) =>
      readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"));
    expect(materialized).toBe("version-one\n");
    expect(sourceReads).toBe(1);
  });

  it("rejects a declared tar flavor that the absolute tool does not report", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      tarFlavor: TOOLCHAIN.tarFlavor === "bsdtar" ? "gnu" : "bsdtar",
    }), "PACK_SOURCE_TOOLCHAIN_INVALID");
  });

  it.skipIf(process.platform !== "win32")("uses GNU tar's Windows argument contract when declared", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    let observed = false;
    const materialized = withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, (source) => readFileSync(join(source.sourceRoot, "src", "version.txt"), "utf8"), {
      tarFlavor: "gnu",
      command: (executable, args, cwd) => {
        if (isExecutable(executable, "tar") && args.length === 1 && args[0] === "--version") {
          return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from("tar (GNU tar) 1.35\n") };
        }
        if (isExecutable(executable, "tar") && isTarExtraction(args)) {
          observed = true;
          expect(args).toContain("--force-local");
          const archive = args[args.indexOf("--file") + 1];
          const destination = tarDestination(args);
          if (archive === undefined || destination === undefined) throw new Error("missing GNU tar path");
          // The arm asserts the GNU argument contract above; the extraction itself is then
          // delegated to the REAL host tar so the materialization completes. Spell the
          // delegated call for whichever tar the host actually has: under PowerShell that
          // is bsdtar (`--options`), under Git Bash it is MSYS GNU tar, which rejects
          // `--options` and needs the production GNU arguments verbatim.
          return TOOLCHAIN.tarFlavor === "gnu"
            ? systemCommand(executable, args, cwd)
            : systemCommand(executable,
              ["-xf", archive, "--options", "hdrcharset=UTF-8", "-C", destination], cwd);
        }
        return systemCommand(executable, args, cwd);
      },
    });
    expect(materialized).toBe("version-one\n");
    expect(observed).toBe(true);
  });

  it("refuses Git archive export-subst body rewrites before the callback", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    write(fixture.repositoryRoot, ".gitattributes", "src/substituted.txt export-subst\n");
    write(fixture.repositoryRoot, "src/substituted.txt", "$Format:%H$\n");
    run("git", ["add", "--", ".gitattributes", "src/substituted.txt"], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "archive substitution attack"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    let callbackCalled = false;
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha,
    }, () => { callbackCalled = true; }), "PACK_SOURCE_CONTENT_MISMATCH");
    expect(callbackCalled).toBe(false);
  });

  it("refuses a tracked symlink whose committed target can escape the materialized root", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const sourceSha = commitSymlink(fixture, "src/host-secret", `C:/host/${SECRET}`);
    let callbackCalled = false;
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha,
    }, () => { callbackCalled = true; }), "PACK_SOURCE_SYMLINK_UNSAFE");
    expect(callbackCalled).toBe(false);
  });

  it("rejects a drive-qualified Git path before archive extraction", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    let archiveCalled = false;
    const command: PackSourceCommand = (executable, args, cwd) => {
      if (isExecutable(executable, "git") && isGitCommand(args, "ls-tree")) {
        return {
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(`100644 blob ${"0".repeat(fixture.selectedSha.length)} 1\tC:/outside/${SECRET}\0`),
        };
      }
      if (isExecutable(executable, "git") && isGitCommand(args, "archive")) archiveCalled = true;
      return systemCommand(executable, args, cwd);
    };
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, { command }), "PACK_SOURCE_ROSTER_FAILED");
    expect(archiveCalled).toBe(false);
  });

  it("rejects a tracked-byte budget overflow before creating an owner", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const injected = temporaryOwner({
      command: (executable, args, cwd) => isExecutable(executable, "git")
        && isGitCommand(args, "ls-tree")
        ? {
            status: 0,
            stderr: Buffer.alloc(0),
            stdout: Buffer.from(`100644 blob ${"0".repeat(fixture.selectedSha.length)}`
              + ` ${Number.MAX_SAFE_INTEGER}\thuge.bin\0`),
          }
        : systemCommand(executable, args, cwd),
    });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_BUDGET_EXCEEDED");
    expect(injected.owners).toEqual([]);
  });

  it("refuses an asynchronous consumer and cleans before its continuation", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, async () => {
    const fixture = createGitFixture();
    let sourceRoot = "";
    let existedAfterAwait: boolean | undefined;
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, async (source) => {
      sourceRoot = source.sourceRoot;
      await Promise.resolve();
      existedAfterAwait = existsSync(source.sourceRoot);
      throw new Error(SECRET);
    }), "PACK_SOURCE_ASYNC_CONSUMER_UNSUPPORTED");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sourceRoot).not.toBe("");
    expect(existedAfterAwait).toBe(false);
    expect(existsSync(dirname(sourceRoot))).toBe(false);
  });

  const invalidInputNames = Object.freeze(["symbolic", "mixed-case", "short"] as const);
  it("rejects symbolic, mixed-case, and short identities before spawning archive authority", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const cases = [
      { name: "symbolic", sourceSha: "HEAD" },
      { name: "mixed-case", sourceSha: "A".repeat(40) },
      { name: "short", sourceSha: fixture.selectedSha.slice(0, 12) },
    ] as const;
    expect(cases.map(({ name }) => name)).toEqual(invalidInputNames);
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: testCase.sourceSha,
      }, () => undefined), "PACK_SOURCE_INPUT_INVALID");
    }
  });

  it("rejects a full-length blob identity because it is not a commit", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    expect(fixture.blobSha).toMatch(/^[0-9a-f]{40}$/u);
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.blobSha,
    }, () => undefined), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("rejects malformed request records at the same input boundary", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const cases: readonly unknown[] = Object.freeze([
      null,
      {},
      { repositoryRoot: "", sourceSha: fixture.selectedSha },
      { extra: true, repositoryRoot: fixture.repositoryRoot, sourceSha: fixture.selectedSha },
      { repositoryRoot: fixture.repositoryRoot, sourceSha: `${fixture.selectedSha}${SECRET}` },
      Object.defineProperties({}, {
        repositoryRoot: {
          enumerable: true,
          get: () => { throw new Error(SECRET); },
        },
        sourceSha: { enumerable: true, value: fixture.selectedSha },
      }),
    ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const request of cases) {
      expectPackSourceError(() => withMaterializedPackSource(
        request as never,
        () => undefined,
      ), "PACK_SOURCE_INPUT_INVALID");
    }
  });

  it("publishes one frozen closed code roster at the packaging-source layer", () => {
    expect(Object.isFrozen(PACK_SOURCE_ERROR_CODES)).toBe(true);
    expect(PACK_SOURCE_ERROR_CODES).toEqual([
      "PACK_SOURCE_INPUT_INVALID",
      "PACK_SOURCE_COMMIT_UNAVAILABLE",
      "PACK_SOURCE_ROSTER_FAILED",
      "PACK_SOURCE_ARCHIVE_FAILED",
      "PACK_SOURCE_EXTRACT_FAILED",
      "PACK_SOURCE_ROSTER_MISMATCH",
      "PACK_SOURCE_CONTENT_MISMATCH",
      "PACK_SOURCE_MODE_MISMATCH",
      "PACK_SOURCE_SYMLINK_UNSAFE",
      "PACK_SOURCE_TOOLCHAIN_INVALID",
      "PACK_SOURCE_BUDGET_EXCEEDED",
      "PACK_SOURCE_SENSITIVE_PATH",
      "PACK_SOURCE_ASYNC_CONSUMER_UNSUPPORTED",
      "PACK_SOURCE_CLEANUP_FAILED",
      "PACK_SOURCE_PACKER_DRIFT",
      "PACK_SOURCE_IMMUTABILITY_FAILED",
    ]);
    expect(PACK_SOURCE_ERROR_CODES.length).toBeGreaterThan(0);
  });
});

describe("packaging-source failures and cleanup", () => {
  const commandFailures = Object.freeze([
    {
      code: "PACK_SOURCE_ROSTER_FAILED",
      expectedOwners: 0,
      matches: (command: string, args: readonly string[]) => isExecutable(command, "git") && isGitCommand(args, "ls-tree"),
      name: "tracked roster",
    },
    {
      code: "PACK_SOURCE_ARCHIVE_FAILED",
      expectedOwners: 1,
      matches: (command: string, args: readonly string[]) => isExecutable(command, "git") && isGitCommand(args, "archive"),
      name: "archive",
    },
    {
      code: "PACK_SOURCE_EXTRACT_FAILED",
      expectedOwners: 1,
      matches: (command: string, args: readonly string[]) =>
        isExecutable(command, "tar") && isTarExtraction(args),
      name: "extraction",
    },
  ] as const);

  it("never adopts or cleans a non-owned temporary root", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    let cleanupCalled = false;
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      makeTemporaryRoot: () => fixture.repositoryRoot,
      removeTemporaryRoot: () => { cleanupCalled = true; },
    }), "PACK_SOURCE_ARCHIVE_FAILED");
    expect(cleanupCalled).toBe(false);
    expect(existsSync(fixture.repositoryRoot)).toBe(true);
  });

  it("maps command failures to exact non-secret codes and cleans every owner root", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    expect(commandFailures.length).toBeGreaterThan(0);
    for (const testCase of commandFailures) {
      const fixture = createGitFixture();
      const command: PackSourceCommand = (executable, args, cwd) => testCase.matches(executable, args)
        ? { status: 1, stderr: Buffer.from(SECRET), stdout: Buffer.from(SECRET) }
        : systemCommand(executable, args, cwd);
      const injected = temporaryOwner({ command });
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: fixture.selectedSha,
      }, () => undefined, injected.dependencies), testCase.code);
      expect(injected.owners.length).toBe(testCase.expectedOwners);
      expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
    }
  });

  it("maps a synchronously throwing command port without leaking its cause", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      command: () => { throw new Error(SECRET); },
    }), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("maps malformed and throwing command results without leaking their cause", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const cases: readonly unknown[] = [
      null,
      Object.defineProperty({}, "status", {
        enumerable: true,
        get: () => { throw new Error(SECRET); },
      }),
    ];
    for (const result of cases) {
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha: fixture.selectedSha,
      }, () => undefined, {
        command: () => result as PackSourceCommandResult,
      }), "PACK_SOURCE_COMMIT_UNAVAILABLE");
    }
  });

  it("refuses oversized archive output before writing it to disk", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const oversized = new Uint8Array(0);
    Object.defineProperty(oversized, "byteLength", { value: Number.MAX_SAFE_INTEGER });
    const injected = temporaryOwner({
      command: (executable, args, cwd) => isExecutable(executable, "git")
        && isGitCommand(args, "archive")
        ? { status: 0, stderr: Buffer.alloc(0), stdout: oversized }
        : systemCommand(executable, args, cwd),
    });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_ARCHIVE_FAILED");
    expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
  });

  it("rejects decorated commit output instead of trimming it into authority", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, {
      command: () => ({
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(` ${fixture.selectedSha}\n`),
      }),
    }), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  });

  it("refuses an extracted tree whose paths do not exactly match the Git roster", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const command: PackSourceCommand = (executable, args, cwd) => {
      const result = systemCommand(executable, args, cwd);
      if (isExecutable(executable, "tar") && isTarExtraction(args) && result.status === 0) {
        const destination = tarDestination(args);
        if (destination !== undefined) {
          rmSync(join(destination, "src", "version.txt"), { force: true });
          writeFileSync(repositoryPath(destination, "injected-untracked.txt"), SECRET, "utf8");
        }
      }
      return result;
    };
    const injected = temporaryOwner({ command });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_ROSTER_MISMATCH");
    expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
  });

  it("prefers Git blob mismatch when extracted bytes are also sensitive", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const replacement = SENSITIVE_BYTE_CASES[1]?.contents;
    if (replacement === undefined) throw new Error("missing sensitive-byte precedence fixture");
    write(fixture.repositoryRoot, "docs/precedence.txt", "x".repeat(Buffer.byteLength(replacement)));
    run("git", ["add", "--", "docs/precedence.txt"], fixture.repositoryRoot);
    run("git", ["commit", "--quiet", "-m", "sensitive mismatch precedence"], fixture.repositoryRoot);
    const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
      .toString("utf8").trim();
    let callbackCalled = false;
    const command: PackSourceCommand = (executable, args, cwd) => {
      const result = systemCommand(executable, args, cwd);
      if (isExecutable(executable, "tar") && isTarExtraction(args) && result.status === 0) {
        const destination = tarDestination(args);
        if (destination !== undefined) {
          expect(Buffer.byteLength(replacement)).toBe(statSync(join(destination,
            "docs", "precedence.txt")).size);
          writeFileSync(join(destination, "docs", "precedence.txt"), replacement, "utf8");
        }
      }
      return result;
    };
    const injected = temporaryOwner({ command });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha,
    }, () => { callbackCalled = true; }, injected.dependencies), "PACK_SOURCE_CONTENT_MISMATCH");
    expect(callbackCalled).toBe(false);
    expect(injected.owners.every((owner) => !existsSync(owner))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a changed executable mode", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const command: PackSourceCommand = (executable, args, cwd) => {
      const result = systemCommand(executable, args, cwd);
      if (isExecutable(executable, "tar") && isTarExtraction(args) && result.status === 0) {
        const destination = tarDestination(args);
        if (destination !== undefined) chmodSync(join(destination, "src", "version.txt"), 0o755);
      }
      return result;
    };
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, { command }), "PACK_SOURCE_MODE_MISMATCH");
  });

  it.skipIf(process.platform === "win32")(
    "refuses when owner execute is cleared but another execute bit remains",
    { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
      const fixture = createGitFixture();
      run("git", ["update-index", "--chmod=+x", "src/version.txt"], fixture.repositoryRoot);
      run("git", ["commit", "--quiet", "-m", "owner executable"], fixture.repositoryRoot);
      const sourceSha = run("git", ["rev-parse", "HEAD"], fixture.repositoryRoot)
        .toString("utf8").trim();
      const command: PackSourceCommand = (executable, args, cwd) => {
        const result = systemCommand(executable, args, cwd);
        if (isExecutable(executable, "tar") && isTarExtraction(args) && result.status === 0) {
          const destination = tarDestination(args);
          if (destination !== undefined) chmodSync(join(destination, "src", "version.txt"), 0o641);
        }
        return result;
      };

      // The bytes, path, size, blob, roster, symlink, budget, and sensitive-path checks are
      // unchanged; only the owner-execute bit differs, so the mode guard is the sole refusal.
      expectPackSourceError(() => withMaterializedPackSource({
        repositoryRoot: fixture.repositoryRoot,
        sourceSha,
      }, () => undefined, { command }), "PACK_SOURCE_MODE_MISMATCH");
    },
  );

  it("preserves the consumer exception while reporting a subordinate cleanup code only", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const primary = new Error("consumer failure is primary");
    const reports: string[] = [];
    const injected = temporaryOwner({
      removeTemporaryRoot: () => { throw new Error(SECRET); },
      reportCleanupFailure: (code) => { reports.push(code); throw new Error(SECRET); },
    });
    const error = captureError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => { throw primary; }, injected.dependencies));
    expect(error).toBe(primary);
    expect(reports).toEqual(["PACK_SOURCE_CLEANUP_FAILED"]);
    expect(reports.join(" ")).not.toContain(SECRET);
    expect(injected.owners.some((owner) => existsSync(owner))).toBe(true);
  });

  it("throws the stable cleanup error when cleanup is the only failure", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const injected = temporaryOwner({
      removeTemporaryRoot: () => { throw new Error(SECRET); },
    });
    const error = expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => "materialized", injected.dependencies), "PACK_SOURCE_CLEANUP_FAILED");
    expect(error.message).toBe("PACK_SOURCE_CLEANUP_FAILED");
    expect(injected.owners.some((owner) => existsSync(owner))).toBe(true);
  });

  it("preserves a materialization error when cleanup also fails", { timeout: GIT_INTEGRATION_TIMEOUT_MS }, () => {
    const fixture = createGitFixture();
    const reports: string[] = [];
    const injected = temporaryOwner({
      command: (executable, args, cwd) => isExecutable(executable, "git") && isGitCommand(args, "archive")
        ? { status: 1, stderr: Buffer.from(SECRET), stdout: Buffer.alloc(0) }
        : systemCommand(executable, args, cwd),
      removeTemporaryRoot: () => { throw new Error(SECRET); },
      reportCleanupFailure: (code) => reports.push(code),
    });
    expectPackSourceError(() => withMaterializedPackSource({
      repositoryRoot: fixture.repositoryRoot,
      sourceSha: fixture.selectedSha,
    }, () => undefined, injected.dependencies), "PACK_SOURCE_ARCHIVE_FAILED");
    roots.push(...injected.owners);
    expect(reports).toEqual(["PACK_SOURCE_CLEANUP_FAILED"]);
  });
});

function repositoryPath(root: string, path: string): string {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  return target;
}
