/**
 * `/backups/read`, REACHED THROUGH THE PRODUCTION LISTENER (DoD 2).
 *
 * The port is NOT hand-built here: it is the one `createStoreDependencies` - i.e.
 * `daemon-store-foundation-composition.ts` - constructs over a real store, so every arm below
 * traverses composition -> FACTORIES -> resolveOptionalDaemonPorts -> the daemon-entry spread ->
 * StartListenerOptions -> the JSON_ROUTES roster -> the method guard -> the dispatch branch, and
 * back out over a real socket. Removing ANY of those links breaks it.
 *
 * WHY THAT MATTERS HERE. task-7ca9dca3 served `/design/read` and task-eb2bb09d then had to exist
 * PURELY to mount it: a served route nothing mounts satisfies every existence grep while the
 * feature does not exist. A test that built its own server and mounted the handler would have
 * passed for exactly that defect, so these arms refuse to build one.
 *
 * THE ARM THIS FILE EXISTS FOR: NOT_CHECKED arrives over the wire as NOT_CHECKED. Every link
 * listed above is a place it could collapse into PROVEN, and a handler-seam test can see none of
 * them. That is why the store-seam arm and this one must BOTH red when the mapping is mutated.
 *
 * WHAT A FAILURE MEANS. 503 LISTENER_BACKUPS_UNAVAILABLE = no port reached the listener. 404 =
 * the path never entered JSON_ROUTES. 200 with BACKUPS_READ_CAPABILITY_DENIED = the ADMIN
 * capability never reached the handler.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX, createBackupRestoreProofStore,
} from "./backups/backup-restore-proof.js";
import { nodeActivationReceiptPorts } from "./bootstrap/activation-receipts-measure.js";
import { nodeBackupPorts } from "./backups/backup-ports.js";
import { runScheduledBackup } from "./backups/scheduled-backup.js";
import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { fixtureDependencies } from "./daemon-entry-fixtures.js";
import { startDaemon } from "./daemon-entry.js";
import { resolveOptionalDaemonPorts } from "./daemon-entry-port-resolution.js";
import type { OptionalDaemonPortProvider } from "./daemon-entry-port-resolution.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http/http-test-fixtures.js";

const CSRF = "backups-csrf";
const PATH = "/backups/read";
const PROJECT = "proj-0001";
const ENVIRONMENT = "production";
const SHA = "a".repeat(64);
const CHECKED_AT = "2026-09-07T12:00:00.000Z";

const REF_PROVEN = "20260907120000000.sql";
const REF_FAILED = "20260907110000000.sql";
const REF_UNCHECKED = "20260907100000000.sql";

/**
 * A credential-shaped literal for the secret arms, long and punctuated so nothing a code, a
 * layer or a path mints by accident can satisfy it.
 */
const CONNECTION_STRING = "postgres://moe_admin:Sup3rS3cr3t-pw@db.internal.example:5432/moe_prod";
const PASSWORD = "Sup3rS3cr3t-pw";

