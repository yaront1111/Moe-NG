import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { MAX_ENVIRONMENT_VALUE_BYTES, environmentValueFingerprint } from
  "./environment-contracts.js";
import {
  environmentAggregateId,
  readEnvironmentVariables,
  setEnvironmentVariable,
  unsetEnvironmentVariable,
} from "./environment-store.js";
import type { EnvironmentReadResult } from "./environment-store.js";
import { PROJECT_ID, cleanUp, configFor, openFileStore } from "./environment-test-fixtures.js";

/**
 * THE CANARY LEAK HUNT. A random `MOE_CANARY_<hex>` value goes in through the production write
 * path; every durable and returned surface is then searched for it.
 *
 * THE SEARCHES ARE OVER BYTES, NOT PARSED VALUES, and that is the whole point. A plaintext
 * surviving inside a serialised blob - a base64 field, a JSON string nobody destructured, a
 * SQLite page holding a superseded row - is invisible to `expect(read.value).toBeUndefined()`
 * and perfectly visible to anyone who opens the file. Parsed assertions are how this class of
 * feature leaks.
 *
 * THE STORE IS ON A REAL FILE, not in memory. An in-memory store has no bytes to grep, so
 * "the plaintext is not on disk" asserted against one would be vacuous.
 *
 * SQLITE IS IN WAL MODE (`SqliteEventStore.openForProject` opens with durability "WAL_FILE"), so
 * a freshly committed row can live entirely in `<db>-wal` and not yet in `<db>`. Every search
 * here therefore covers EVERY file in the store directory. Grepping only the `.db` would report
 * a clean result for bytes sitting in the WAL beside it.
 */

afterEach(cleanUp);

const PROD = "production";

/** A fresh canary per test: a shared constant could be matched by an unrelated fixture. */
function canary(): string {
  return `MOE_CANARY_${randomBytes(16).toString("hex")}`;
}

/** Every byte the store owns on disk: the database, its WAL and its shared-memory index. */
function storeBytes(directory: string, databasePath: string): Buffer {
  const prefix = basename(databasePath);
  const files = readdirSync(directory).filter((entry) => entry.startsWith(prefix));
  expect(files.length).toBeGreaterThan(0);
  return Buffer.concat(files.map((entry) => readFileSync(join(directory, entry))));
}

/** Every event on the aggregate, as the raw bytes the store handed back. */
function eventStreamBytes(store: SqliteEventStore): Buffer {
  const events = store.readEvents(environmentAggregateId(PROJECT_ID, PROD));
  expect(events.length).toBeGreaterThan(0);
  return Buffer.concat(events.map((event) => Buffer.from(event.payload)));
}

/** Every receipt the store minted for those events, serialised whole. */
function receiptBytes(store: SqliteEventStore): Buffer {
  const events = store.readEvents(environmentAggregateId(PROJECT_ID, PROD));
  const receipts = [...new Set(events.map((event) => event.commandId))]
    .map((commandId) => store.getCommandReceipt(commandId));
  expect(receipts.filter((receipt) => receipt !== null).length).toBe(receipts.length);
  expect(receipts.length).toBeGreaterThan(0);
  return Buffer.from(JSON.stringify(receipts), "utf8");
}

function responseBytes(...results: readonly EnvironmentReadResult[]): Buffer {
  expect(results.length).toBeGreaterThan(0);
  return Buffer.from(JSON.stringify(results), "utf8");
}

