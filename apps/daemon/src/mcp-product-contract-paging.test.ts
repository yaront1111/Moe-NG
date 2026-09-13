import { afterAll, expect, it } from "vitest";
import { closeStores, GOAL_ID } from "./bootstrap/bootstrap-test-fixtures.js";
import { planningReadWorld } from "./mcp-planning-read-test-fixtures.js";

afterAll(closeStores);

it("keeps a small unpaged contract response byte-for-byte compatible", async () => {
  const world = await planningReadWorld();
  try {
    expect(await world.call("product_contract_read", { goalRef: GOAL_ID })).toEqual(world.contract.read(GOAL_ID));
  } finally { await world.adapter.close(); }
});

it("pages a maximum-sized Unicode statement without dropping bytes or exceeding the response bound", async () => {
  const world = await planningReadWorld();
  try {
    const original = world.contract.read(GOAL_ID);
    if (!original.ok) throw new Error(original.code);
    // This substitution isolates projection paging from the already-tested durable reader.
    // The statement has the legal 32 KiB size; escapes and multibyte characters stress wire size.
    const statement = ('\u0001"\\😀 ').repeat(4096);
    expect(Buffer.byteLength(statement)).toBe(32_768);
    const answer = { ...original, revision: { ...original.revision,
      criteria: [{ criterionId: "criterion-unicode", requirementId: "req-api", statement }] } };
    world.setContractAnswer(answer);
    const text = JSON.stringify(answer);
    let offset = 0;
    let combined = "";
    let contentSha256: unknown;
    for (let index = 0; index < 100; index++) {
      const page = await world.call("product_contract_read", {
        goalRef: GOAL_ID, offset, limit: 4096,
        ...(index === 0 ? {} : { gateRef: world.ref, contentSha256 }),
      });
      expect(page["ok"]).toBe(true);
      expect(page["format"]).toBe("moe-product-contract-json-page/1");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
      expect(page["totalLength"]).toBe(text.length);
      const chunk = page["text"] as string;
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(4096);
      combined += chunk;
      offset += chunk.length;
      contentSha256 = page["contentSha256"];
      if (page["nextOffset"] === null) break;
      expect(page["nextOffset"]).toBe(offset);
    }
    expect(combined).toBe(text);
    expect(JSON.parse(combined).revision.criteria[0].statement).toBe(statement);
    const end = await world.call("product_contract_read", {
      goalRef: GOAL_ID, offset, gateRef: world.ref, contentSha256,
    });
    expect(end).toMatchObject({ ok: true, text: "", offset: text.length, nextOffset: null });
  } finally { await world.adapter.close(); }
});

it("refuses incomplete, invalid and out-of-range paging arguments", async () => {
  const world = await planningReadWorld();
  try {
    const first = await world.call("product_contract_read", { goalRef: GOAL_ID, offset: 0, limit: 64 });
    expect(first["format"]).toBe("moe-product-contract-json-page/1");
    const pins = { gateRef: world.ref, contentSha256: first["contentSha256"] };
    for (const extra of [
      { offset: -1 }, { offset: 0.5 }, { offset: "0" }, { offset: null },
      { limit: 0 }, { limit: -1 }, { limit: 4097 }, { limit: 1.5 }, { limit: null }, { limit: "20" },
      { offset: 1 }, { offset: 1, gateRef: world.ref }, { offset: 1, contentSha256: first["contentSha256"] },
      { offset: 1, ...pins, extra: true }, { offset: 1, ...pins, gateRef: { ...world.ref, extra: true } },
      { offset: 1, ...pins, contentSha256: "wrong" }, { offset: 1, ...pins, gateRef: null },
      { offset: Number(first["totalLength"]) + 1, ...pins },
    ]) {
      expect(await world.call("product_contract_read", { goalRef: GOAL_ID, ...extra }), JSON.stringify(extra))
        .toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    }
    const callsBefore = world.dispatches.length;
    expect(await world.call("product_contract_read", { goalRef: GOAL_ID, offset: Number.MAX_SAFE_INTEGER + 1 }))
      .toMatchObject({ transportError: { code: -32602, data: { code: "INPUT_INVALID" } } });
    expect(world.dispatches).toHaveLength(callsBefore);
  } finally { await world.adapter.close(); }
});

it("refuses a changed approval or projection instead of mixing contract pages", async () => {
  const world = await planningReadWorld();
  try {
    const first = await world.call("product_contract_read", { goalRef: GOAL_ID, offset: 0, limit: 32 });
    expect(first["format"]).toBe("moe-product-contract-json-page/1");
    const payload = { goalRef: GOAL_ID, offset: first["nextOffset"], gateRef: world.ref, contentSha256: first["contentSha256"] };
    expect(await world.call("product_contract_read", {
      ...payload, gateRef: { ...world.ref, revisionDigest: "f".repeat(64) },
    })).toMatchObject({ ok: false, code: "PRODUCT_CONTRACT_READ_REVISION_CHANGED" });
    const original = world.contract.read(GOAL_ID);
    if (!original.ok) throw new Error(original.code);
    world.setContractAnswer({ ...original, revision: { ...original.revision, requirements: [] } });
    expect(await world.call("product_contract_read", payload))
      .toMatchObject({ ok: false, code: "PRODUCT_CONTRACT_READ_REVISION_CHANGED" });
    world.setContractAnswer({ ok: false, code: "PRODUCT_CONTRACT_NOT_APPROVED", layer: "PRODUCT_CONTRACT_READ" });
    expect(await world.call("product_contract_read", payload))
      .toEqual({ ok: false, code: "PRODUCT_CONTRACT_NOT_APPROVED", layer: "PRODUCT_CONTRACT_READ" });
  } finally { await world.adapter.close(); }
});

it("refuses a forged transport credential before serving any contract page", async () => {
  const world = await planningReadWorld();
  try {
    const response = await world.rpc("tools/call", { name: "product_contract_read",
      arguments: { correlationId: "forged", payload: { goalRef: GOAL_ID, offset: 0 } } }, "forged-credential");
    expect(response.status).toBe(401);
    expect(world.dispatches).toEqual([]);
  } finally { await world.adapter.close(); }
});
