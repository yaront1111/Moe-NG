import { describe, expect, it, vi } from "vitest";

import { dispatchAffordancePayload } from "./live-command-dispatch.js";
import { DEV_PAYLOADS } from "./live-dispatch-payloads.js";

describe("dispatchAffordancePayload", () => {
  it("hands an explicit operator payload through the daemon offer without consulting dev defaults", async () => {
    const builder = vi.fn((affordance: unknown, caller: unknown) => ({
      envelope: { ...(affordance as Record<string, unknown>), caller }, ok: true as const,
    }));
    const sendCommand = vi.fn(async (_envelope: unknown) => ({
      delivered: true as const,
      response: {
        decision: {
          commandId: "daemon-command-1",
          disposition: "DECIDED",
          effectId: "effect-goal-1",
          resultCode: "GOAL_CREATED",
        },
        httpStatus: 200,
        ok: true,
        outcome: "ACCEPTED",
      },
      status: 200,
    }));
    const affordance = {
      commandId: "daemon-command-1", commandKind: "goal.create",
      expectedVersion: 0, targetAggregateId: "goal-operator-1",
    };
    const payload = {
      budgetAccountRef: "budget/goal-operator-1",
      goalId: "goal-operator-1",
      planningRunRef: "run-operator-1",
      witness: {},
    };

    const result = await dispatchAffordancePayload({
      affordance,
      aggregateId: "goal-operator-1",
      client: { commands: { "goal.create": builder } } as never,
      kind: "goal.create",
      payload,
      sessionCredential: "credential-operator",
      transport: { sendCommand } as never,
    });

    expect(result).toEqual({ detail: "DECIDED GOAL_CREATED", ok: true, stage: "ANSWERED" });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(builder.mock.calls[0]?.[1]).toMatchObject({ payload, sessionCredential: "credential-operator" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("binds success to the command id on the envelope actually sent", async () => {
    const sendCommand = vi.fn(async (_envelope: unknown) => ({
      delivered: true as const,
      response: {
        decision: {
          commandId: "daemon-command-1", disposition: "DECIDED",
          effectId: "effect-goal-1", resultCode: "GOAL_CREATED",
        },
        httpStatus: 200, ok: true, outcome: "ACCEPTED",
      },
      status: 200,
    }));
    const result = await dispatchAffordancePayload({
      affordance: {
        commandId: "daemon-command-1", commandKind: "goal.create",
        expectedVersion: 0, targetAggregateId: "goal-operator-1",
      },
      aggregateId: "goal-operator-1",
      client: { commands: { "goal.create": () => ({
        envelope: { commandId: "substituted-command" }, ok: true,
      }) } } as never,
      kind: "goal.create",
      payload: {},
      sessionCredential: "credential-operator",
      transport: { sendCommand } as never,
    });

    expect(result).toEqual({
      detail: "unreadable answer", ok: false, stage: "ANSWER_UNREADABLE",
    });
    expect(sendCommand.mock.calls[0]?.[0]).toEqual({ commandId: "substituted-command" });
  });

  it.each([
    ["bare ok", 200, { ok: true }],
    ["missing durable decision fields", 200, {
      decision: { disposition: "DECIDED", resultCode: "GOAL_CREATED" },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    }],
    ["transport status mismatch", 503, {
      decision: {
        commandId: "daemon-command-1", disposition: "DECIDED",
        effectId: "effect-goal-1", resultCode: "GOAL_CREATED",
      },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    }],
    ["declared status mismatch", 200, {
      decision: {
        commandId: "daemon-command-1", disposition: "DECIDED",
        effectId: "effect-goal-1", resultCode: "GOAL_CREATED",
      },
      httpStatus: 201, ok: true, outcome: "ACCEPTED",
    }],
    ["unknown outer field", 200, {
      decision: {
        commandId: "daemon-command-1", disposition: "DECIDED",
        effectId: "effect-goal-1", resultCode: "GOAL_CREATED",
      },
      extra: true, httpStatus: 200, ok: true, outcome: "ACCEPTED",
    }],
    ["another command's decision", 200, {
      decision: {
        commandId: "another-command", disposition: "DECIDED",
        effectId: "effect-goal-1", resultCode: "GOAL_CREATED",
      },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    }],
  ] as const)("does not accept a malformed success: %s", async (_name, status, response) => {
    const result = await dispatchAffordancePayload({
      affordance: {
        commandId: "daemon-command-1", commandKind: "goal.create",
        expectedVersion: 0, targetAggregateId: "goal-operator-1",
      },
      aggregateId: "goal-operator-1",
      client: { commands: { "goal.create": () => ({ envelope: {}, ok: true }) } } as never,
      kind: "goal.create",
      payload: {},
      sessionCredential: "credential-operator",
      transport: { sendCommand: async () => ({ delivered: true, response, status }) } as never,
    });

    expect(result).toEqual({
      detail: "unreadable answer", ok: false, stage: "ANSWER_UNREADABLE",
    });
  });

  it("preserves an exact port refusal code and refusing layer", async () => {
    const result = await dispatchAffordancePayload({
      affordance: {},
      aggregateId: "goal-operator-1",
      client: { commands: { "goal.create": () => ({ envelope: {}, ok: true }) } } as never,
      kind: "goal.create",
      payload: {},
      sessionCredential: "credential-operator",
      transport: {
        sendCommand: async () => ({
          delivered: true,
          response: {
            httpStatus: 409,
            ok: false,
            outcome: "PORT_REFUSED",
            refusal: {
              code: "EXPECTED_VERSION_CONFLICT",
              detail: "the durable version changed",
              httpStatus: 409,
              layer: "CORE_REDUCER",
            },
            stage: "DISPATCH",
          },
          status: 409,
        }),
      } as never,
    });

    expect(result).toEqual({
      detail: "EXPECTED_VERSION_CONFLICT @ CORE_REDUCER",
      ok: false,
      stage: "ANSWER_REFUSED",
    });
  });
});

/**
 * THE BROWSER MAY NOT ASSERT A READING IT DID NOT TAKE.
 *
 * Every payload this bundle sends is committed to the real ledger as operator authority, so a
 * `claude --version` sentence sitting in a frozen literal is an invented measurement wearing a
 * DAEMON_VERIFIED coat -- the exact defect the activation feature exists to remove. The provider
 * CLI version is measured by the DAEMON now (`activation-receipts-measure.ts` runs
 * `<agent command> --version` through its ports and publishes the reading at
 * `/activation/read`.provider), so the browser has nothing left to say about it.
 *
 * Asserted over the WHOLE payload roster rather than the one key that regressed: the next
 * fabricated reading will be pasted into a different command, and a test that only reads
 * `provider.probe` cannot see it. Every kind is enumerated from DEV_PAYLOADS itself, and the
 * count is pinned so a roster that shrinks to nothing still fails.
 */
describe("DEV_PAYLOADS asserts no provider reading", () => {
  const KINDS = Object.keys(DEV_PAYLOADS);

  it("enumerates a NON-EMPTY roster, so the sweep below cannot pass vacuously", () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(8);
    expect(KINDS).toContain("provider.probe");
  });

  it.each(KINDS)("carries no version reading anywhere in %s", (kind) => {
    const json = JSON.stringify(DEV_PAYLOADS[kind]);
    // A known snapshot kind IS an assertion that somebody ran the CLI and read a build out of it.
    expect(json).not.toContain("DATED_SNAPSHOT");
    expect(json).not.toContain("BUILD_STAMP");
    // ...and so is any prose naming the invocation, whichever CLI it names.
    expect(json).not.toMatch(/--version/u);
  });

  it("sends provider.probe with modelSnapshotKind UNKNOWN, exactly as the demo seed does", () => {
    const probe = DEV_PAYLOADS["provider.probe"] as
      { readonly observation: { readonly profile: Record<string, unknown> } };
    expect(probe.observation.profile["modelSnapshotKind"]).toBe("UNKNOWN");
    expect(probe.observation.profile["modelSnapshotEvidence"])
      .toBe("the browser ran no provider CLI probe");
  });
});
