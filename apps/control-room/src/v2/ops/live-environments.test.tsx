import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { BackupsOutcome } from "../../live/live-backups.js";
import { mapBackupsAnswer } from "../../live/live-backups.js";
import type { DeploymentsOutcome } from "../../live/live-deployments.js";
import { mapDeploymentsAnswer } from "../../live/live-deployments.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { BACKUPS_READ_FAILED, LiveEnvironments } from "./live-environments.js";
import { LiveHealth } from "./live-ops.js";

/**
 * THE ENVIRONMENTS SECTION ON THE WIRE. Both bodies go through their PRODUCTION decoders rather
 * than being hand-built view objects, so no arm asserts against a shape a decoder would refuse.
 * The bodies themselves are written here; the durable link to what the DAEMON declares is
 * `environments-daemon-frame.test.tsx`, and the enumeration arms are in
 * `live-environments-enumeration.test.tsx`.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const catalogOf = (...goalIds: readonly string[]): GoalCatalogFrame => ({
  connection: "CONNECTED",
  detail: "",
  goals: goalIds.map((goalId) => ({
    binding: { byteLength: 1, contentSha256: "a".repeat(64), sourceAggregateId: "s", sourceRef: "r" },
    brief: null,
    goalId,
    planningRunRef: "run-1",
    truthClass: "HUMAN_APPROVED" as const,
  })),
  outcome: "GOALS" as const,
});

const environmentRow = (environment: string, outcome: "DEPLOYED" | "REFUSED"): Record<string, unknown> => ({
  code: outcome === "REFUSED" ? "DEPLOY_BUILD_FAILED" : null,
  detail: null,
  environment,
  // The migration observation rides every environment row on the wire. A deployed environment
  // whose schema evidence was never written is UNKNOWN, not "nothing to apply".
  migration: {
    backupSha256: null, backupState: null, environment, migrations: null, outcome: null,
    receiptId: null, refusalCode: null, refusalFile: null, refusalLayer: null,
    state: "UNKNOWN", subject: "PROJECT_ENVIRONMENT",
    unknownCode: "MIGRATION_RECEIPT_ABSENT", unknownLayer: "DAEMON_INGRESS",
  },
  outcome,
  releaseDecision: null,
  sha: outcome === "DEPLOYED" ? "c".repeat(40) : null,
  target: "fly",
  time: outcome === "DEPLOYED" ? "2026-09-07T09:00:00.000Z" : null,
  url: outcome === "DEPLOYED" ? "https://example.test" : null,
});

function deploymentsOf(goalRef: string, ...rows: readonly Record<string, unknown>[]): DeploymentsOutcome {
  const answer = mapDeploymentsAnswer(200, {
    environments: rows, goalRef, outcome: "DEPLOYMENTS", releaseDecision: null, sha: "c".repeat(40),
  });
  if (answer.status !== "DEPLOYMENTS") throw new Error(`deployments fixture did not decode: ${answer.code}`);
  return answer;
}

function healthOf(environment: string, state: string): DeploymentsHealthOutcome {
  const answer = mapDeploymentsHealthAnswer(200, {
    environment, incident: null, lastError: null,
    lastProbe: { at: "2026-09-07T09:55:00.000Z", latencyMs: 44, status: "SUCCESS" },
    latencySeries: { points: [{ at: "2026-09-07T09:55:00.000Z", latencyMs: 44 }], windowMinutes: 60 },
    ok: true, probeIntervalMs: 60_000, probeRefusal: null, rollbackSha: null,
    rollbackTarget: null, state,
  });
  if (answer.status !== "DEPLOYMENTS_HEALTH") throw new Error(`health fixture did not decode: ${answer.code}`);
  return answer;
}

describe("the Environments section assembles its list from served reads", () => {
  it("asks for health ONLY for environments the daemon reports DEPLOYED", async () => {
    const asked: string[] = [];
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(
        goalRef, environmentRow("production", "DEPLOYED"), environmentRow("preview", "REFUSED"),
      ))}
      readHealth={(environment) => {
        asked.push(environment);
        return Promise.resolve(healthOf(environment, "UP"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    expect(asked).toEqual(["production"]);
    expect(screen.queryByTestId("cr.environments.card.preview")).toBeNull();
  });

  it("dedupes one environment deployed from two goals into a single card", async () => {
    const asked: string[] = [];
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1", "goal-2"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => {
        asked.push(environment);
        return Promise.resolve(healthOf(environment, "DEGRADED"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    expect(asked).toEqual(["production"]);
    expect(screen.getByTestId("cr.environments.card.production").getAttribute("data-status"))
      .toBe("DEGRADED");
  });

  it("renders the empty state, not a roster of degraded strangers, when nothing is deployed", async () => {
    let askedHealth = false;
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "REFUSED")))}
      readHealth={(environment) => {
        askedHealth = true;
        return Promise.resolve(healthOf(environment, "DEGRADED"));
      }}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.empty")).toBeTruthy());
    expect(askedHealth).toBe(false);
  });

  it("keeps rendering the loading line while the catalog has not answered", () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => new Promise<GoalCatalogFrame>(() => undefined)}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    expect(screen.getByTestId("cr.environments.loading")).toBeTruthy();
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  /**
   * A FAILED ENUMERATION MUST NOT READ AS AN EMPTY ONE. Each arm asserts the specific stable
   * code, and asserts the empty state is ABSENT: "no environment deployed" about a project
   * nobody could read is the one sentence this surface must never say.
   */
  it.each([
    ["REFUSED", "ENVIRONMENTS_CATALOG_REFUSED"],
    ["UNDELIVERED", "ENVIRONMENTS_CATALOG_UNDELIVERED"],
    ["UNREADABLE", "ENVIRONMENTS_CATALOG_UNREADABLE"],
  ] as const)("refuses with %s rather than reporting nothing deployed", async (outcome, code) => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve({ ...catalogOf(), outcome })}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain(`${code} @ CONTROL_ROOM_ENVIRONMENTS`);
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
    expect(screen.queryByTestId("cr.environments.list")).toBeNull();
  });

  it("refuses with ENVIRONMENTS_READ_FAILED when a read throws, not with an empty list", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.reject(new Error("offline"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal").textContent)
      .toContain("ENVIRONMENTS_READ_FAILED @ CONTROL_ROOM_ENVIRONMENTS");
    expect(screen.queryByTestId("cr.environments.empty")).toBeNull();
  });

  it("carries a per-environment refusal through to the section rather than dropping the row", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={() => Promise.resolve(mapDeploymentsHealthAnswer(200, {
        code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      }))}
    />);
    await waitFor(() => expect(screen.getByTestId("cr.environments.refusal.production")).toBeTruthy());
    expect(screen.getByTestId("cr.environments.refusal.production").textContent)
      .toContain("PROBE_STORE_UNAVAILABLE @ DAEMON_INGRESS");
  });
});

