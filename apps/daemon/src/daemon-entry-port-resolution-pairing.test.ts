import { expect, it } from "vitest";

import { resolveOptionalDaemonPorts } from "./daemon-entry-port-resolution.js";

it.each([undefined, null, "", " ", 7, {}, []])(
  "refuses a session handshake with malformed boundProjectId %j",
  (boundProjectId) => {
    const result = resolveOptionalDaemonPorts({
      sessionHandshake: () => ({
        boundProjectId,
        mint: () => ({ code: "unused", ok: false }),
      }) as never,
    });
    expect(result).toEqual({ failure: "INVALID", ok: false });
  },
);

it("admits a session handshake only when mint and a non-empty bound project are present", () => {
  const port = {
    boundProjectId: "project-bound",
    mint: () => ({ code: "unused", ok: false as const }),
  };
  expect(resolveOptionalDaemonPorts({ sessionHandshake: () => port })).toEqual({
    ok: true,
    ports: { sessionHandshake: port },
  });
});

it("resolves the Product Contract /2 current reader once and rejects malformed ports", () => {
  const calls = { count: 0 };
  const port = {
    boundProjectId: "project-bound",
    readCurrent: () => ({ code: "unused", layer: "test", outcome: "REFUSED" as const }),
  };
  expect(resolveOptionalDaemonPorts({
    productContractV2Current: () => { calls.count += 1; return port; },
  })).toEqual({ ok: true, ports: { productContractV2Current: port } });
  expect(calls.count).toBe(1);
  expect(resolveOptionalDaemonPorts({
    productContractV2Current: () => ({ boundProjectId: "project-bound" }) as never,
  })).toEqual({ failure: "INVALID", ok: false });
});
