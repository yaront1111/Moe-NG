import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { closeStores, GOAL_ID } from "./bootstrap/bootstrap-test-fixtures.js";
import { designRevisionFixture } from "./design/design-test-fixtures.js";
import { planningReadWorld } from "./mcp-planning-read-test-fixtures.js";

afterAll(closeStores);

it("advertises design_read as a query and reads the stored design through MCP tools/call", async () => {
  const world = await planningReadWorld();
  try {
    const listing = await (await world.rpc("tools/list", {})).json() as {
      result: { tools: { name: string; inputSchema: { required: string[]; properties: object } }[] };
    };
    const read = listing.result.tools.find((tool) => tool.name === "design_read");
    expect(read?.inputSchema.required).toEqual(["correlationId", "payload"]);
    expect(read?.inputSchema.properties).not.toHaveProperty("commandId");
    expect(read?.inputSchema.properties).not.toHaveProperty("expectedVersion");
    expect(await world.call("design_read", { goalRef: GOAL_ID })).toMatchObject({
      ok: true, record: { goalRef: GOAL_ID, version: 1, revision: designRevisionFixture() }, versions: [1],
    });
    expect(world.dispatches).toEqual(["query"]);
  } finally { await world.adapter.close(); }
});

it("reads every approved criterion and requirement over bounded revision-pinned MCP pages", async () => {
  const world = await planningReadWorld(true);
  try {
    const approved = world.contract.read(GOAL_ID);
    const serialized = JSON.stringify(approved);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(69_300);
    const chunks: string[] = [];
    let offset = 0;
    let digest: unknown;
    for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
      const page = await world.call("product_contract_read", pageNumber === 0 ? { goalRef: GOAL_ID } : {
        goalRef: GOAL_ID, offset, limit: 4096, gateRef: world.ref, contentSha256: digest,
      });
      expect(page["format"]).toBe("moe-product-contract-json-page/1");
      expect(page["ok"]).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
      expect(page["gateRef"]).toEqual(world.ref);
      expect(page["offset"]).toBe(offset);
      expect(page["totalLength"]).toBe(serialized.length);
      expect(page["contentSha256"]).toBe(createHash("sha256").update(serialized).digest("hex"));
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
    const reconstructed = JSON.parse(chunks.join(""));
    expect(reconstructed).toEqual(approved);
    expect(reconstructed.revision.criteria).toHaveLength(180);
    expect(new Set(reconstructed.revision.criteria.map((item: { criterionId: string }) => item.criterionId)).size).toBe(180);
    expect(reconstructed.revision.requirements).toHaveLength(180);
    expect(world.dispatches.every((surface) => surface === "query")).toBe(true);
  } finally { await world.adapter.close(); }
});
