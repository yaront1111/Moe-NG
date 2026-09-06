import { expect, it } from "vitest";

import { buildDevProxy, DEV_PROXY_PATHS } from "./dev-proxy-paths.js";

it("proxies the complete project-daemon v2 surface without manager authority", () => {
  expect(DEV_PROXY_PATHS).toStrictEqual([
    "/activation/read",
    "/activity/read",
    "/affordances/read",
    "/bootstrap",
    "/budget/commitment/read",
    "/command",
    "/v2/command",
    "/v2/product-contract/current",
    "/v2/product-contract/pending/read",
    "/documents/coverage/read",
    "/documents/dossier/read",
    "/documents/ingest",
    "/events/ack",
    "/events/read",
    "/events/resume",
    "/goals/read",
    "/goals/source/read",
    "/design/read",
    "/deployments/read",
    "/health/read",
    "/graph/get",
    "/planning/run/read",
    "/policy/read",
    "/preview/read",
    "/preview/capture",
    "/product-contract/gate-1/read",
    "/product-contract/pending/read",
    "/repository/remote/read",
    "/criteria/read",
    "/repository/recovery/read",
    "/repository/bootstrap/read",
    "/release/read",
    "/runs/read",
    "/session/challenge-operands/read",
    "/session/pair",
    "/session/pair/claim",
    "/session/pair/open",
    "/session/pair/request",
    "/sessions/read",
  ]);
  expect(new Set(DEV_PROXY_PATHS).size).toBe(DEV_PROXY_PATHS.length);
  expect(DEV_PROXY_PATHS.some((path) => path.startsWith("/manager/"))).toBe(false);

  const origin = "http://127.0.0.1:43123";
  const proxy = buildDevProxy(origin);
  expect(Object.keys(proxy)).toStrictEqual([...DEV_PROXY_PATHS]);
  for (const entry of Object.values(proxy)) {
    expect(entry).toStrictEqual({
      changeOrigin: true,
      headers: { origin },
      target: origin,
    });
  }
});
