import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECOVERY_BINDING_CODEC_VERSION, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { ensureGenesisRecoveryBinding } from "./genesis-recovery-binding.js";
import { createSessionAuthenticator } from "./session-authenticator.js";
import { envelope, hashOf, openPayload, send } from "./session-test-fixtures.js";

/**
 * The first-boot acceptance, driven through the REAL production path.
 *
 * `createStoreDependencies` is the factory the daemon bin's
 * `--dependencies=src/daemon-store-dependencies.ts` provider itself calls, so
 * every journey below opens a store, fences it and authenticates exactly the way
 * a shipped daemon does. Nothing here hand-installs the binding under test and
 * nothing reimplements the authenticator: a fixture that wrote the ACTIVE row
 * itself would prove the decoder while leaving the installer — the half that
 * produced the live symptom — completely untested.
 */

const PROJECT = "proj-genesis-first-boot";
const PRINCIPAL = "operator-local";
const CREDENTIAL = "operator-first-boot-credential";
const SESSION_CREDENTIAL = "session-bearer-under-the-fence";
const CLOCK = (): string => "2026-08-15T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2126-01-01T00:00:00.000Z";

const RESTORE_INCARNATION = "71".repeat(32);
const RESTORE_KEY_EPOCH = "72".repeat(32);
const SUCCESSOR_INCARNATION = "73".repeat(32);
const SUCCESSOR_KEY_EPOCH = "74".repeat(32);

const cleanups: (() => void)[] = [];

afterEach(() => {
  // LIFO, and every SQLite handle is registered AFTER its directory: on Windows
  // a live handle makes rmSync throw EPERM and kills the vitest worker outright,
  // with zero test output, reading as a native crash rather than as a leak.
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      // Teardown must never mask the failure that caused it.
    }
  }
});

function freshStoreDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `moe-first-boot-${label}-`));
  cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  return join(root, "store.db");
}

function bootDaemon(storePath: string): ReturnType<typeof createStoreDependencies> {
  const provider = createStoreDependencies({
    clock: CLOCK,
    credential: CREDENTIAL,
    principalId: PRINCIPAL,
    projectId: PROJECT,
    storePath,
  });
  cleanups.push(() => provider.close());
  return provider;
}

function openHandle(storePath: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  cleanups.push(() => store.close());
  return store;
}

/** The restore path's own installer, replacing whatever the slot holds. */
function installRestoreBinding(
  store: SqliteEventStore,
  incarnationRef: string,
  keyEpochRef: string,
): void {
  const installed = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef,
    payload: new TextEncoder().encode(`restore-binding-${incarnationRef.slice(0, 8)}`),
    slot: "ACTIVE",
  });
  expect(installed).toMatchObject({ ok: true, outcome: "INSTALLED" });
}

interface SlotBytes {
  readonly digest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payload: readonly number[];
}

/** The ACTIVE row as bytes, so a clobber is detected rather than inferred. */
function readSlotBytes(store: SqliteEventStore): SlotBytes {
  const row = store.readRecoveryBinding("ACTIVE");
  if (!row.ok || row.outcome !== "FOUND") {
    throw new Error(`the ACTIVE slot must be FOUND, got ${row.ok ? row.outcome : row.code}`);
  }
  return Object.freeze({
    digest: row.bindingDigest,
    incarnationRef: row.binding.incarnationRef,
    keyEpochRef: row.binding.keyEpochRef,
    payload: [...row.binding.payload],
  });
}

/** Opens a bearer session through the PRODUCTION session command. */
function openSession(store: SqliteEventStore, sessionId: string, commandId: string): void {
  const outcome = send(
    store,
    envelope(
      "session.open",
      0,
      openPayload({
        capabilities: ["work.claim"],
        credentialSha256: hashOf(SESSION_CREDENTIAL),
        expiresAt: SESSION_EXPIRES_AT,
        sessionId,
      }),
      commandId,
      { projectId: PROJECT },
    ),
  );
  if (!outcome.ok) throw new Error(`session.open setup failed: ${outcome.code}`);
}

