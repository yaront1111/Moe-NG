/**
 * POST /backups/read at the HANDLER seam: what the route projects out of durable material it did
 * not write, and what it refuses. Reachability from the COMPOSED production listener is a
 * different question and is pinned in `daemon-entry-backups.test.ts` - a test that builds its own
 * server proves the handler works and says nothing about whether the daemon serves it, which is
 * the hole that forced task-eb2bb09d to exist after task-7ca9dca3.
 *
 * THE ARM THAT MATTERS: a record nobody restore-checked arrives as NOT_CHECKED. Every link
 * between the record and the wire is a place that could collapse into PROVEN, so it is asserted
 * BY VALUE here and again over a real socket in the entry test.
 */
import { expect, it } from "vitest";

import { BACKUP_RESTORE_PROOF_VERSION } from "../backups/backup-restore-proof.js";
import type {
  BackupRestoreProofRecord, BackupRestoreProofState,
} from "../backups/backup-restore-proof.js";
import { BACKUPS_READ_PATH, backupsReadBodyOf, handleBackupsReadRequest } from "./backups-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator, bytes } from "./http-test-fixtures.js";

const ADMIN = "project.admin";
const SHA = "a".repeat(64);
const CHECKED_AT = "2026-09-07T12:00:00.000Z";

/** Credential-shaped and unmistakable, so a `not.toContain` cannot pass on a harmless needle. */
const CONNECTION_STRING = "postgres://moe_admin:Sup3rS3cr3t-pw@db.internal.example:5432/moe_prod";
const PASSWORD = "Sup3rS3cr3t-pw";

function record(
  ref: string, restoreProof: BackupRestoreProofState,
  sha256: string | null, checkedAt: string | null, environment = "production",
): BackupRestoreProofRecord {
  return Object.freeze({
    checkedAt, environment, kind: "POSTGRES" as const, ref, restoreProof, sha256,
    version: BACKUP_RESTORE_PROOF_VERSION,
  });
}

const PROVEN = record("20260907120000000.sql", "PROVEN", SHA, CHECKED_AT);
const FAILED = record("20260907110000000.sql", "FAILED", null, CHECKED_AT);
const NOT_CHECKED = record("20260907100000000.sql", "NOT_CHECKED", null, null);

function ask(
  records: readonly BackupRestoreProofRecord[] | "UNAVAILABLE" | "INVALID",
  body: unknown = bytes({}),
  capabilities: readonly string[] = [ADMIN],
) {
  return handleBackupsReadRequest({
    authenticator: authenticator(capabilities),
    backupReads: {
      read: () => records === "UNAVAILABLE" || records === "INVALID"
        ? Object.freeze({
          code: records === "UNAVAILABLE"
            ? ("BACKUP_PROOF_STORE_UNAVAILABLE" as const) : ("BACKUP_PROOF_RECORD_INVALID" as const),
          layer: "DAEMON_INGRESS" as const, ok: false as const,
        })
        : Object.freeze({ ok: true as const, value: records }),
    },
  }, { body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });
}

const view = (result: ReturnType<typeof ask>): Record<string, unknown> => {
  if (result.kind !== "REPLY") throw new Error(`listener refusal: ${result.code}`);
  return result.body as unknown as Record<string, unknown>;
};

it("names its path where the roster and the dev proxy can find it", () => {
  expect(BACKUPS_READ_PATH).toBe("/backups/read");
});

