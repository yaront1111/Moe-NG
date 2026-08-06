import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { StoreRuntime } from "./store-runtime.js";

class SnapshotProbe extends StoreRuntime {
  public constructor(database: DatabaseSync, databasePath: string) {
    super(database, databasePath, "WAL_FILE", null, false);
  }

  public readMeasuredPayload(onMeasured: () => void): {
    readonly loadedBytes: number;
    readonly measuredBytes: number;
  } {
    return this.readSnapshotOperation("probe bounded read snapshot", () => {
      const measuredBytes = Number(
        this.database.prepare("SELECT length(payload) AS value FROM probe").get()?.value,
      );
      onMeasured();
      const payload = this.database.prepare("SELECT payload FROM probe").get()?.payload;
      if (!(payload instanceof Uint8Array)) {
        throw new Error("probe payload is not bytes");
      }
      return { loadedBytes: payload.byteLength, measuredBytes };
    });
  }
}

it("keeps size preflight and blob materialization on one WAL read snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-page-snapshot-"));
  const databasePath = join(directory, "snapshot.sqlite");
  let writer: DatabaseSync | undefined;
  let reader: SnapshotProbe | undefined;
  try {
    const readerDatabase = new DatabaseSync(databasePath);
    readerDatabase.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE probe (payload BLOB NOT NULL) STRICT;
      INSERT INTO probe (payload) VALUES (zeroblob(4));
    `);
    reader = new SnapshotProbe(readerDatabase, databasePath);
    writer = new DatabaseSync(databasePath);

    const observed = reader.readMeasuredPayload(() => {
      writer!.exec("UPDATE probe SET payload = zeroblob(4096)");
    });

    expect(observed).toEqual({ loadedBytes: 4, measuredBytes: 4 });
    expect(reader.readMeasuredPayload(() => undefined)).toEqual({
      loadedBytes: 4_096,
      measuredBytes: 4_096,
    });
  } finally {
    writer?.close();
    reader?.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