function authenticatorOver(store: SqliteEventStore) {
  return createSessionAuthenticator(store, {
    clock: () => Date.parse("2026-08-15T00:00:00.000Z"),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: CREDENTIAL,
    operatorPrincipalId: PRINCIPAL,
    projectId: PROJECT,
  });
}

describe("genesis first boot — a store that has never been restored", () => {
  it("authenticates the operator through the real dependency factory", () => {
    const storePath = freshStoreDirectory("succeeds");
    const provider = bootDaemon(storePath);

    // Positively established, not assumed: the store is fenced by GENESIS, so no
    // restore has run and the binding cannot have come from the restore path.
    expect(provider.restore().inspect()).toMatchObject({ ok: true, outcome: "GENESIS_FENCED" });

    const result = provider.provide().authenticator.authenticate(CREDENTIAL);

    // SUCCESS asserted WHOLE — not "nothing threw", and not "!== REFUSED". An
    // authenticator that returned UNAUTHENTICATED forever, which is precisely the
    // defect this task exists to close, passes both of those weaker checks.
    expect(result).toEqual({
      principal: {
        capabilities: [...OPERATOR_CAPABILITIES],
        principalId: PRINCIPAL,
        projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    });
  });

  it("issues a session under the genesis fence that authenticates as itself", () => {
    const storePath = freshStoreDirectory("session");
    const provider = bootDaemon(storePath);
    const store = openHandle(storePath);
    openSession(store, "session-under-genesis", "cmd-open-under-genesis");

    expect(provider.provide().authenticator.authenticate(SESSION_CREDENTIAL)).toEqual({
      principal: {
        capabilities: ["work.claim"],
        principalId: "session-under-genesis",
        projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    });
  });
});

describe("genesis first boot — a store already bound by the restore path", () => {
  it("leaves the restore-installed row byte-identical and settles PRESENT", () => {
    const storePath = freshStoreDirectory("restore-bound");
    const seed = openHandle(storePath);
    installRestoreBinding(seed, RESTORE_INCARNATION, RESTORE_KEY_EPOCH);
    const before = readSlotBytes(seed);

    bootDaemon(storePath);

    // Byte-identical, digest included: a re-mint that happened to reproduce equal
    // refs would slip past a ref-only comparison, so the stored bytes decide.
    expect(readSlotBytes(seed)).toEqual(before);
    expect(before.incarnationRef).toBe(RESTORE_INCARNATION);

    // And the genesis path itself reports PRESENT rather than INSTALLED, so it is
    // not a second way to satisfy the fence for an already-bound store.
    const settled = ensureGenesisRecoveryBinding(seed, { clock: CLOCK, projectId: PROJECT });
    expect(settled).toMatchObject({ ok: true, outcome: "PRESENT" });
    expect(readSlotBytes(seed)).toEqual(before);
  });

  it("keeps authenticating against the restore identity after a boot", () => {
    const storePath = freshStoreDirectory("restore-auth");
    const seed = openHandle(storePath);
    installRestoreBinding(seed, RESTORE_INCARNATION, RESTORE_KEY_EPOCH);
    openSession(seed, "session-under-restore", "cmd-open-under-restore");

    const provider = bootDaemon(storePath);

    expect(provider.provide().authenticator.authenticate(SESSION_CREDENTIAL)).toEqual({
      principal: {
        capabilities: ["work.claim"],
        principalId: "session-under-restore",
        projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    });
  });
});

describe("genesis first boot — the authentication fence still refuses", () => {
  it("refuses a session from a prior incarnation with SESSION_REPLAYED at IDENTITY", () => {
    const storePath = freshStoreDirectory("replayed");
    const provider = bootDaemon(storePath);
    const store = openHandle(storePath);
    openSession(store, "session-under-genesis", "cmd-open-under-genesis");
    expect(provider.provide().authenticator.authenticate(SESSION_CREDENTIAL))
      .toMatchObject({ verdict: "AUTHENTICATED" });

    // A succeeding incarnation takes the slot; the session's refs are now stale.
    installRestoreBinding(store, SUCCESSOR_INCARNATION, SUCCESSOR_KEY_EPOCH);

    // The EXACT refusal, whole: code, detail, transport status and the layer that
    // answered. A test asserting only "not AUTHENTICATED" would stay green if the
    // ledger fold started refusing first, which is a different guard entirely —
    // that one answers UNAUTHENTICATED and carries no refusal at all.
    expect(provider.provide().authenticator.authenticate(SESSION_CREDENTIAL)).toEqual({
      refusal: {
        code: "SESSION_REPLAYED",
        detail: "The session belongs to a prior recovery incarnation or key epoch.",
        httpStatus: 401,
        layer: "IDENTITY",
      },
      verdict: "REFUSED",
    });
  });

  it("refuses the operator on an unbound store, silently and without a refusal", () => {
    // The fence genesis exists to satisfy, proven still closed: a store with no
    // ACTIVE binding must not authenticate the operator. UNAUTHENTICATED rather
    // than REFUSED pins WHICH branch answered — the null-binding check inside the
    // operator arm, not the incarnation comparison below it.
    const storePath = freshStoreDirectory("unbound");
    const store = openHandle(storePath);
    expect(store.readRecoveryBinding("ACTIVE")).toMatchObject({ outcome: "ABSENT" });

    expect(authenticatorOver(store).authenticate(CREDENTIAL))
      .toEqual({ verdict: "UNAUTHENTICATED" });
  });
});

const SMOKE_TIMEOUT_MILLISECONDS = 90_000;
const WORKER_PATH = fileURLToPath(new URL("./genesis-first-boot-worker.mjs", import.meta.url));

interface ChildRun {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * A REAL child Node process, which vitest cannot substitute for.
 *
 * vitest rewrites a `./foo.js` specifier back to `foo.ts` and resolves workspace
 * packages through its own aliasing; Node does neither. Every in-repo suite above
 * is therefore blind to a missing `.js` bridge or an undeclared workspace
 * dependency anywhere under the daemon's composition root — only this run sees
 * them. Resolves with the exit code instead of rejecting on it, so a non-zero
 * exit is asserted rather than surfacing as an opaque thrown error.
 */
function runFirstBootSmoke(storePath: string): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", WORKER_PATH],
      {
        env: {
          ...process.env,
          MOE_DAEMON_CREDENTIAL: CREDENTIAL,
          MOE_PRINCIPAL_ID: PRINCIPAL,
          MOE_PROJECT_ID: PROJECT,
          MOE_STORE_PATH: storePath,
        },
        timeout: SMOKE_TIMEOUT_MILLISECONDS,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error === null) {
          resolve({ code: 0, stderr, stdout });
          return;
        }
        // A spawn failure or a timeout carries a string or absent `code`, never
        // an exit status. Rejecting BY NAME there keeps "the child never ran"
        // from being reported as "the child exited non-zero", which would send a
        // reader hunting inside the daemon for a fault in the harness.
        const exitCode = error.code;
        if (typeof exitCode !== "number") {
          reject(new Error(`first-boot smoke could not run: ${error.message}`));
          return;
        }
        resolve({ code: exitCode, stderr, stdout });
      },
    );
  });
}

describe("genesis first boot — the plain-Node smoke", () => {
  it("boots a never-restored store and authenticates outside vitest, exiting 0", async () => {
    const storePath = freshStoreDirectory("plain-node");

    const run = await runFirstBootSmoke(storePath);

    // The exit code AND the verdict. Exit 0 alone would pass against a child that
    // printed nothing; the verdict alone would pass against one that authenticated
    // and then died in teardown.
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(run.stdout)).toEqual({
      capabilities: [...OPERATOR_CAPABILITIES],
      ok: true,
      principalId: PRINCIPAL,
      projectId: PROJECT,
      // Fenced by GENESIS in a runtime that never ran a restore, so the binding
      // cannot have come from the restore path.
      restoreOutcome: "GENESIS_FENCED",
      verdict: "AUTHENTICATED",
    });
  }, SMOKE_TIMEOUT_MILLISECONDS + 30_000);
});
