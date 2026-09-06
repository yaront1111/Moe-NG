import { afterEach, expect, it, vi } from "vitest";
import { mapDeploymentsAnswer, readDeployments } from "./live-deployments.js";
afterEach(() => vi.unstubAllGlobals());
const frame = () => ({ outcome: "DEPLOYMENTS", goalRef: "goal-a", sha: "a".repeat(40), releaseDecision: null,
  environments: [{ environment: "preview", target: "local Docker (moe)", url: null,
    outcome: null, sha: null, time: null, code: null, detail: null, releaseDecision: null }],
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
it("sends the exact goal selector and refuses a response for another goal", async () => {
  const fetcher = vi.fn(async () => ({ status: 200, json: async () => frame() }));
  vi.stubGlobal("fetch", fetcher);
  expect(await readDeployments({ "x-session": "test" }, "goal-b")).toMatchObject({ status: "ERROR" });
  expect(fetcher).toHaveBeenCalledWith("/deployments/read", expect.objectContaining({ method: "POST", body: JSON.stringify({ goalRef: "goal-b" }) }));
});
