import { expect, it } from "vitest";

import { handleCommandRequest } from "./http-adapter.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import {
  CAPABILITY,
  authenticator,
  bytes,
  decisionPort,
  envelopeObject,
  recordingHandler,
  registryOf,
  request,
} from "./http-test-fixtures.js";

const FOUNDATION_KINDS = ["foundation.dispatch", "foundation.verification"] as const;

/**
 * Both refusals below carry `INPUT_INVALID`, so the CODE cannot tell them apart: the
 * envelope guard emits it for a kind outside the closed vocabulary, and the adapter emits
 * it for a kind the registry does not hold. `stage` is the only discriminator, and which
 * layer answered is the entire question this file exists to settle.
 */
function wiring(registeredKind: "foundation.dispatch" | "goal.create"): CommandAdapterDeps & {
  readonly calls: { count: number };
} {
  const handler = recordingHandler();
  return {
    authenticator: authenticator([CAPABILITY]),
    calls: handler.calls,
    decisions: decisionPort(),
    registry: registryOf(registeredKind, handler.handler, ["title"]),
  };
}

it("hands both Foundation kinds to the registry instead of refusing them at DECODE", () => {
  expect(FOUNDATION_KINDS).toHaveLength(2);

  for (const kind of FOUNDATION_KINDS) {
    const wired = wiring("goal.create");
    const result = handleCommandRequest(wired, request({
      body: bytes(envelopeObject({ commandKind: kind })),
    }), "HTTP_LISTENER");

    expect(result.outcome, `${kind} was not refused`).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.stage, `${kind} was answered by the wrong layer`).toBe("REGISTRY");
    expect(result.error.code).toBe("INPUT_INVALID");
    expect(wired.calls.count).toBe(0);
  }

  // Negative control: the DECODE stage is still reachable and still refuses a kind the
  // closed vocabulary really does not carry, so the REGISTRY assertions above are not
  // reading a stage that has stopped being able to answer.
  const wired = wiring("goal.create");
  const stranger = handleCommandRequest(wired, request({
    body: bytes(envelopeObject({ commandKind: "foundation.dispatch.v2" })),
  }), "HTTP_LISTENER");

  expect(stranger.outcome).toBe("REFUSED");
  if (stranger.outcome !== "REFUSED") return;
  expect(stranger.stage).toBe("DECODE");
  expect(stranger.error.code).toBe("INPUT_INVALID");
});

it("accepts a registry entry keyed by a Foundation kind and dispatches to its handler", () => {
  const wired = wiring("foundation.dispatch");
  const result = handleCommandRequest(wired, request({
    body: bytes(envelopeObject({ commandKind: "foundation.dispatch" })),
  }), "HTTP_LISTENER");

  expect(result.outcome).toBe("ACCEPTED");
  expect(wired.calls.count).toBe(1);
});