/**
 * THE BACKUPS READ, ON THE WIRE. Its frame goes through the production decoder `mapBackupsAnswer`
 * for the same reason the two above do, and it is asserted as its OWN outcome: the whole point of
 * the separate read is that neither half can be reported as the other.
 */
describe("the backups list is fetched and settled independently of the environments", () => {
  it("renders the restore-proof state the daemon served, by value", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readBackupList={() => Promise.resolve(mapBackupsAnswer(200, {
        backups: [{
          checkedAt: null, environment: "staging", ref: "20260907070400000.sql",
          restoreProof: "NOT_CHECKED", sha256: null,
        }],
        ok: true,
      }))}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);

    const row = await screen.findByTestId("cr.backups.row.staging.20260907070400000.sql");
    expect(row.getAttribute("data-restore-proof")).toBe("NOT_CHECKED");
    expect(screen.getByTestId("cr.backups.row.staging.20260907070400000.sql.proof").textContent)
      .toBe("? Restore NOT CHECKED yet");
  });

  it("shows a REFUSED backups read as a refusal while the environments still render", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readBackupList={() => Promise.resolve(mapBackupsAnswer(200, {
        code: "BACKUP_PROOF_STORE_UNAVAILABLE", layer: "DAEMON_INGRESS", ok: false,
      }))}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);

    await waitFor(() => expect(screen.getByTestId("cr.backups.refusal")).toBeTruthy());
    // The store's own code and layer, not this client's, and NOT an empty list.
    expect(screen.getByTestId("cr.backups.refusal").textContent)
      .toContain("BACKUP_PROOF_STORE_UNAVAILABLE @ DAEMON_INGRESS");
    expect(screen.queryByTestId("cr.backups.empty")).toBeNull();
    // The environments half is untouched by the backups refusal.
    expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy();
  });

  it("states a THROWN backups read as a failure, never as no backups recorded", async () => {
    render(<LiveEnvironments
      headers={{}}
      pollMs={60_000}
      readBackupList={() => Promise.reject(new Error("connect ECONNREFUSED"))}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);

    await waitFor(() => expect(screen.getByTestId("cr.backups.refusal")).toBeTruthy());
    expect(screen.getByTestId("cr.backups.refusal").textContent)
      .toContain(`${BACKUPS_READ_FAILED} @ CONTROL_ROOM_ENVIRONMENTS`);
    expect(screen.queryByTestId("cr.backups.empty")).toBeNull();
    expect(screen.queryByTestId("cr.backups.list")).toBeNull();
  });

  /**
   * ONE BACKUPS READ OUTSTANDING AT A TIME. The enumeration releases its own in-flight flag when
   * IT settles, so a backups read that outlives the enumeration would otherwise have a second one
   * started beside it - and the LAST to resolve would win, which on this surface means an older
   * restore-proof state overwriting a newer one. The poll below fires while the first read is
   * still pending; only one call may have been made.
   */
  it("never has two backups reads outstanding, so an older frame cannot win", async () => {
    let calls = 0;
    // Held in a one-slot box rather than a bare `let`: TypeScript narrows a `let` assigned only
    // inside a callback to `null` at the call site, and `release?.()` then fails to compile.
    const gate: { release: (() => void) | null } = { release: null };
    render(<LiveEnvironments
      headers={{}}
      pollMs={1}
      readBackupList={() => {
        calls += 1;
        return new Promise<BackupsOutcome>((resolve) => {
          gate.release = (): void => { resolve(mapBackupsAnswer(200, { backups: [], ok: true })); };
        });
      }}
      readCatalog={() => Promise.resolve(catalogOf("goal-1"))}
      readDeploys={(goalRef) => Promise.resolve(deploymentsOf(goalRef, environmentRow("production", "DEPLOYED")))}
      readHealth={(environment) => Promise.resolve(healthOf(environment, "UP"))}
    />);

    // The environments half completes and the 1 ms poll fires repeatedly meanwhile.
    await waitFor(() => expect(screen.getByTestId("cr.environments.card.production")).toBeTruthy());
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(calls).toBe(1);

    expect(gate.release).not.toBeNull();
    gate.release?.();
    await waitFor(() => expect(screen.getByTestId("cr.backups.empty")).toBeTruthy());
  });
});

/**
 * THE WIRING ITSELF. Every arm above renders `LiveEnvironments` directly, so all of them stay
 * green if the element is deleted from the Health screen and the section reaches no operator at
 * all. This arm mounts `LiveHealth` - what the Health route actually renders - and asserts the
 * section is THERE. It is the only arm that reds on an unwiring.
 */
describe("the Health screen mounts the Environments section", () => {
  it("renders the section root inside LiveHealth", async () => {
    const failed = (): Promise<never> => Promise.reject(new Error("no daemon in this test"));
    render(<LiveHealth
      headers={{}}
      pollMs={60_000}
      read={failed}
      readRemote={failed}
    />);
    // Every branch of the section renders this root - loading, empty, list and refusal alike -
    // so the assertion is about being MOUNTED, not about which outcome the reads produced.
    expect(await screen.findByTestId("cr.environments.root")).toBeTruthy();
  });
});
