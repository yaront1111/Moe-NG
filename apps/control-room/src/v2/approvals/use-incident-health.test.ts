import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import { useIncidentHealth } from "./use-incident-health.js";

afterEach(cleanup);

const answered = (environment: string): DeploymentsHealthOutcome =>
  ({ environment, status: "DEPLOYMENTS_HEALTH" } as unknown as DeploymentsHealthOutcome);

/**
 * THE MAP FOLLOWS THE DEPLOYED SET. Measured before this arm: when the set collapsed to nothing
 * (every goal's deployments read refused, so `useGoalReads` dropped them), the effect returned
 * before starting a tick and left the previous answers in state; `incidentItems` iterates the
 * map without consulting the deployed set, so an INCIDENT card and its rollback target kept
 * rendering from a frame no poll would ever refresh.
 */
describe("useIncidentHealth", () => {
  it("empties its answers when the deployed set collapses to nothing", async () => {
    const read = (environment: string): Promise<DeploymentsHealthOutcome> => Promise.resolve(answered(environment));
    const hook = renderHook(
      ({ environments }: { readonly environments: readonly string[] }) => useIncidentHealth(environments, read, 60_000),
      { initialProps: { environments: ["staging"] } },
    );
    await waitFor(() => { expect(hook.result.current.get("staging")?.status).toBe("DEPLOYMENTS_HEALTH"); });

    hook.rerender({ environments: [] });
    await waitFor(() => { expect(hook.result.current.size).toBe(0); });
  });

  it("keeps only the environments still deployed when the set shrinks", async () => {
    const read = (environment: string): Promise<DeploymentsHealthOutcome> => Promise.resolve(answered(environment));
    const hook = renderHook(
      ({ environments }: { readonly environments: readonly string[] }) => useIncidentHealth(environments, read, 60_000),
      { initialProps: { environments: ["production", "staging"] } },
    );
    await waitFor(() => { expect(hook.result.current.size).toBe(2); });

    hook.rerender({ environments: ["staging"] });
    await waitFor(() => { expect([...hook.result.current.keys()]).toEqual(["staging"]); });
  });
});