it("serves the three restore-proof states BY VALUE, distinct and in record order", () => {
  const answer = ask([PROVEN, FAILED, NOT_CHECKED]);
  expect(answer).toMatchObject({ httpStatus: 200, kind: "REPLY" });
  const body = view(answer);
  expect(body["ok"]).toBe(true);
  expect(body["backups"]).toStrictEqual([
    {
      checkedAt: CHECKED_AT, environment: "production", ref: "20260907120000000.sql",
      restoreProof: "PROVEN", sha256: SHA,
    },
    {
      checkedAt: CHECKED_AT, environment: "production", ref: "20260907110000000.sql",
      restoreProof: "FAILED", sha256: null,
    },
    {
      checkedAt: null, environment: "production", ref: "20260907100000000.sql",
      restoreProof: "NOT_CHECKED", sha256: null,
    },
  ]);
  // THE THREE ARE DISTINCT BY VALUE. A projection that collapsed any pair reds here while a
  // `backups.length === 3` arm would still pass.
  const states = (body["backups"] as readonly { readonly restoreProof: string }[])
    .map((entry) => entry.restoreProof);
  expect(new Set(states).size).toBe(3);
  expect(states).toStrictEqual(["PROVEN", "FAILED", "NOT_CHECKED"]);
});

it("serves a backup nobody has checked as NOT_CHECKED and never as PROVEN", () => {
  const body = view(ask([NOT_CHECKED]));
  const entry = (body["backups"] as readonly Record<string, unknown>[])[0];
  // THE ROW'S SAFETY PROPERTY at the handler seam. The negative is what reds if the projection
  // ever grows a default, a `??` or a mapping that reaches PROVEN.
  expect(entry?.["restoreProof"]).toBe("NOT_CHECKED");
  expect(entry?.["restoreProof"]).not.toBe("PROVEN");
  // Absent is NULL, never "" and never 0: an empty string renders as a digest in one consumer
  // and as "no digest" in another.
  expect(entry?.["sha256"]).toBeNull();
  expect(entry?.["checkedAt"]).toBeNull();
  expect(entry?.["sha256"]).not.toBe("");
  expect(entry?.["checkedAt"]).not.toBe("");
});

it("answers an empty list for a project with no backups, distinct from a refusal", () => {
  const answer = ask([]);
  expect(answer).toStrictEqual({ body: { backups: [], ok: true }, httpStatus: 200, kind: "REPLY" });
});

it("carries the store's refusal VERBATIM with its own code and its own layer", () => {
  // Not reshaped into an empty list: "cannot read the backups" and "there are no backups" are
  // different answers and an operator acts differently on each.
  expect(ask("UNAVAILABLE")).toStrictEqual({
    body: { code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false },
    httpStatus: 200, kind: "REPLY",
  });
  expect(ask("INVALID")).toStrictEqual({
    body: { code: "BACKUP_PROOF_RECORD_INVALID", layer: "DAEMON_INGRESS", ok: false },
    httpStatus: 200, kind: "REPLY",
  });
});