describe("the canary leak hunt", () => {
  it("leaves ZERO occurrences of the plaintext in the store FILE BYTES, the event stream, every read response and every receipt - while the FINGERPRINT is present", () => {
    const secret = canary();
    const { databasePath, directory, store } = openFileStore();
    const config = configFor(store);

    const written = setEnvironmentVariable(config, {
      environment: PROD, name: "CANARY_TOKEN", value: secret,
    });
    const read = readEnvironmentVariables(config, PROD);
    if (!written.ok || !read.ok) throw new Error("expected the canary write and read to be ok");

    const fingerprint = environmentValueFingerprint(secret);
    expect(read.variables[0]?.fingerprintSha256).toBe(fingerprint);

    const surfaces: readonly (readonly [string, Buffer])[] = [
      ["event stream", eventStreamBytes(store)],
      ["receipts", receiptBytes(store)],
      ["read responses", responseBytes(written, read)],
      // Read LAST so the WAL contains everything the commits produced.
      ["store file bytes", storeBytes(directory, databasePath)],
    ];

    for (const [label, bytes] of surfaces) {
      expect(`${label}: ${bytes.includes(secret)}`).toBe(`${label}: false`);
    }

    // The fingerprint IS present on disk and in the stream: absence of the plaintext must not be
    // achieved by the record being absent altogether.
    expect(storeBytes(directory, databasePath).includes(fingerprint)).toBe(true);
    expect(eventStreamBytes(store).includes(fingerprint)).toBe(true);
  });

  it("hides a value that is a SUBSTRING of nothing else, at several sizes, in every environment", () => {
    const { databasePath, directory, store } = openFileStore();
    const config = configFor(store);
    const secrets = [canary(), `${canary()}${"x".repeat(1_000)}`, canary().slice(0, 12)];
    for (const [index, environment] of ["preview", "production", "verify"].entries()) {
      const value = secrets[index] ?? canary();
      const result = setEnvironmentVariable(config, {
        environment, name: `CANARY_${index}`, value,
      });
      expect(result.ok).toBe(true);
    }
    const bytes = storeBytes(directory, databasePath);
    for (const secret of secrets) expect(bytes.includes(secret)).toBe(false);
  });

  it("keeps a MAXIMUM-SIZED value out of the bytes, where a truncated leak would hide", () => {
    const secret = `${canary()}${"z".repeat(MAX_ENVIRONMENT_VALUE_BYTES - 43)}`;
    expect(Buffer.byteLength(secret, "utf8")).toBe(MAX_ENVIRONMENT_VALUE_BYTES);
    const { databasePath, directory, store } = openFileStore();
    const written = setEnvironmentVariable(configFor(store), {
      environment: PROD, name: "BIG_CANARY", value: secret,
    });
    expect(written.ok).toBe(true);
    // Search for a 64-byte window as well as the whole value: a leak that stored only the first
    // page of a long secret would still be a leak, and the whole-value search would miss it.
    const bytes = storeBytes(directory, databasePath);
    expect(bytes.includes(secret)).toBe(false);
    expect(bytes.includes(secret.slice(0, 64))).toBe(false);
  });

  it("keeps the value out of a REFUSAL, including the refusal that is ABOUT the value", () => {
    const secret = canary();
    const { store } = openFileStore();
    const config = configFor(store);
    const refusals = [
      setEnvironmentVariable(config, { environment: "staging", name: "A_KEY", value: secret }),
      setEnvironmentVariable(config, { environment: PROD, name: "bad-name", value: secret }),
      setEnvironmentVariable(config, {
        environment: PROD,
        name: "TOO_BIG",
        value: `${secret}${"y".repeat(MAX_ENVIRONMENT_VALUE_BYTES)}`,
      }),
      setEnvironmentVariable({ ...config, credential: () => null }, {
        environment: PROD, name: "A_KEY", value: secret,
      }),
    ];
    for (const refusal of refusals) expect(refusal.ok).toBe(false);
    expect(responseBytes(...refusals).includes(secret)).toBe(false);
  });

  it("keeps the value out of a THROWN error, on every entry point", () => {
    const secret = canary();
    const { store } = openFileStore();
    // A delegate over the REAL store whose COMMIT throws. Every other method forwards to the
    // real instance BOUND TO IT - `SqliteEventStore` uses private fields, so a method invoked
    // with the delegate as `this` would throw a TypeError before reaching `commit`, and this arm
    // would pass on the wrong exception entirely.
    let committed = false;
    const throwing = new Proxy(store, {
      get(target, property) {
        if (property === "commit") {
          return () => {
            committed = true;
            throw new Error("durable store unavailable");
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const config = { ...configFor(store), store: throwing };
    let caught: unknown;
    try {
      setEnvironmentVariable(config, { environment: PROD, name: "A_KEY", value: secret });
    } catch (error) {
      caught = error;
    }
    // Proves the throw came from COMMIT, not from an earlier delegate mishap.
    expect(committed).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("durable store unavailable");
    const rendered = `${String(caught)}${(caught as Error).stack ?? ""}`;
    expect(rendered).not.toContain(secret);
  });
});

describe("the search itself", () => {
  /**
   * ANTI-VACUITY. Every "zero occurrences" assertion above is only worth what the search covers.
   * This arm proves the search is over real, populated bytes and that it CAN find a plaintext
   * there - so a green above means "no leak", not "nothing was read".
   */
  it("covers the WAL as well as the database file, and finds a plaintext planted in either", () => {
    const { databasePath, directory, store } = openFileStore();
    const marker = canary();
    // Plant the marker as a variable NAME, which is metadata and legitimately stored in the
    // clear. If the search cannot find THIS, it could not have found a leaked value either.
    const name = `PLANTED_${marker.slice(11, 27).toUpperCase()}`;
    expect(setEnvironmentVariable(configFor(store), {
      environment: PROD, name, value: "not-the-marker",
    }).ok).toBe(true);

    const files = readdirSync(directory).filter((entry) => entry.startsWith(basename(databasePath)));
    expect(files).toContain(`${basename(databasePath)}-wal`);
    expect(files.length).toBeGreaterThan(1);
    expect(storeBytes(directory, databasePath).includes(name)).toBe(true);

    // ...and the database file ALONE does not yet hold it, which is exactly why the union is
    // searched: a WAL-only assertion would have read a clean `.db` and reported no leak.
    expect(readFileSync(databasePath).includes(name)).toBe(false);
  });
});

describe("unset makes a value non-current WITHOUT erasing history", () => {
  it("keeps the CIPHERTEXT in the event stream after unset while the PLAINTEXT stays absent", () => {
    const secret = canary();
    const { databasePath, directory, store } = openFileStore();
    const config = configFor(store);

    setEnvironmentVariable(config, { environment: PROD, name: "TRANSIENT", value: secret });
    const sealedBefore = store
      .readEvents(environmentAggregateId(PROJECT_ID, PROD))
      .map((event) => Buffer.from(event.payload).toString("utf8"))
      .map((text) => (JSON.parse(text) as { readonly sealed?: string }).sealed)
      .find((sealed) => typeof sealed === "string");
    expect(typeof sealedBefore).toBe("string");

    const afterUnset = unsetEnvironmentVariable(config, {
      environment: PROD, name: "TRANSIENT",
    });
    if (!afterUnset.ok) throw new Error(`expected ok, got ${afterUnset.code}`);

    // The variable is no longer CURRENT...
    expect(afterUnset.variables).toEqual([]);
    expect(readEnvironmentVariables(config, PROD)).toMatchObject({ ok: true, variables: [] });

    // ...and the CIPHERTEXT is still in history, because the log is append-only. Asserting this
    // is what stops a reader mistaking `unset` for a scrub: an operator who pasted a production
    // secret and unset it has NOT erased it, only made it unreadable-without-the-credential.
    const stream = eventStreamBytes(store);
    expect(stream.includes(sealedBefore as string)).toBe(true);

    // The property that ACTUALLY matters survives the unset: still zero plaintext, anywhere.
    expect(stream.includes(secret)).toBe(false);
    expect(receiptBytes(store).includes(secret)).toBe(false);
    expect(storeBytes(directory, databasePath).includes(secret)).toBe(false);
  });

  it("still leaks nothing after a value is REPLACED, where the superseded plaintext would sit", () => {
    const first = canary();
    const second = canary();
    const { databasePath, directory, store } = openFileStore();
    const config = configFor(store);
    setEnvironmentVariable(config, { environment: PROD, name: "ROTATED", value: first });
    setEnvironmentVariable(config, { environment: PROD, name: "ROTATED", value: second });
    const read = readEnvironmentVariables(config, PROD);
    if (!read.ok) throw new Error(`expected ok, got ${read.code}`);
    expect(read.variables[0]?.fingerprintSha256).toBe(environmentValueFingerprint(second));
    const bytes = storeBytes(directory, databasePath);
    expect(bytes.includes(first)).toBe(false);
    expect(bytes.includes(second)).toBe(false);
  });
});
