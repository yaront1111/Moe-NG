import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type { RepositoryBootstrapSeams } from "../daemon-command-async-entries.js";
import {
  handleAsyncCommandRequest, handleCommandRequest,
} from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type {
  AuthenticationResult, Authenticator, CommandAdapterDeps,
} from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "./controlled-profile/controlled-profile-generator.js";
import { BOOTSTRAP_RECEIPT_VERSION, bootstrapRefusal }
  from "./repository-bootstrap-contracts.js";
import type {
  BootstrapGhPort, BootstrapReceiptV1, BootstrapRepository,
} from "./repository-bootstrap-contracts.js";

/**
 * `repository.bootstrap` END TO END, through the REGISTERED command rather than the engine.
 *
 * The engine's own unit suite (repository-bootstrap-service.test.ts) already proves the dir
 * guard, the commit, the gh argv and the receipt in isolation. What this file proves is that
 * those behaviours SURVIVE THE WIRING: the dispatch seam, the operator fence, the bind through
 * the EXISTING `project.bind_repository` handler, the manager-catalog registration and the
 * durable receipt, in one pass against a real store and a real directory.
 *
 * NO NETWORK IN ANY ARM. The GitHub half is an injected port that records its argv. `git` IS
 * real: a bootstrap that does not produce a repository has not bootstrapped anything.
 *
 * TEARDOWN IS MANDATORY (epic rail 4). Every store handle and temp directory is released in a
 * `finally` registered BEFORE the arm's assertions, so a throwing arm still cleans up: a test
 * that leaks a directory or a handle makes every later gate on this board inadmissible.
 */

const OPERATOR = "operator-journey";
const PROJECT = "proj-bootstrap-journey";
const CREDENTIAL = "journey-operator-credential";
const DECIDED_AT = "2026-09-05T12:00:00.000Z";
const ADMIN = "project.admin";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const release = cleanups.pop();
    try { release?.(); } catch { /* teardown is best-effort, never a failure of its own */ }
  }
});

/** A directory that is removed on the way out whether the arm passes, fails or throws. */
function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `moe-bootstrap-${label}-`));
  cleanups.push(() => { rmSync(dir, { force: true, recursive: true }); });
  return dir;
}

function operatorAuthenticator(principalId: string): Authenticator {
  return {
    authenticate(credential: string | null): AuthenticationResult {
      if (credential !== CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
      return {
        principal: { capabilities: [ADMIN], principalId, projectId: PROJECT },
        verdict: "AUTHENTICATED",
      };
    },
  };
}

interface Harness {
  readonly deps: CommandAdapterDeps;
  readonly ghArgv: string[][];
  readonly registered: BootstrapRepository[];
  readonly store: SqliteEventStore;
}

/** A gh port that never spawns anything: it records the argv the production port would run. */
function recordingGh(argv: string[][], answer: "ABSENT" | "CREATED"): BootstrapGhPort {
  return {
    async create(dir, request) {
      argv.push(["gh", "repo", "create", `${request.owner}/${request.name}`,
        `--${request.visibility}`, "--source", ".", "--push"]);
      if (answer === "ABSENT") {
        // The PRODUCTION refusal factory, not a hand-built literal: the layer this port reports
        // must be the one production reports, or the arms below would pin a value nothing serves.
        return {
          ok: false as const,
          refusal: bootstrapRefusal("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTABLE_ABSENT"),
        };
      }
      void dir;
      return {
        ok: true as const,
        remoteUrl: `https://github.com/${request.owner}/${request.name}`,
      };
    },
  };
}

function harness(
  label: string, seams: Omit<RepositoryBootstrapSeams, "catalog"> = {},
  principalId: string = OPERATOR,
): Harness {
  const directory = scratch(`store-${label}`);
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  cleanups.push(() => { store.close(); });
  const registered: BootstrapRepository[] = [];
  const ghArgv: string[][] = [];
  const ports = createDaemonCommandPorts({
    clock: (): string => DECIDED_AT,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT,
    repositoryBootstrap: {
      catalog: async (request): Promise<void> => {
        registered.push({
          dir: request.root, productName: request.title, projectId: request.projectId,
          remoteUrl: null, sha: "",
        });
      },
      clock: (): string => DECIDED_AT,
      ...seams,
    },
    store,
  });
  return {
    deps: {
      authenticator: operatorAuthenticator(principalId),
      decisions: ports.decisions,
      registry: ports.registry,
    },
    ghArgv, registered, store,
  };
}

function body(
  commandId: string, commandKind: RuntimeCommandKind,
  payload: Readonly<Record<string, unknown>>, expectedVersion: number,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    commandId, commandKind, correlationId: "corr-bootstrap-journey", expectedVersion, payload,
    requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL, targetAggregateId: "agg-bootstrap-journey",
  }));
}