it("refuses as UNAVAILABLE when no port reached it, rather than answering a default", () => {
  const result = handleBackupsReadRequest(
    { authenticator: authenticator([ADMIN]) },
    { body: bytes({}), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION },
  );
  // An empty list here would read as "no backups exist" on a daemon that can see none of them,
  // and a proven-looking frame would be worse. The only honest answer is unavailable.
  expect(result).toStrictEqual({ code: "LISTENER_BACKUPS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
});

it("denies a principal without ADMIN with its own code, layer and outcome", () => {
  expect(ask([PROVEN], bytes({}), ["goal.write"])).toStrictEqual({
    body: {
      code: "BACKUPS_READ_CAPABILITY_DENIED", layer: "CONTROL_ROOM_LISTENER", outcome: "REFUSED",
    },
    httpStatus: 200, kind: "REPLY",
  });
});

it("refuses an unknown key and undecodable bytes with DIFFERENT codes", () => {
  // A silently ignored `environment` filter is how a caller comes to believe it is looking at
  // one environment's backups while it is looking at every environment's.
  expect(ask([PROVEN], bytes({ environment: "production" })))
    .toStrictEqual({ code: "LISTENER_BACKUPS_UNKNOWN_KEY", kind: "LISTENER_REFUSAL" });
  expect(ask([PROVEN], bytes({ projectId: "proj-0001" })))
    .toStrictEqual({ code: "LISTENER_BACKUPS_UNKNOWN_KEY", kind: "LISTENER_REFUSAL" });
  expect(ask([PROVEN], bytes([])))
    .toStrictEqual({ code: "LISTENER_BACKUPS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  expect(ask([PROVEN], bytes("nope")))
    .toStrictEqual({ code: "LISTENER_BACKUPS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  expect(ask([PROVEN], bytes(null)))
    .toStrictEqual({ code: "LISTENER_BACKUPS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  expect(ask([PROVEN], new TextEncoder().encode("{not json")))
    .toStrictEqual({ code: "LISTENER_BACKUPS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  // The decoder, directly, so the exact-key contract is pinned independently of the handler.
  expect(backupsReadBodyOf(bytes({}))).toStrictEqual({ ok: true });
  expect(backupsReadBodyOf(bytes({ ok: true })))
    .toStrictEqual({ code: "LISTENER_BACKUPS_UNKNOWN_KEY", ok: false });
});

it("refuses an unauthenticated caller before it reads a single record", () => {
  let asked = false;
  const result = handleBackupsReadRequest({
    authenticator: authenticator([ADMIN]),
    backupReads: { read: () => { asked = true; return Object.freeze({ ok: true as const, value: [] }); } },
  }, { body: bytes({}), credential: "sess-wrong", protocolVersion: WIRE_PROTOCOL_VERSION });
  expect(result.kind).toBe("REPLY");
  expect(asked).toBe(false);
});

it("serialises no connection string on ANY path, success or failure", () => {
  // POSITIVE CONTROL: the literal really is credential-shaped, so the assertions below cannot
  // pass merely because the needle was harmless.
  expect(CONNECTION_STRING).toContain("://");
  expect(CONNECTION_STRING).toContain(PASSWORD);

  // A record whose ref holds a connection string. The store refuses to WRITE one, but this
  // route must not depend on that: any port wired here gets the same fence.
  const poisoned = record(CONNECTION_STRING, "NOT_CHECKED", null, null);
  const escaped = record("20260907100000000.sql", "PROVEN", SHA, CHECKED_AT, "../../etc");
  for (const answer of [
    ask([PROVEN, FAILED, NOT_CHECKED]), ask([]), ask("UNAVAILABLE"), ask("INVALID"),
    ask([PROVEN], bytes({ databaseUrl: CONNECTION_STRING })),
    ask([PROVEN], bytes({}), ["goal.write"]),
    ask([poisoned]), ask([PROVEN, poisoned]), ask([escaped]),
  ]) {
    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toContain("db.internal.example");
  }
  // And the whole-frame bytes for a well-formed answer carry no path separator at all: the
  // artifact basename is the only file-shaped value served, and it has none.
  const clean = JSON.stringify(view(ask([PROVEN, FAILED, NOT_CHECKED])));
  expect(clean).not.toContain("/");
  expect(clean).not.toContain("\\");
});

it("refuses a whole read whose records are inadmissible, rather than a shorter list", () => {
  // NOT a filtered list. A silently shorter answer reads as "these are all the backups", which
  // is the same class of lie as a false PROVEN, so the whole read refuses with its own code.
  const poisoned = record(CONNECTION_STRING, "NOT_CHECKED", null, null);
  const refusal = {
    body: {
      code: "BACKUPS_READ_RECORD_INVALID", layer: "CONTROL_ROOM_LISTENER", outcome: "REFUSED",
    },
    httpStatus: 200, kind: "REPLY",
  };
  expect(ask([poisoned])).toStrictEqual(refusal);
  // One bad record among good ones refuses the whole answer, so a caller can never be handed a
  // partial list it would read as complete.
  expect(ask([PROVEN, poisoned])).toStrictEqual(refusal);
  expect(ask([record("/var/lib/moe/20260907100000000.sql", "PROVEN", SHA, CHECKED_AT)]))
    .toStrictEqual(refusal);
  expect(ask([record("20260907100000000.sql", "PROVEN", SHA, CHECKED_AT, "../../etc")]))
    .toStrictEqual(refusal);
  // The good records still serve, so the guard is not simply refusing everything.
  expect(view(ask([PROVEN, FAILED, NOT_CHECKED]))["ok"]).toBe(true);
});
