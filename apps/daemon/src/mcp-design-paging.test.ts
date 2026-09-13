import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID } from "./bootstrap/bootstrap-test-fixtures.js";
import { readDesignRevision, submitDesignRevision } from "./design/design-store.js";
import { designRevisionFixture } from "./design/design-test-fixtures.js";
import { planningReadWorld } from "./mcp-planning-read-test-fixtures.js";
import { OPERATOR } from "./planning/plan-reject-test-fixtures.js";

afterAll(closeStores);

it("reconstructs a large stored design from bounded query pages without writes", async () => {
  const world = await planningReadWorld(false, true);
  try {
    const expected = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    const serialized = JSON.stringify(expected);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(39_000);
    const horizon = world.store.readEventHorizon();
    const decisions = world.store.readCommandDecisionCacheVersion();
    let offset = 0;
    let digest: unknown;
    const chunks: string[] = [];
    for (let index = 0; index < 100; index++) {
      const page = await world.call("design_read", index === 0 ? { goalRef: GOAL_ID } : {
        goalRef: GOAL_ID, offset, limit: 4096, version: 1, contentSha256: digest,
      });
      expect(page["format"]).toBe("moe-design-json-page/1");
      expect(page["version"]).toBe(1);
      expect(page["offset"]).toBe(offset);
      expect(page["contentSha256"]).toBe(createHash("sha256").update(serialized).digest("hex"));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
      digest = page["contentSha256"];
      const chunk = page["text"] as string;
      expect(chunk.length).toBeGreaterThan(0);
      chunks.push(chunk);
      offset += chunk.length;
      if (page["nextOffset"] === null) break;
      expect(page["nextOffset"]).toBe(offset);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(serialized);
    expect(JSON.parse(chunks.join(""))).toEqual(expected);
    expect(world.store.readEventHorizon()).toEqual(horizon);
    expect(world.store.readCommandDecisionCacheVersion()).toEqual(decisions);
    expect(world.dispatches.every((kind) => kind === "query")).toBe(true);
  } finally { await world.adapter.close(); }
});

it("requires valid continuation pins and refuses a changed design projection", async () => {
  const world = await planningReadWorld();
  try {
    const first = await world.call("design_read", { goalRef: GOAL_ID, offset: 0, limit: 100 });
    expect(first["format"]).toBe("moe-design-json-page/1");
    const next = { goalRef: GOAL_ID, offset: first["nextOffset"], version: first["version"], contentSha256: first["contentSha256"] };
    const bad = [ { offset: 1 }, { offset: 1, version: 1 }, { contentSha256: "a".repeat(64) },
      { offset: -1 }, { offset: null }, { offset: "0" }, { limit: 0 }, { limit: 4097 },
      { version: 1, contentSha256: "invalid" }, { projectId: "forged" }, { offset: 1.5 },
      { ...next, offset: 1_000_000 } ];
    for (const payload of bad) {
      expect(await world.call("design_read", { goalRef: GOAL_ID, ...payload })).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    expect(await world.call("design_read", { ...next, contentSha256: "0".repeat(64) })).toMatchObject({
      ok: false, code: "DESIGN_READ_REVISION_CHANGED", layer: "DESIGN_READ",
    });
    const submitted = submitDesignRevision(world.store, {
      commandId: "cmd-second-design", contractRef: world.ref, correlationId: "corr-second-design",
      decidedAt: "2026-09-06T00:00:01.000Z", expectedVersion: 1, goalRef: GOAL_ID,
      principalId: OPERATOR, projectId: PROJECT_ID, revision: designRevisionFixture(),
    });
    expect(submitted.ok).toBe(true);
    expect(await world.call("design_read", next)).toMatchObject({ ok: false, code: "DESIGN_READ_REVISION_CHANGED" });
    expect(await world.call("design_read", { goalRef: GOAL_ID, offset: 0 })).toMatchObject({ ok: true, version: 2 });
    expect(await world.call("design_read", { goalRef: GOAL_ID, version: 1 })).toMatchObject({ ok: true, record: { version: 1 } });
  } finally { await world.adapter.close(); }
});
