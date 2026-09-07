import { afterEach, expect, it, vi } from "vitest";
import { mapDeploymentsAnswer, readDeployments } from "./live-deployments.js";
afterEach(() => vi.unstubAllGlobals());
/** The UNKNOWN observation the daemon emits for an environment with no readable migration. */
const unknownMigration = (environment = "preview") => ({ subject: "PROJECT_ENVIRONMENT", environment,
  state: "UNKNOWN", receiptId: null, outcome: null, migrations: null, backupState: null,
  backupSha256: null, refusalCode: null, refusalLayer: null, refusalFile: null,
  unknownCode: "MIGRATION_RECEIPT_ABSENT", unknownLayer: "DAEMON_INGRESS" });
const appliedMigration = (environment = "preview") => ({ ...unknownMigration(environment),
  state: "OBSERVED", receiptId: "e".repeat(64), outcome: "APPLIED",
  migrations: ["1700000000001-first.js"], backupState: "VERIFIED", backupSha256: "f".repeat(64),
  unknownCode: null, unknownLayer: null });
const frame = () => ({ outcome: "DEPLOYMENTS", goalRef: "goal-a", sha: "a".repeat(40), releaseDecision: null,
  environments: [{ environment: "preview", target: "local Docker (moe)", url: null,
    outcome: null, sha: null, time: null, code: null, detail: null, releaseDecision: null,
    migration: unknownMigration() }],
});
it("decodes deployment rows without inventing prior deployment receipts", () => {
  expect(mapDeploymentsAnswer(200, frame())).toMatchObject({ status: "DEPLOYMENTS", goalRef: "goal-a",
    environments: [{ environment: "preview", outcome: null, sha: null }] });
  expect(mapDeploymentsAnswer(200, { outcome: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND", layer: "REPOSITORY_WORKFLOW_READ" }))
    .toEqual({ status: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND", layer: "REPOSITORY_WORKFLOW_READ" });
});
it("rejects malformed, duplicated or executable-link environment rows", () => {
  for (const body of [{ ...frame(), sha: "wrong" }, { ...frame(), extra: true },
    { ...frame(), environments: [frame().environments[0], frame().environments[0]] },
    { ...frame(), environments: [{ ...frame().environments[0], url: "javascript:alert(1)" }] },
    { ...frame(), environments: [{ ...frame().environments[0], outcome: "DEPLOYED" }] },
  ]) expect(mapDeploymentsAnswer(200, body)).toMatchObject({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID" });
});

/**
 * THE MIGRATION MEMBER IS REQUIRED ON THE WIRE. A producer that forgets it, or that widens it,
 * is REFUSED — never rendered as an environment with nothing to say about its schema.
 */
it("decodes a migration observation and reads UNKNOWN apart from known-none", () => {
  const applied = mapDeploymentsAnswer(200, { ...frame(),
    environments: [{ ...frame().environments[0], migration: appliedMigration() }] });
  expect(applied).toMatchObject({ status: "DEPLOYMENTS" });
  if (applied.status !== "DEPLOYMENTS") throw new Error(applied.code);
  expect(applied.environments[0]?.migration).toEqual(appliedMigration());
  const unknown = mapDeploymentsAnswer(200, frame());
  if (unknown.status !== "DEPLOYMENTS") throw new Error(unknown.code);
  // null is "we could not tell"; [] would be "there was nothing". The decoder keeps them apart.
  expect(unknown.environments[0]?.migration?.migrations).toBeNull();
  expect(unknown.environments[0]?.migration?.state).toBe("UNKNOWN");
  expect(unknown.environments[0]?.migration?.unknownCode).toBe("MIGRATION_RECEIPT_ABSENT");
  const none = mapDeploymentsAnswer(200, { ...frame(), environments: [{ ...frame().environments[0],
    migration: { ...appliedMigration(), migrations: [] } }] });
  if (none.status !== "DEPLOYMENTS") throw new Error(none.code);
  expect(none.environments[0]?.migration?.migrations).toEqual([]);
});

it("accepts a batch up to the daemon's own cap and refuses only past it", () => {
  // The two caps AGREE. A tighter one here would blank the whole card for a large first
  // migration the daemon considered legitimate, so the boundary is asserted on both sides of it.
  const batch = (count: number) => Array.from({ length: count }, (_, index) => `170000000${String(index).padStart(4, "0")}-m.js`);
  const withBatch = (count: number) => ({ ...frame(), environments: [{ ...frame().environments[0],
    migration: { ...appliedMigration(), migrations: batch(count) } }] });
  const full = mapDeploymentsAnswer(200, withBatch(512));
  if (full.status !== "DEPLOYMENTS") throw new Error(full.code);
  expect(full.environments[0]?.migration?.migrations).toHaveLength(512);
  expect(mapDeploymentsAnswer(200, withBatch(513)))
    .toMatchObject({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID" });
  // A single over-long identifier is refused too, rather than rendered at 200 characters.
  expect(mapDeploymentsAnswer(200, { ...frame(), environments: [{ ...frame().environments[0],
    migration: { ...appliedMigration(), migrations: [`1700000000001-${"x".repeat(200)}.js`] } }] }))
    .toMatchObject({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID" });
});

it("refuses a missing, widened, mismatched or internally inconsistent migration member", () => {
  const row = frame().environments[0] as Record<string, unknown>;
  const { migration: _omitted, ...withoutMigration } = row;
  const bad = (migration: unknown) => ({ ...frame(), environments: [{ ...row, migration }] });
  for (const body of [
    // MISSING member, and an UNKNOWN key added beside it.
    { ...frame(), environments: [withoutMigration] },
    bad({ ...unknownMigration(), extra: true }),
    (() => { const { unknownLayer: _dropped, ...short } = unknownMigration(); return bad(short); })(),
    // MALFORMED members.
    bad(null), bad("UNKNOWN"), bad({ ...unknownMigration(), subject: "NODE" }),
    bad({ ...unknownMigration(), state: "MAYBE" }),
    bad({ ...appliedMigration(), outcome: "DEPLOYED" }),
    bad({ ...appliedMigration(), migrations: ["../escape.js"] }),
    bad({ ...appliedMigration(), receiptId: "not-a-hash" }),
    // The observation belongs to ANOTHER environment: refused, never shown on this row.
    bad(unknownMigration("production")),
    // A hash for a backup nobody verified, and a VERIFIED state with no hash.
    bad({ ...appliedMigration(), backupState: "UNVERIFIED" }),
    bad({ ...appliedMigration(), backupSha256: null }),
    // UNKNOWN that still claims facts, and OBSERVED that still claims an unknown code.
    bad({ ...unknownMigration(), outcome: "APPLIED" }),
    bad({ ...appliedMigration(), unknownCode: "MIGRATION_RECEIPT_INVALID" }),
    // A refusal word with no layer, a failing file with no refusal, REFUSED with no code.
    bad({ ...appliedMigration(), outcome: "REFUSED", refusalCode: "MIGRATION_FAILED" }),
    bad({ ...appliedMigration(), refusalFile: "1700000000001-first.js" }),
    bad({ ...appliedMigration(), outcome: "REFUSED" }),
  ]) expect(mapDeploymentsAnswer(200, body)).toMatchObject({ status: "ERROR", code: "DEPLOYMENTS_RESPONSE_INVALID" });
});
it("sends the exact goal selector and refuses a response for another goal", async () => {
  const fetcher = vi.fn(async () => ({ status: 200, json: async () => frame() }));
  vi.stubGlobal("fetch", fetcher);
  expect(await readDeployments({ "x-session": "test" }, "goal-b")).toMatchObject({ status: "ERROR" });
  expect(fetcher).toHaveBeenCalledWith("/deployments/read", expect.objectContaining({ method: "POST", body: JSON.stringify({ goalRef: "goal-b" }) }));
});
