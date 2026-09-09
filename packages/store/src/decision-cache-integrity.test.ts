import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import { SqliteEventStore } from "./index.js";

describe("cached decision integrity after external writes", () => {
  it.each(["result", "receipt"] as const)("revalidates a warmed page after %s corruption", (field) => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-cache-"));
    const path = join(directory, "store.sqlite");
    const store = SqliteEventStore.openForProject(path, "project-1");
    try {
      store.commitExpectedVersionDecision(proposedDecision());
      expect(store.readCommandDecisionsAfter(0n).items).toHaveLength(1);
      const other = new DatabaseSync(path);
      try {
        if (field === "result") {
          other.prepare("UPDATE command_decisions SET result_bytes = ?").run(bytes("altered"));
        } else {
          other.prepare("UPDATE command_receipts SET effect_sha256 = ?").run("f".repeat(64));
        }
      } finally { other.close(); }
      expect(() => store.readCommandDecisionsAfter(0n)).toThrowError(/STORE_CORRUPT/u);
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
