import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  PHASE0_GIT_STATUS_COMMAND,
  PHASE0_MAX_DOCUMENT_BYTES,
} from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { identifyEvidence } from "./evidence-digest.js";
import { createNodePhase0EvidenceCapturePort } from "./phase0-node-capture-port.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  // Canonicalised ONCE, at creation, so every path derived below inherits it.
  // On macOS $TMPDIR lives under /var/folders and /var is a symlink to
  // /private/var, so a lexical mkdtemp path has a symlinked ANCESTOR. The
  // port's stable-root guard requires a root whose realpath is itself — that
  // is exactly the redirection it exists to refuse — so an uncanonical fixture
  // root reddened every case here with PHASE0_NODE_SOURCE_PATH_ESCAPE /
  // PHASE0_NODE_TARGET_PATH_ESCAPE before its own subject was ever reached.
  // The fixture is what was wrong; the guard is not relaxed.
  const root = await realpath(await mkdtemp(join(tmpdir(), `moe-${label}-`)));
  temporaryRoots.push(root);
  return root;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function fixture() {
  const root = await temporaryDirectory("phase0-port");
  const sourceRepository = join(root, "source");
  const targetRepository = join(root, "target");
  await mkdir(join(sourceRepository, "docs", "plans"), { recursive: true });
  await mkdir(targetRepository, { recursive: true });
  await git(sourceRepository, "init", "-b", "main");
  await git(sourceRepository, "config", "user.email", "phase0@example.invalid");
  await git(sourceRepository, "config", "user.name", "Phase Zero Test");
  await writeFile(join(sourceRepository, "docs", "plans", "tracked.md"), "tracked\n");
  await git(sourceRepository, "add", "docs/plans/tracked.md");
  await git(sourceRepository, "commit", "-m", "fixture");

  const port = createNodePhase0EvidenceCapturePort({
    sourceRepository,
    targetRepository,
  });
  return { port, root, sourceRepository, targetRepository };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

// 30s: every case runs real git subprocess work; the 5s default times out under
// full-suite parallelism (passes 10/10 isolated). Same repair as 03fd290/9f52c54.
describe("Node Phase 0 capture port", { timeout: 30_000 }, () => {
  it("captures exact Git identity and raw porcelain-v2 status bytes", async () => {
    const { port, sourceRepository } = await fixture();
    await writeFile(join(sourceRepository, "docs", "plans", "untracked.md"), "untracked\n");

    const snapshot = await port.readRepositorySnapshot(
      sourceRepository,
      PHASE0_GIT_STATUS_COMMAND,
    );
    const expectedStatus = await execFileAsync(
      "git",
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      { cwd: sourceRepository, encoding: "buffer", windowsHide: true },
    );

    expect(snapshot).toMatchObject({
      head: await git(sourceRepository, "rev-parse", "HEAD"),
      objectFormat: "sha1",
      sourceRepository,
      statusCommand: PHASE0_GIT_STATUS_COMMAND,
    });
    expect(Buffer.from(snapshot.statusBytes).equals(expectedStatus.stdout)).toBe(true);
    await expect(
      port.readRepositorySnapshot(sourceRepository, "git status --short"),
    ).rejects.toThrow("PHASE0_NODE_STATUS_COMMAND_MISMATCH");
  });

  it("ignores inherited Git environment that points at another repository", async () => {
    const { port, root, sourceRepository } = await fixture();
    const decoy = join(root, "decoy");
    await mkdir(decoy);
    await git(decoy, "init", "-b", "main");
    await git(decoy, "config", "user.email", "decoy@example.invalid");
    await git(decoy, "config", "user.name", "Decoy");
    await writeFile(join(decoy, "decoy.txt"), "decoy\n");
    await git(decoy, "add", "decoy.txt");
    await git(decoy, "commit", "-m", "decoy");
    const expectedHead = await git(sourceRepository, "rev-parse", "HEAD");
    const priorDirectory = process.env.GIT_DIR;
    const priorWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    try {
      const snapshot = await port.readRepositorySnapshot(
        sourceRepository,
        PHASE0_GIT_STATUS_COMMAND,
      );
      expect(snapshot.head).toBe(expectedHead);
    } finally {
      if (priorDirectory === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = priorDirectory;
      }
      if (priorWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = priorWorkTree;
      }
    }
  });

  it("rejects repository configuration that redirects the work tree", async () => {
    const { port, root, sourceRepository } = await fixture();
    const redirected = join(root, "redirected-work-tree");
    await mkdir(redirected);
    await git(sourceRepository, "config", "core.worktree", redirected);

    await expect(
      port.readRepositorySnapshot(sourceRepository, PHASE0_GIT_STATUS_COMMAND),
    ).rejects.toThrow("PHASE0_NODE_GIT_TOP_LEVEL_MISMATCH");
  });

  it("reads stable regular files and resolves paths at the captured commit", async () => {
    const { port, sourceRepository } = await fixture();
    const head = await git(sourceRepository, "rev-parse", "HEAD");

    const source = await port.readSourceFile(
      sourceRepository,
      "docs/plans/tracked.md",
    );
    const tracked = await port.lookupPathAtCommit(
      sourceRepository,
      head,
      "docs/plans/tracked.md",
    );
    const absent = await port.lookupPathAtCommit(
      sourceRepository,
      head,
      "docs/plans/absent.md",
    );

    expect(new TextDecoder().decode(source.bytes)).toBe("tracked\n");
    expect(resolve(source.resolvedPath).toLowerCase()).toBe(
      resolve(sourceRepository, "docs/plans/tracked.md").toLowerCase(),
    );
    expect(tracked).toMatchObject({
      commit: head,
      identity: { objectType: "blob", oid: expect.stringMatching(/^[0-9a-f]{40}$/) },
      relativePath: "docs/plans/tracked.md",
      sourceRepository,
    });
    expect(absent.identity).toBeNull();
  });

  it("rejects wrong roots, traversal, and a junction escape", async () => {
    const { port, root, sourceRepository } = await fixture();
    await expect(
      port.readSourceFile(join(root, "wrong"), "docs/plans/tracked.md"),
    ).rejects.toThrow("PHASE0_NODE_SOURCE_REPOSITORY_MISMATCH");
    await expect(
      port.readSourceFile(sourceRepository, "../escape.md"),
    ).rejects.toThrow("PHASE0_NODE_RELATIVE_PATH_INVALID");
    await expect(
      port.readSourceFile(`${sourceRepository}${sep}docs${sep}..`, "docs/plans/tracked.md"),
    ).rejects.toThrow("PHASE0_NODE_SOURCE_REPOSITORY_MISMATCH");

    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "escaped.md"), "escaped\n");
    await symlink(outside, join(sourceRepository, "docs", "escape"), "junction");
    await expect(
      port.readSourceFile(sourceRepository, "docs/escape/escaped.md"),
    ).rejects.toThrow("PHASE0_NODE_SOURCE_PATH_ESCAPE");
  });

  it("stores evidence atomically, accepts identical races, and never overwrites a collision", async () => {
    const { port, targetRepository } = await fixture();
    const bytes = new TextEncoder().encode("immutable evidence\n");
    const identity = identifyEvidence(bytes);

    const receipts = await Promise.all([
      port.writeEvidenceObject(targetRepository, identity.objectPath, bytes),
      port.writeEvidenceObject(targetRepository, identity.objectPath, bytes),
    ]);
    expect(receipts).toEqual([
      { objectPath: identity.objectPath, targetRepository },
      { objectPath: identity.objectPath, targetRepository },
    ]);
    const stored = await port.readEvidenceObject(targetRepository, identity.objectPath);
    expect(Buffer.from(stored.bytes).equals(bytes)).toBe(true);

    await writeFile(
      join(targetRepository, ...identity.objectPath.split("/")),
      "different bytes",
    );
    await expect(
      port.writeEvidenceObject(targetRepository, identity.objectPath, bytes),
    ).rejects.toThrow("PHASE0_NODE_OBJECT_COLLISION");
    expect(await readFile(join(targetRepository, ...identity.objectPath.split("/")), "utf8"))
      .toBe("different bytes");
  });

  it("rejects malformed content-addressed paths and forged result roots", async () => {
    const { port, root, targetRepository } = await fixture();
    const bytes = new TextEncoder().encode("evidence");

    await expect(
      port.writeEvidenceObject(targetRepository, "objects/sha256/aa/../escape", bytes),
    ).rejects.toThrow("PHASE0_NODE_OBJECT_PATH_INVALID");
    await expect(
      port.writeEvidenceObject(
        targetRepository,
        "objects/sha256/aa/" + "a".repeat(64),
        bytes,
      ),
    ).rejects.toThrow("PHASE0_NODE_OBJECT_DIGEST_MISMATCH");
    await expect(
      port.readEvidenceObject(join(root, "wrong"), identifyEvidence(bytes).objectPath),
    ).rejects.toThrow("PHASE0_NODE_TARGET_REPOSITORY_MISMATCH");
  });

  it("rejects a target object-store junction escape", async () => {
    const { port, root, targetRepository } = await fixture();
    const outside = join(root, "outside-objects");
    await mkdir(outside);
    await symlink(outside, join(targetRepository, "objects"), "junction");
    const bytes = new TextEncoder().encode("must stay inside target");
    const identity = identifyEvidence(bytes);

    await expect(
      port.writeEvidenceObject(targetRepository, identity.objectPath, bytes),
    ).rejects.toThrow("PHASE0_NODE_TARGET_PATH_ESCAPE");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects configured repository roots that are themselves junctions", async () => {
    const { root, sourceRepository, targetRepository } = await fixture();
    const sourceAlias = join(root, "source-alias");
    const targetAlias = join(root, "target-alias");
    await symlink(sourceRepository, sourceAlias, "junction");
    await symlink(targetRepository, targetAlias, "junction");

    const sourcePort = createNodePhase0EvidenceCapturePort({
      sourceRepository: sourceAlias,
      targetRepository,
    });
    await expect(
      sourcePort.readRepositorySnapshot(sourceAlias, PHASE0_GIT_STATUS_COMMAND),
    ).rejects.toThrow("PHASE0_NODE_SOURCE_PATH_ESCAPE");

    const targetPort = createNodePhase0EvidenceCapturePort({
      sourceRepository,
      targetRepository: targetAlias,
    });
    const bytes = new TextEncoder().encode("root alias");
    const identity = identifyEvidence(bytes);
    await expect(
      targetPort.writeEvidenceObject(targetAlias, identity.objectPath, bytes),
    ).rejects.toThrow("PHASE0_NODE_TARGET_PATH_ESCAPE");
  });

  it("rejects oversized files from metadata before materializing their bytes", async () => {
    const { port, sourceRepository } = await fixture();
    const sparsePath = join(sourceRepository, "docs", "plans", "oversized.md");
    const handle = await open(sparsePath, "w");
    try {
      await handle.truncate(PHASE0_MAX_DOCUMENT_BYTES + 1);
    } finally {
      await handle.close();
    }

    await expect(
      port.readSourceFile(sourceRepository, "docs/plans/oversized.md"),
    ).rejects.toThrow("PHASE0_NODE_FILE_LIMIT_EXCEEDED");
  });
});
