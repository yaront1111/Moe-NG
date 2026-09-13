import { describe, expect, it } from "vitest";

import { loadPayloadHints } from "./wrapper-payload-hints.js";

/**
 * The loader moved out of agent-wrapper-main.ts with a RELATIVE module URL in it. The one way a
 * move like that fails is silently — the URL no longer resolves, the catch logs and answers null,
 * and every mission ships hintless again (the 2026-08-20 defect the loader's disclosure exists
 * for). So the resolution is asserted from the loader's new home, not assumed.
 */
describe("loadPayloadHints", () => {
  it("resolves the control room's dev payload table from its new home, logging nothing", async () => {
    const lines: string[] = [];
    const hints = await loadPayloadHints((line) => { lines.push(line); });
    expect(typeof hints?.payloadFor).toBe("function");
    expect(lines).toEqual([]);
  });
});