async function post(
  started: { readonly origin: string; readonly port: number },
  path: string,
  body: unknown = {},
  method = "POST",
): Promise<{ readonly body: unknown; readonly raw: string; readonly status: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${started.port}`, origin: started.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      host: "127.0.0.1", method, path, port: started.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ body: JSON.parse(raw) as unknown, raw, status: response.statusCode ?? 0 });
      });
    });
    call.on("error", reject);
    call.end(payload);
  });
}

/** The listener really released the socket. A leaked port makes every later gate inadmissible. */
async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ host: "127.0.0.1", port });
    probe.on("connect", () => { probe.destroy(); resolve(false); });
    probe.on("error", () => { probe.destroy(); resolve(true); });
  });
}

interface World {
  readonly composed: ReturnType<typeof createStoreDependencies>;
  readonly directory: string;
  readonly storePath: string;
}

/**
 * The composition installs genesis and REFUSES a store that already carries history, so the
 * store is composed FIRST and the records are written after - which is also the real order of
 * events: a daemon boots, then backups happen.
 */
function world(name: string): World {
  const directory = mkdtempSync(join(tmpdir(), `moe-entry-${name}-`));
  const storePath = join(directory, "store.db");
  const composed = createStoreDependencies({
    credential: "backups-credential", principalId: "operator-local",
    projectId: PROJECT, storePath,
  });
  return { composed, directory, storePath };
}

/** Records written through the PRODUCTION writer, into the SAME sidecar the composition reads. */
function seed(open: World): ReturnType<typeof createBackupRestoreProofStore> {
  return createBackupRestoreProofStore(
    `${open.storePath}${BACKUP_RESTORE_PROOF_SIDECAR_SUFFIX}`, PROJECT,
  );
}

/** ANYTHING THIS TEST STARTS, IT STOPS (epic rail 4): the store handle and the temp tree, on
 * every exit path including the failure ones - this runs from a `finally`. */
function teardown(open: World): void {
  open.composed.close();
  rmSync(open.directory, { force: true, recursive: true });
}

async function boot(open: World, capabilities: readonly string[] = [CAPABILITIES.ADMIN]) {
  // Read the port off the composition ONCE and refuse to proceed without it. `backupReads` is
  // optional on the provider type, so `composed.backupReads?.()` would silently hand the entry
  // `undefined` and every arm below would then assert the 503 it exists to rule out.
  const port = open.composed.backupReads?.();
  if (port === undefined) throw new Error("composition supplied no backup restore-proof port");
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      backupReads: () => port,
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator(capabilities) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  return started;
}

const entries = (body: unknown): readonly Record<string, unknown>[] =>
  (body as { readonly backups: readonly Record<string, unknown>[] }).backups;

/**
 * THE ROW'S REASON FOR EXISTING, OVER A REAL SOCKET. Three records written through the
 * production writer into the same sidecar the composition reads, then read back off the wire.
 */
it("serves the three restore-proof states BY VALUE from a production boot", async () => {
  const open = world("backups");
  try {
    const records = seed(open);
    expect(records.recordChecked({
      checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_PROVEN,
      sha256: SHA, status: "VERIFIED",
    }).ok).toBe(true);
    expect(records.recordChecked({
      checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_FAILED,
      sha256: null, status: "FAILED",
    }).ok).toBe(true);
    expect(records.recordWritten({
      environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_UNCHECKED,
    }).ok).toBe(true);

    const started = await boot(open);
    try {
      const answer = await post(started, PATH, {});
      expect(answer.status).toBe(200);
      expect((answer.body as Record<string, unknown>)["ok"]).toBe(true);
      // BY VALUE and in full, off the wire: the whole chain from the persisted row to the frame.
      expect(entries(answer.body)).toStrictEqual([
        {
          checkedAt: CHECKED_AT, environment: ENVIRONMENT, ref: REF_PROVEN,
          restoreProof: "PROVEN", sha256: SHA,
        },
        {
          checkedAt: CHECKED_AT, environment: ENVIRONMENT, ref: REF_FAILED,
          restoreProof: "FAILED", sha256: null,
        },
        {
          checkedAt: null, environment: ENVIRONMENT, ref: REF_UNCHECKED,
          restoreProof: "NOT_CHECKED", sha256: null,
        },
      ]);
      const states = entries(answer.body).map((entry) => entry["restoreProof"]);
      // Three DISTINCT values. A collapse anywhere in the chain reds here while a
      // `backups.length === 3` arm would still pass.
      expect(new Set(states).size).toBe(3);
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * NOT_CHECKED ARRIVES AS NOT_CHECKED, its own arm over the socket. This is the property the row
 * exists to hold and the one a handler-seam test cannot certify: the record store, the
 * composition port, the resolution, the spread, the dispatch and the projection are six places
 * the third state could become the first, and only a real request crosses all six.
 */
it("never serves a backup nobody has checked as PROVEN through the composed listener", async () => {
  const open = world("backups-not-checked");
  try {
    expect(seed(open).recordWritten({
      environment: ENVIRONMENT, kind: "STORE", ref: REF_UNCHECKED,
    }).ok).toBe(true);
    const started = await boot(open);
    try {
      const answer = await post(started, PATH, {});
      // Pinned BEFORE indexing: a drill that makes the store refuse would otherwise red this
      // arm with a TypeError on `undefined[0]`, which is a red at the wrong assertion and one
      // layer away from vacuous. These two lines make the failure name itself.
      expect(answer.status).toBe(200);
      expect(Array.isArray(entries(answer.body))).toBe(true);
      const entry = entries(answer.body)[0];
      expect(entry?.["restoreProof"]).toBe("NOT_CHECKED");
      expect(entry?.["restoreProof"]).not.toBe("PROVEN");
      expect(entry?.["sha256"]).toBeNull();
      expect(entry?.["checkedAt"]).toBeNull();
      // Not an empty string either: an unchecked backup and a checked one with a blank digest
      // must not look alike to the decoder that renders this.
      expect(answer.raw).toContain('"restoreProof":"NOT_CHECKED"');
      expect(answer.raw).not.toContain('"restoreProof":"PROVEN"');
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * THE WRITE EDGE AND THE READ EDGE, JOINED. A real scheduled backup run persists through the
 * production writer, and its record comes back off the socket - so the fact that was computed
 * and reached nothing before this row now reaches an operator.
 */
it("serves a record that a real scheduled backup run persisted", async () => {
  const open = world("backups-run");
  try {
    const receipt = await runScheduledBackup(
      { environments: [], now: new Date(CHECKED_AT), projectRoot: open.directory, storePath: open.storePath },
      nodeBackupPorts(), nodeActivationReceiptPorts().fs, seed(open),
    );
    expect(receipt.backups[0]?.status).toBe("VERIFIED");
    const started = await boot(open);
    try {
      const served = entries((await post(started, PATH, {})).body);
      expect(served).toHaveLength(1);
      expect(served[0]?.["environment"]).toBe("store");
      expect(served[0]?.["restoreProof"]).toBe("PROVEN");
      expect(served[0]?.["sha256"]).toBe(receipt.backups[0]?.sha256);
      // The BASENAME only. The absolute path the run worked with never reaches the wire.
      expect(served[0]?.["ref"]).toBe("20260907120000000.sqlite");
      expect(String(served[0]?.["ref"])).not.toContain(open.directory);
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * The negative control for every arm above: a daemon composed with NO backups port refuses as
 * unavailable rather than inventing an answer. 503 is the listener's own refusal, distinct from
 * any 200 the store or the capability fence could produce - so the positive arms' 200 is
 * attributable to the port having ARRIVED. An absent port answering an empty list would report
 * "no backups" on a daemon that can see none of them.
 */
it("refuses as unavailable when the provider offers no backups port", async () => {
  const started = await startDaemon({
    csrfToken: CSRF,
    dependencies: {
      provide: () => ({ ...fixtureDependencies(), authenticator: authenticator([CAPABILITIES.ADMIN]) }),
    },
  });
  if (!started.ok) throw new Error(`daemon failed: ${started.code}`);
  const { port } = started;
  try {
    const answer = await post(started, PATH, {});
    expect(answer).toMatchObject({ body: { code: "LISTENER_BACKUPS_UNAVAILABLE" }, status: 503 });
    // Never an empty list and never a state: the refusal carries neither.
    expect(answer.raw).not.toContain("PROVEN");
    expect(answer.raw).not.toContain('"backups"');
  } finally {
    await started.shutdown();
  }
  // THE DAEMON THIS TEST STARTS, IT STOPS: the socket is really released.
  expect(await portIsFree(port)).toBe(true);
}, 60_000);

/**
 * The request fences over the socket, each with its own code and the listener's own layer. The
 * roster entry, the method guard and the dispatch branch are separate edits and either alone
 * leaves a hole, so reaching these codes at all pins all three.
 */
it("refuses an unknown key and a non-POST with their own codes, naming the layer", async () => {
  const open = world("backups-keys");
  try {
    const started = await boot(open);
    try {
      // A silently ignored `environment` filter is how a caller comes to believe it is looking
      // at one environment's backups while it is looking at every environment's.
      expect(await post(started, PATH, { environment: ENVIRONMENT }))
        .toMatchObject({
          body: { code: "LISTENER_BACKUPS_UNKNOWN_KEY", layer: "CONTROL_ROOM_LISTENER" },
          status: 400,
        });
      // The method guard, which is its own edit and would otherwise be unpinned.
      expect(await post(started, PATH, {}, "PUT"))
        .toMatchObject({
          body: { code: "LISTENER_BACKUPS_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER" },
          status: 400,
        });
      expect(await post(started, PATH, {}, "GET"))
        .toMatchObject({ body: { code: "LISTENER_BACKUPS_REQUEST_INVALID" }, status: 400 });
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/** The capability fence through the composed listener: 200 with the listener's layer, distinct
 * from the 503 above, so "it refused" cannot stand in for "the right layer refused". */
it("denies a principal without ADMIN through the composed listener", async () => {
  const open = world("backups-capability");
  try {
    const started = await boot(open, [CAPABILITIES.GOAL]);
    try {
      expect(await post(started, PATH, {})).toMatchObject({
        body: {
          code: "BACKUPS_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER",
          outcome: "REFUSED",
        },
        status: 200,
      });
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * DoD 6 OVER THE ACTUAL RESPONSE BYTES, success and failure alike. Asserted on `raw` rather than
 * on a parsed object, because a credential smuggled in a key name or a nested string would
 * survive a shape assertion and not this one.
 */
it("puts no credential, connection string or host path on the wire, on any path", async () => {
  // POSITIVE CONTROL: the literal really is credential-shaped, so the assertions cannot pass
  // merely because the needle was harmless.
  expect(CONNECTION_STRING).toContain("://");
  expect(CONNECTION_STRING).toContain(PASSWORD);

  const open = world("backups-secret");
  try {
    const records = seed(open);
    // The record store refuses a credential-shaped ref, so one can never be stored...
    expect(records.recordWritten({
      environment: ENVIRONMENT, kind: "POSTGRES", ref: CONNECTION_STRING,
    })).toStrictEqual({
      code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false,
    });
    expect(records.recordChecked({
      checkedAt: CHECKED_AT, environment: ENVIRONMENT, kind: "POSTGRES", ref: REF_PROVEN,
      sha256: SHA, status: "VERIFIED",
    }).ok).toBe(true);

    const started = await boot(open);
    try {
      // ... and every response body on this route is checked for one anyway.
      for (const answer of [
        await post(started, PATH, {}),
        await post(started, PATH, { databaseUrl: CONNECTION_STRING }),
        await post(started, PATH, {}, "PUT"),
      ]) {
        expect(answer.raw).not.toContain(PASSWORD);
        expect(answer.raw).not.toContain("postgres://");
        expect(answer.raw).not.toContain("db.internal.example");
        // No host path either: the daemon's own directory layout is not an operator's business
        // and is how a credential-bearing path would arrive if one ever existed.
        expect(answer.raw).not.toContain(open.directory);
        expect(answer.raw).not.toContain(tmpdir());
      }
    } finally {
      await started.shutdown();
    }
  } finally {
    teardown(open);
  }
}, 60_000);

/**
 * The RESOLUTION fence, at the link that a 404 would never reveal. A `backupReads` that is not a
 * function, or one whose port answers no `read` method, is refused as INVALID rather than
 * reaching the listener as a half-built port that would throw on the first request.
 */
it("refuses a backups factory that is not callable or answers no read method", () => {
  const invalid = { failure: "INVALID", ok: false };
  expect(resolveOptionalDaemonPorts({ backupReads: 7 } as unknown as OptionalDaemonPortProvider))
    .toEqual(invalid);
  expect(resolveOptionalDaemonPorts(
    { backupReads: () => ({}) } as unknown as OptionalDaemonPortProvider,
  )).toEqual(invalid);
  // The positive control: a well-formed factory resolves and the port arrives on the result, so
  // the two refusals above are attributable to the fence rather than to an always-INVALID path.
  const port = { read: () => Object.freeze({ ok: true as const, value: [] }) };
  expect(resolveOptionalDaemonPorts({ backupReads: () => port }))
    .toMatchObject({ ok: true, ports: { backupReads: port } });
  // And an entry that names NO backups factory resolves WITHOUT the key - never with an
  // assigned `undefined`, which under exactOptionalPropertyTypes is a different thing and is
  // what the daemon-entry spread is conditional to avoid.
  const bare = resolveOptionalDaemonPorts({});
  expect(bare.ok).toBe(true);
  expect(bare.ok && Object.hasOwn(bare.ports, "backupReads")).toBe(false);
});
