import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeStores, openStore, PROJECT_ID } from "../../bootstrap/bootstrap-test-fixtures.js";
import { revertLastBatch } from "./migration-down-service.js";
import { migrateWithBackup } from "./migration-service.js";
import type { MigrationDownPorts } from "./migration-down-ports.js";

const roots: string[] = [];
afterEach(() => { closeStores(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const first = ["1700000000001-first.js"];
const second = ["1700000000002-second.js", "1700000000003-third.js"];

async function world() {
  const projectRoot = mkdtempSync(join(tmpdir(), "moe-down-service-")); roots.push(projectRoot);
  const store = openStore();
  const schema = new Set<string>();
  const input = { projectRoot, workspace: projectRoot, projectId: PROJECT_ID, requestId: "revert",
    environment: "staging", toMigrationRequestId: "second", databaseUrl: "postgresql://localhost/fixture",
    now: new Date("2026-09-06T12:00:00.000Z") };
  for (const [index, batch] of [first, second].entries()) {
    await migrateWithBackup(store, { ...input, requestId: index === 0 ? "first" : "second",
      sha: "a".repeat(40), now: new Date(`2026-09-06T0${index}:00:00.000Z`) }, {
      dump: async (_connection, path) => { writeFileSync(path, "fixture backup"); },
      apply: async () => { for (const name of batch) schema.add(name); return batch; },
    });
  }
  let dumps = 0, reverts = 0;
  const ports: MigrationDownPorts = {
    dump: async (_connection, path) => { dumps += 1; writeFileSync(path, "fixture backup"); },
    revert: async (_workspace, _connection, batch) => {
      reverts += 1; for (const name of batch) schema.delete(name); return [...batch].reverse();
    },
  };
  return { input, store, ports, effects: () => ({ dumps, reverts }), schema: () => [...schema] };
}

describe("migration down engine receipt identity", () => {
  it("rejects an invalid request identity before backup or schema effects", async () => {
    const w = await world();
    const schema = w.schema();
    await expect(revertLastBatch(w.store, { ...w.input, requestId: "" }, w.ports))
      .rejects.toMatchObject({ code: "MIGRATION_RECEIPT_INVALID" });
    expect(w.effects()).toEqual({ dumps: 0, reverts: 0 });
    expect(w.schema()).toEqual(schema);
  });

  it("does not replay an applied receipt as a successful revert", async () => {
    const w = await world();
    await expect(revertLastBatch(w.store, { ...w.input, requestId: "second" }, w.ports))
      .rejects.toMatchObject({ code: "MIGRATION_RECEIPT_CONFLICT" });
    expect(w.effects()).toEqual({ dumps: 0, reverts: 0 });
  });

  it.each([
    { environment: "other" }, { toMigrationRequestId: "first" },
  ])("rejects a reverted receipt replay with different batch authority: %s", async overrides => {
    const w = await world();
    expect((await revertLastBatch(w.store, w.input, w.ports)).outcome).toBe("REVERTED");
    await expect(revertLastBatch(w.store, { ...w.input, ...overrides }, w.ports))
      .rejects.toMatchObject({ code: "MIGRATION_RECEIPT_CONFLICT" });
    expect(w.effects()).toEqual({ dumps: 1, reverts: 1 });
  });

  it("replays the exact named reversed batch without more effects", async () => {
    const w = await world();
    const receipt = await revertLastBatch(w.store, w.input, w.ports);
    expect(receipt).toMatchObject({ outcome: "REVERTED", applied: [...second].reverse() });
    expect(await revertLastBatch(w.store, w.input, w.ports)).toEqual(receipt);
    expect(w.effects()).toEqual({ dumps: 1, reverts: 1 });
    expect(w.schema()).toEqual(first);
  });
});
