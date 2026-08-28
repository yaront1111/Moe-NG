import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GOAL_CATALOG_CURSOR_CODES,
  MAX_GOAL_CATALOG_CURSOR_CHARS,
  decodeGoalCatalogCursor,
  encodeGoalCatalogCursor,
} from "./goal-catalog-cursor.js";

/**
 * The cursor is the only thing standing between a paginated read and a caller who decides where
 * the enumeration resumes. It is signed, so the tests here are about what a FORGED or REBOUND
 * cursor does, not about happy-path round trips alone.
 */
const SECRET = randomBytes(32);
const OTHER_SECRET = randomBytes(32);
const PROJECT = "project-1";
const BINDING = Object.freeze({ currentHorizon: 500n, projectId: PROJECT });

function encoded(overrides: {
  readonly after?: bigint;
  readonly horizon?: bigint;
  readonly projectId?: string;
  readonly secret?: Buffer;
} = {}): string {
  return encodeGoalCatalogCursor(overrides.secret ?? SECRET, {
    after: overrides.after ?? 256n,
    horizon: overrides.horizon ?? 400n,
    projectId: overrides.projectId ?? PROJECT,
  });
}

describe("the goal catalog cursor codec", () => {
  it("names exactly four refusal codes", () => {
    expect(GOAL_CATALOG_CURSOR_CODES).toStrictEqual([
      "GOAL_CATALOG_CURSOR_MALFORMED",
      "GOAL_CATALOG_CURSOR_OVERSIZED",
      "GOAL_CATALOG_CURSOR_PROJECT_MISMATCH",
      "GOAL_CATALOG_CURSOR_STALE",
    ]);
  });

  it("round-trips the pinned horizon and position it was issued for", () => {
    const decoded = decodeGoalCatalogCursor(SECRET, BINDING, encoded());

    expect(decoded).toStrictEqual({ after: 256n, horizon: 400n, ok: true });
  });

  it("carries bigints that exceed Number.MAX_SAFE_INTEGER without loss", () => {
    const after = 9_007_199_254_740_993n;
    const horizon = 9_007_199_254_740_995n;
    const decoded = decodeGoalCatalogCursor(
      SECRET, { currentHorizon: horizon, projectId: PROJECT }, encoded({ after, horizon }),
    );

    expect(decoded).toStrictEqual({ after, horizon, ok: true });
  });

  it.each([
    ["not base64url", "not a cursor!!"],
    ["no signature separator", "eyJhIjoxfQ"],
    ["payload that is not JSON", `${Buffer.from("nope").toString("base64url")}.AAAA`],
  ])("refuses %s as MALFORMED", (_label, value) => {
    expect(decodeGoalCatalogCursor(SECRET, BINDING, value))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_MALFORMED", ok: false });
  });

  it("refuses a cursor signed with another secret as MALFORMED", () => {
    expect(decodeGoalCatalogCursor(SECRET, BINDING, encoded({ secret: OTHER_SECRET })))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_MALFORMED", ok: false });
  });

  /**
   * The LAST byte of the signature, so a comparison that stopped early — or that compared
   * lengths only — would still admit it. This is the arm that binds `timingSafeEqual` over the
   * whole digest rather than a prefix.
   */
  it("refuses a cursor whose signature differs only in its final byte", () => {
    const value = encoded();
    const separator = value.lastIndexOf(".");
    const signature = value.slice(separator + 1);
    const last = signature.slice(-1);
    const tampered = `${value.slice(0, separator + 1)}${signature.slice(0, -1)}${
      last === "A" ? "B" : "A"
    }`;

    expect(tampered).not.toBe(value);
    expect(tampered).toHaveLength(value.length);
    expect(decodeGoalCatalogCursor(SECRET, BINDING, tampered))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_MALFORMED", ok: false });
  });

  it("refuses a cursor issued for another project even though its signature verifies", () => {
    expect(decodeGoalCatalogCursor(SECRET, BINDING, encoded({ projectId: "project-attacker" })))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_PROJECT_MISMATCH", ok: false });
  });

  it("refuses a cursor whose pinned horizon is ahead of the store's as STALE", () => {
    expect(decodeGoalCatalogCursor(SECRET, BINDING, encoded({ horizon: 501n })))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_STALE", ok: false });
  });

  it("accepts a pinned horizon equal to the store's, which is the ordinary continuation", () => {
    expect(decodeGoalCatalogCursor(SECRET, BINDING, encoded({ horizon: 500n })))
      .toMatchObject({ horizon: 500n, ok: true });
  });

  it("refuses an oversized cursor before it decodes anything", () => {
    const oversized = "a".repeat(MAX_GOAL_CATALOG_CURSOR_CHARS + 1);

    expect(oversized.length).toBeGreaterThan(MAX_GOAL_CATALOG_CURSOR_CHARS);
    expect(decodeGoalCatalogCursor(SECRET, BINDING, oversized))
      .toStrictEqual({ code: "GOAL_CATALOG_CURSOR_OVERSIZED", ok: false });
  });

  it("issues cursors that stay well inside the size bound", () => {
    expect(encoded().length).toBeLessThanOrEqual(MAX_GOAL_CATALOG_CURSOR_CHARS);
  });
});