function registerProject(deps: CommandAdapterDeps): void {
  const answered = handleCommandRequest(deps, {
    body: body("cmd-journey-register", "project.register", { owner: "owner-journey" }, 0),
    credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
  expect(answered).toMatchObject({ outcome: "ACCEPTED" });
}

async function bootstrap(
  deps: CommandAdapterDeps, commandId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<typeof handleAsyncCommandRequest>>> {
  return await handleAsyncCommandRequest(deps, {
    body: body(commandId, "repository.bootstrap", payload, 0),
    credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

/** The receipt as the store holds it, not as the handler returned it. */
function committedReceipt(store: SqliteEventStore): BootstrapReceiptV1 | undefined {
  const ledger = readDurableLedger(store, PROJECT);
  return ledger.aggregates.get(`${PROJECT}-bootstrap`)?.result as BootstrapReceiptV1 | undefined;
}

function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitLines(dir: string, args: readonly string[]): string[] {
  return execFileSync("git", [...args], { cwd: dir, encoding: "utf8", windowsHide: true })
    .split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

const PRODUCT = { productName: "journey-product", profileVersion: CONTROLLED_PROFILE_VERSION };
const GITHUB = { name: "journey-product", owner: "journey-owner", visibility: "private" };

describe("repository.bootstrap through the registered command", () => {
  it("refuses a NON-EMPTY directory with its code and layer, writing nothing", async () => {
    const { deps, store } = harness("dir-guard", { gh: recordingGh([], "ABSENT") });
    registerProject(deps);
    const dir = scratch("occupied");
    const occupant = join(dir, "someones-work.txt");
    writeFileSync(occupant, "do not bury me", "utf8");
    const before = digestOf(occupant);

    const answered = await bootstrap(deps, "cmd-journey-occupied", { dir, ...PRODUCT });

    expect(answered).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_DIR_NOT_EMPTY", layer: "DAEMON_INGRESS" },
      stage: "DISPATCH",
    });
    // THE POINT OF THE ARM: the directory is untouched. This command writes a whole tree, and
    // a wrong path that buries an existing directory is the worst outcome in this row. The
    // occupant's BYTES are compared by digest, not just its name: a same-named file with
    // different contents would pass a listing check and still have destroyed the operator's work.
    expect(readdirSync(dir)).toEqual(["someones-work.txt"]);
    expect(digestOf(occupant)).toBe(before);
    expect(readFileSync(occupant, "utf8")).toBe("do not bury me");
    // The refusal is durable and carries its code with NO sha.
    const receipt = committedReceipt(store);
    expect(receipt).toMatchObject({
      outcome: "REFUSED", refusal: { code: "BOOTSTRAP_DIR_NOT_EMPTY" }, remoteUrl: null,
      sha: null, version: BOOTSTRAP_RECEIPT_VERSION,
    });
  });

  it("creates a NON-EXISTENT directory and accepts an EMPTY existing one", async () => {
    const parent = scratch("created");
    const created = join(parent, "nested", "product");
    const empty = join(scratch("empty"), "here");
    mkdirSync(empty, { recursive: true });

    for (const [label, dir] of [["absent", created], ["empty", empty]] as const) {
      const { deps } = harness(`accepts-${label}`, { gh: recordingGh([], "ABSENT") });
      registerProject(deps);
      const answered = await bootstrap(deps, `cmd-journey-${label}`, { dir, ...PRODUCT });
      expect(answered, label).toMatchObject({ outcome: "ACCEPTED" });
      expect(gitLines(dir, ["log", "--oneline"]), label).toHaveLength(1);
    }
  });

  it("SUCCEEDS local-only with gh absent: committed, bound, catalogued, remoteUrl null",
    async () => {
      const ghArgv: string[][] = [];
      const { deps, registered, store } = harness("local-only", {
        gh: recordingGh(ghArgv, "ABSENT"),
      });
      registerProject(deps);
      const dir = join(scratch("local-only-dir"), "product");

      const answered = await bootstrap(deps, "cmd-journey-local", {
        dir, github: GITHUB, ...PRODUCT,
      });

      // A bootstrap that failed wholesale without `gh` would be unusable on most machines.
      expect(answered).toMatchObject({ outcome: "ACCEPTED" });
      const log = gitLines(dir, ["log", "--oneline"]);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/ chore: scaffold by Moe$/u);
      expect(gitLines(dir, ["rev-parse", "--is-inside-work-tree"])).toEqual(["true"]);

      const receipt = committedReceipt(store);
      expect(receipt).toMatchObject({
        outcome: "BOOTSTRAPPED",
        // The GitHub half refused; the local half succeeded. Both facts on one receipt.
        githubRefusal: { code: "BOOTSTRAP_GH_UNAVAILABLE" },
        refusal: null,
        remoteUrl: null,
        version: BOOTSTRAP_RECEIPT_VERSION,
      });
      expect(receipt?.sha).toMatch(/^[a-f0-9]{40}$/u);
      expect(receipt?.dir).toBeTruthy();

      // BOUND THROUGH THE EXISTING HANDLER, not a second binding path: the durable ledger
      // carries a committed `project.bind_repository` decision, which only that handler writes.
      expect([...readDurableLedger(store, PROJECT).kinds].sort())
        .toEqual(["project.bind_repository", "project.register", "repository.bootstrap"]);
      // And the product is in the manager catalog.
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        productName: "journey-product", projectId: PROJECT,
      });
    });

  it("passes the gh CLI its exact argv, offline, when the GitHub half is requested",
    async () => {
      const ghArgv: string[][] = [];
      const { deps, store } = harness("gh-argv", { gh: recordingGh(ghArgv, "CREATED") });
      registerProject(deps);
      const dir = join(scratch("gh-argv-dir"), "product");

      const answered = await bootstrap(deps, "cmd-journey-gh", {
        dir, github: GITHUB, ...PRODUCT,
      });

      expect(answered).toMatchObject({ outcome: "ACCEPTED" });
      // BYTE FOR BYTE, in order.
      expect(ghArgv).toEqual([[
        "gh", "repo", "create", "journey-owner/journey-product", "--private",
        "--source", ".", "--push",
      ]]);
      expect(committedReceipt(store)).toMatchObject({
        githubRefusal: null, outcome: "BOOTSTRAPPED",
        remoteUrl: "https://github.com/journey-owner/journey-product",
      });
    });

  it("refuses BOOTSTRAP_PROFILE_VERSION_UNKNOWN with code and layer", async () => {
    const { deps, store } = harness("profile", { gh: recordingGh([], "ABSENT") });
    registerProject(deps);
    const dir = join(scratch("profile-dir"), "product");

    const answered = await bootstrap(deps, "cmd-journey-profile", {
      dir, productName: "journey-product", profileVersion: "controlled-999",
    });

    // Child 1 DEFINES this code (controlled-profile-generator.ts); this row is the call site
    // that raises it through the wired command. That composition is what the DoD asks for.
    expect(answered).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN", layer: "DAEMON_INGRESS" },
      stage: "DISPATCH",
    });
    expect(committedReceipt(store)).toMatchObject({
      outcome: "REFUSED", refusal: { code: "BOOTSTRAP_PROFILE_VERSION_UNKNOWN" }, sha: null,
    });
  });

  it("refuses BOOTSTRAP_GIT_UNAVAILABLE with code and layer when git cannot run", async () => {
    const { deps, store } = harness("git-absent", { gh: recordingGh([], "ABSENT") });
    registerProject(deps);
    // A path git will refuse to initialise: the tree write lands, the commit cannot.
    const dir = join(scratch("git-absent-dir"), "product");
    const originalPath = process.env["PATH"];
    process.env["PATH"] = join(scratch("empty-path"), "nothing");
    cleanups.push(() => {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    });

    const answered = await bootstrap(deps, "cmd-journey-git", { dir, ...PRODUCT });

    expect(answered).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_GIT_UNAVAILABLE", layer: "DAEMON_INGRESS" },
      stage: "DISPATCH",
    });
    expect(committedReceipt(store)).toMatchObject({
      outcome: "REFUSED", refusal: { code: "BOOTSTRAP_GIT_UNAVAILABLE" }, sha: null,
    });
  });

  it("refuses a non-durable non-human principal WITH ADMIN at the entry fence before effects",
    async () => {
      const dir = join(scratch("non-operator-dir"), "product");
      const { deps } = harness("non-operator", { gh: recordingGh([], "ABSENT") }, "agent-1");
      registerProject(deps); // ADMIN and the durable prerequisite pass; identity must refuse.

      const answered = await bootstrap(deps, "cmd-journey-non-operator", { dir, ...PRODUCT });

      expect(answered).toMatchObject({
        httpStatus: 403,
        outcome: "PORT_REFUSED",
        stage: "DISPATCH",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
      });
      // Fenced BEFORE the first byte: the directory was never created.
      expect(existsSync(dir)).toBe(false);
    });

  it("refuses a SECOND run against the same directory rather than appending a commit",
    async () => {
      const { deps } = harness("twice", { gh: recordingGh([], "ABSENT") });
      registerProject(deps);
      const dir = join(scratch("twice-dir"), "product");

      const first = await bootstrap(deps, "cmd-journey-twice-1", { dir, ...PRODUCT });
      expect(first).toMatchObject({ outcome: "ACCEPTED" });
      const second = await bootstrap(deps, "cmd-journey-twice-2", { dir, ...PRODUCT });

      expect(second).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "BOOTSTRAP_DIR_NOT_EMPTY", layer: "DAEMON_INGRESS" },
      });
      // Still exactly one commit: the retry appended nothing.
      expect(gitLines(dir, ["log", "--oneline"])).toHaveLength(1);
    });

  /**
   * `dir` IS OPERATOR INPUT and it selects where a whole tree gets written, so every shape it
   * can take needs a DEFINED answer rather than whatever the filesystem happens to do.
   * An absolute or escaping path is ALLOWED by design — the operator names the location — and
   * the emptiness guard is what protects an occupied one; that case is the arm above.
   */
  const HOSTILE_DIRS: readonly (readonly [string, string])[] = Object.freeze([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["UNC share", "\\\\server\\share\\product"],
    ["POSIX double slash", "//server/share/product"],
    ["control character", "C:\\bad\u0001dir"],
  ]);

  it("pins the hostile-dir roster as nonzero, so the sweep below cannot be vacuous", () => {
    expect(HOSTILE_DIRS.length).toBe(5);
  });

  it.each(HOSTILE_DIRS)("refuses a hostile dir (%s) with BOOTSTRAP_DIR_INVALID", async (
    label, dir,
  ) => {
    const { deps, store } = harness(`hostile-${label.replace(/\W/gu, "")}`, {
      gh: recordingGh([], "ABSENT"),
    });
    registerProject(deps);

    const answered = await bootstrap(deps, `cmd-journey-hostile-${label}`, { dir, ...PRODUCT });

    expect(answered, label).toMatchObject({
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_DIR_INVALID", layer: "DAEMON_INGRESS" },
      stage: "DISPATCH",
    });
    expect(committedReceipt(store), label).toMatchObject({ outcome: "REFUSED", sha: null });
    // AND NOTHING WAS CREATED. A malformed literal here once resolved to a writable relative
    // path and a whole scaffold landed outside the temp tree, so the refusal code alone is not
    // enough: the arm asserts the resolved target does not exist.
    if (dir.trim() !== "") expect(existsSync(resolve(dir)), label).toBe(false);
  });

  it("refuses a dir that is a FILE rather than a directory, leaving the file intact",
    async () => {
      const { deps } = harness("dir-is-file", { gh: recordingGh([], "ABSENT") });
      registerProject(deps);
      const dir = join(scratch("dir-is-file-parent"), "not-a-directory");
      writeFileSync(dir, "i am a file", "utf8");
      const before = digestOf(dir);

      const answered = await bootstrap(deps, "cmd-journey-dir-is-file", { dir, ...PRODUCT });

      expect(answered).toMatchObject({
        outcome: "PORT_REFUSED",
        refusal: { code: "BOOTSTRAP_DIR_INVALID", layer: "DAEMON_INGRESS" },
      });
      expect(digestOf(dir)).toBe(before);
    });

  it("keeps every refusal free of operator paths, remotes and exception text", async () => {
    const { deps } = harness("no-leak", { gh: recordingGh([], "ABSENT") });
    registerProject(deps);
    const dir = scratch("secret-named");
    writeFileSync(join(dir, "occupied.txt"), "x", "utf8");

    const answered = await bootstrap(deps, "cmd-journey-no-leak", {
      dir, github: GITHUB, ...PRODUCT,
    });

    // EPIC RAIL 3, asserted rather than assumed: the refusal a caller receives carries a closed
    // code, a closed detail and a layer, and NOTHING else -- no operator path, no remote URL,
    // no exception message. The keys are pinned exactly, so a widened refusal shape reds here.
    expect(answered.outcome).toBe("PORT_REFUSED");
    const refusal = (answered as unknown as { refusal: Record<string, unknown> }).refusal;
    expect(Object.keys(refusal).sort()).toEqual(["code", "detail", "httpStatus", "layer"]);
    expect(JSON.stringify(answered)).not.toContain(dir);
    expect(JSON.stringify(answered)).not.toContain("github.com");
    expect(JSON.stringify(answered)).not.toContain(GITHUB.owner);
  });
});
