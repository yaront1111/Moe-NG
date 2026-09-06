import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createCompatGate } from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { ApprovePlan } from "./approve-plan.js";
import {
  APPROVAL_COMMAND_KIND,
  PLAN_APPROVAL_BUILD_LAYER,
  PLAN_APPROVAL_LAYER,
  PLAN_APPROVAL_WITHHELD_CODES,
  authorizeApproval,
  createPlanApprovalPort,
} from "./plan-approval.js";
import type { ApprovalGrant, PlanApprovalOutcome, PlanApprovalWire } from "./plan-approval.js";

/**
 * The PLAN-REVIEW screen (UI-6) and the approval AUTHORITY GATE behind its one
 * write.
 *
 * Two mechanisms can refuse an approval here and they are kept DISTINGUISHABLE on
 * purpose, because an arm that only asserts "it refused" stops testing its subject
 * the moment a second fence answers first:
 *  - `authorizeApproval` refuses at `PLAN_APPROVAL_LAYER` when the daemon has not
 *    OFFERED this run's approval affordance. Nothing is dispatched.
 *  - the generated builder refuses at `PLAN_APPROVAL_BUILD_LAYER` when handed
 *    anything that is not the intent affordance - including the caller-authored
 *    `approval.decide` wire.
 * Every refusal arm below pins the code AND the layer, so loosening one guard
 * cannot be masked by the other.
 *
 * Durable identifiers are read from the fixture object, never written as a literal
 * beside the assertion: an expectation spelled twice is a fixed point that no
 * mutation of the production surface can redden.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SEALED_REVIEWABLE: PlanningRunOutcome = Object.freeze({
  acceptance: {
    criteriaDigest: "cd-1",
    obligations: [{
      criterionId: "crit-1",
      evidenceRequirements: [{ evidenceRef: "ev-1", kind: "TEST", requirementId: "req-1" }],
      statement: "The store recovers from a fresh genesis",
      verificationRecipeRefs: ["recipe-1"],
    }],
  },
  approval: "ABSENT",
  lifecycle: "PLAN_REVIEW",
  plan: {
    affectedCriterionIds: ["crit-1"],
    affectedNodeIds: ["node-1"],
    planHash: "plan-hash-1",
    steps: [{ description: "Write the recovery contract", kind: "node.deliver", stepId: "step-1" }],
  },
  reviewable: true,
  runId: "run-live-1",
  sealed: true,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

const UNSEALED: PlanningRunOutcome = Object.freeze({
  acceptance: null,
  approval: "ABSENT",
  lifecycle: "PLANNING",
  plan: null,
  reviewable: false,
  runId: "run-live-1",
  sealed: false,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

const REFUSED: PlanningRunOutcome = Object.freeze({
  code: "PLANNING_RUN_READ_CAPABILITY_DENIED",
  layer: "PLANNING_RUN_READ",
  status: "REFUSED",
});

function renderScreen(outcome: PlanningRunOutcome): (runId: string) => Promise<PlanningRunOutcome> {
  const read = vi.fn((_runId: string) => Promise.resolve(outcome));
  render(<ApprovePlan goalId="goal-live-1" onBack={vi.fn()} read={read} runId="run-live-1" title="Recovery goal" />);
  return read;
}

describe("the plan-review screen renders the run it read", () => {
  it("renders the plan steps, an obligation, and the ready banner for a sealed reviewable run", async () => {
    renderScreen(SEALED_REVIEWABLE);
    expect(await screen.findByTestId("cr.approve.step.step-1")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.step.step-1").textContent).toContain("Write the recovery contract");
    expect(screen.getByTestId("cr.approve.obligation.crit-1").textContent)
      .toContain("The store recovers from a fresh genesis");
    expect(screen.getByTestId("cr.approve.banner").textContent).toBe("Ready for your approval");
  });

  it("renders the honest not-sealed empty when the bodies do not verify", async () => {
    renderScreen(UNSEALED);
    expect(await screen.findByTestId("cr.approve.empty")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.empty").textContent)
      .toContain("The plan is not sealed yet; nothing to review.");
    expect(screen.queryByTestId("cr.approve.plan")).toBeNull();
  });

  it("names the refusal code plainly, never a blank surface", async () => {
    renderScreen(REFUSED);
    const line = await screen.findByTestId("cr.approve.refusal");
    expect(line.textContent).toContain("PLANNING_RUN_READ_CAPABILITY_DENIED");
    expect(line.textContent).toContain("PLANNING_RUN_READ");
  });
});

describe("the Approve control without a daemon grant", () => {
  it("renders Approve DISABLED naming the unread surface at this module's own layer", async () => {
    renderScreen(SEALED_REVIEWABLE);
    const button = await screen.findByTestId("cr.approve.button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByTestId("cr.approve.reason");
    expect(reason.textContent).toContain("APPROVAL_SURFACE_UNREAD");
    expect(reason.textContent).toContain(PLAN_APPROVAL_LAYER);
  });

  it("makes no request of its own beyond the injected read", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("the screen must not fetch")));
    vi.stubGlobal("fetch", fetchMock);
    const read = renderScreen(SEALED_REVIEWABLE);
    await screen.findByTestId("cr.approve.step.step-1");
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(1); });
    // The screen reads through the injected fn ONLY; it authors nothing and calls
    // no transport of its own (it imports no dispatch).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * DURABLE subjects. Two distinct runs so a subject-mismatch arm has something to
 * mismatch AGAINST; both are read back from this object rather than respelled.
 */
const DURABLE = Object.freeze({
  otherRunRef: "run-a3f19c0e4b7d",
  runRef: "run-7c1d55ab902e",
});

/** A daemon `NextAllowedCommand`, shaped exactly as `affordance-planning-offers.ts` mints one. */
function offerFor(
  targetAggregateId: string, commandKind: string = APPROVAL_COMMAND_KIND,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId: `cmd-${targetAggregateId}`,
    commandKind,
    expectedVersion: 4,
    inputSchemaVersion: "moe-bootstrap/1",
    targetAggregateId,
  });
}

function frameWith(
  offers: readonly Readonly<Record<string, unknown>>[],
  overrides: Partial<SurfaceFrame> = {},
): SurfaceFrame {
  return Object.freeze({
    connection: "CONNECTED",
    detail: "",
    offers: Object.freeze([...offers]) as SurfaceFrame["offers"],
    outcome: "SURFACE",
    steps: Object.freeze([]),
    ...overrides,
  });
}

describe("the approval affordance gate", () => {
  it("authorizes on the daemon's own intent offer for this run and carries it VERBATIM", () => {
    const offer = offerFor(DURABLE.runRef);
    const authorization = authorizeApproval(frameWith([offer]), DURABLE.runRef);
    expect(authorization.status).toBe("AUTHORIZED");
    if (authorization.status !== "AUTHORIZED") throw new Error("expected an authorized grant");
    // IDENTITY, not equality: the grant carries the daemon's object, never a local mint.
    expect(authorization.grant.affordance).toBe(offer);
    expect(authorization.grant.runId).toBe(DURABLE.runRef);
  });

  /**
   * BIDIRECTIONAL roster (both directions, or a served code can vanish from the
   * advertised set while an arm iterating the roster stays green): every advertised
   * code is produced by a measured input, and every code this gate produces is
   * advertised. The case table is asserted NONEMPTY first, so a sweep that yields
   * zero cases cannot pass by finding nothing to check.
   */
  it("produces exactly its advertised withheld-code roster, in both directions", () => {
    const cases: readonly { readonly code: string; readonly frame: SurfaceFrame | null }[] =
      Object.freeze([
        { code: "APPROVAL_SURFACE_UNREAD", frame: null },
        {
          code: "APPROVAL_SURFACE_NOT_CONNECTED",
          frame: frameWith([offerFor(DURABLE.runRef)], { connection: "DISCONNECTED" }),
        },
        { code: "APPROVAL_AFFORDANCE_ABSENT", frame: frameWith([]) },
        {
          code: "APPROVAL_AFFORDANCE_SUBJECT_MISMATCH",
          frame: frameWith([offerFor(DURABLE.otherRunRef)]),
        },
      ]);
    expect(cases.length).toBeGreaterThan(0);
    const produced = cases.map((entry) => {
      const authorization = authorizeApproval(entry.frame, DURABLE.runRef);
      expect(authorization.status).toBe("WITHHELD");
      if (authorization.status !== "WITHHELD") throw new Error("expected a withheld verdict");
      expect(authorization.layer).toBe(PLAN_APPROVAL_LAYER);
      expect(authorization.code).toBe(entry.code);
      return authorization.code as string;
    });
    expect([...produced].sort()).toEqual([...PLAN_APPROVAL_WITHHELD_CODES].sort());
  });

  /**
   * THE SUBSTITUTION THIS GATE EXISTS TO REFUSE. `approval.decide` is the
   * caller-authored wire whose payload carries an `activation`/`record` pair the
   * browser would have to invent; a HUMAN_APPROVED marker riding alongside it is a
   * caller's claim, not the daemon's grant. Neither authorizes.
   */
  it("treats neither the caller-authored approval.decide offer nor a HUMAN_APPROVED marker as authority", () => {
    const callerWire = Object.freeze({
      ...offerFor(DURABLE.runRef, "approval.decide"),
      record: Object.freeze({ actor: "operator-local", truthClass: "HUMAN_APPROVED" }),
    });
    const authorization = authorizeApproval(frameWith([callerWire]), DURABLE.runRef);
    expect(authorization).toEqual({
      code: "APPROVAL_AFFORDANCE_ABSENT", layer: PLAN_APPROVAL_LAYER, status: "WITHHELD",
    });
  });
});

/** The gated wire, built through the REAL generated builders the compat gate admits. */
function admittedWire(
  sendCommand: (envelope: unknown) => Promise<{ code?: string; delivered: boolean; response?: unknown }>,
): PlanApprovalWire {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-runtime-error-registry/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    },
    buildToolVersions: { node: "24.16.0" },
    contractSchemaHash: "144d81c9186f9234a3c15ab91eb0814af46b8a06e0185a5c2311ff5e82a72a29",
  });
  if (!gate.ok) throw new Error("the compat gate refused its own matching report");
  return {
    client: gate.client,
    sessionCredential: "credential-under-test",
    transport: { sendCommand } as unknown as PlanApprovalWire["transport"],
  };
}

describe("the approval port calls the real typed command", () => {
  it("sends the daemon's own identity with a payload of exactly the intent keys", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({
        delivered: true,
        response: { decision: { disposition: "DECIDED", resultCode: "APPROVED" }, ok: true },
      });
    });
    const offer = offerFor(DURABLE.runRef);
    const authorization = authorizeApproval(frameWith([offer]), DURABLE.runRef);
    if (authorization.status !== "AUTHORIZED") throw new Error("expected an authorized grant");
    const outcome = await createPlanApprovalPort(wire).submit(authorization.grant);
    expect(outcome.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const envelope = sent[0] ?? {};
    // Identity is the DAEMON's, never the caller's: every one of these is copied
    // from the offer above rather than composed here.
    expect(envelope["commandKind"]).toBe(APPROVAL_COMMAND_KIND);
    expect(envelope["commandId"]).toBe(offer["commandId"]);
    expect(envelope["targetAggregateId"]).toBe(offer["targetAggregateId"]);
    expect(envelope["expectedVersion"]).toBe(offer["expectedVersion"]);
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(Object.keys(payload).sort())
      .toEqual(["decision", "decisionReason", "dependencyChanges", "runId"]);
    expect(payload["dependencyChanges"])
      .toEqual({ additions: [], challenges: [], removals: [] });
    expect(payload["runId"]).toBe(DURABLE.runRef);
  });

  /**
   * THE DIVERGENCE ARM. The gate above and the builder here are two different
   * mechanisms; feeding the builder the caller-authored wire reaches PAST the gate
   * and must refuse at the BUILDER's layer with the builder's own code. If both
   * refusals wore one layer, loosening either guard would leave every arm green.
   */
  it("refuses at the build layer when handed anything but the intent affordance, and sends nothing", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({ delivered: true, response: { ok: true } });
    });
    const grant: ApprovalGrant = {
      affordance: offerFor(DURABLE.runRef, "approval.decide"), runId: DURABLE.runRef,
    };
    const outcome = await createPlanApprovalPort(wire).submit(grant);
    expect(outcome).toEqual({
      code: "INPUT_INVALID", layer: PLAN_APPROVAL_BUILD_LAYER, ok: false,
    });
    expect(sent).toHaveLength(0);
  });

  it("reports a daemon refusal at the daemon's OWN code and layer, never restamped", async () => {
    const refusal = Object.freeze({
      code: "APPROVAL_AUTHORITY_HUMAN_REVIEW_REQUIRED", layer: "DAEMON_APPROVAL_INTENT",
    });
    const wire = admittedWire(() => Promise.resolve({
      delivered: true, response: { ok: false, refusal },
    }));
    const authorization = authorizeApproval(
      frameWith([offerFor(DURABLE.runRef)]), DURABLE.runRef,
    );
    if (authorization.status !== "AUTHORIZED") throw new Error("expected an authorized grant");
    const outcome = await createPlanApprovalPort(wire).submit(authorization.grant);
    expect(outcome).toEqual({ code: refusal.code, layer: refusal.layer, ok: false });
  });
});

interface ApprovalHarness {
  readonly read: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
}

function renderApproval(
  frame: SurfaceFrame | null,
  outcome: PlanApprovalOutcome,
  reads: readonly PlanningRunOutcome[],
): ApprovalHarness {
  const read = vi.fn();
  for (const answer of reads) read.mockResolvedValueOnce(answer);
  read.mockResolvedValue(reads[reads.length - 1] ?? SEALED_REVIEWABLE);
  const submit = vi.fn(() => Promise.resolve(outcome));
  render(
    <ApprovePlan
      approval={{
        authorization: authorizeApproval(frame, DURABLE.runRef),
        submit: submit as unknown as (grant: ApprovalGrant) => Promise<PlanApprovalOutcome>,
      }}
      goalId="goal-live-1"
      onBack={vi.fn()}
      read={read as unknown as (runId: string) => Promise<PlanningRunOutcome>}
      runId={DURABLE.runRef}
      title="Recovery goal"
    />,
  );
  return { read, submit };
}

describe("the Approve control against a daemon grant", () => {
  it("disables Approve with the gate's exact code and layer, and dispatches nothing when clicked", async () => {
    const harness = renderApproval(
      frameWith([offerFor(DURABLE.otherRunRef)]),
      { code: "UNREACHED", layer: "UNREACHED", ok: false },
      [SEALED_REVIEWABLE],
    );
    const button = await screen.findByTestId("cr.approve.button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByTestId("cr.approve.reason");
    expect(reason.textContent).toContain("APPROVAL_AFFORDANCE_SUBJECT_MISMATCH");
    expect(reason.textContent).toContain(PLAN_APPROVAL_LAYER);
    await userEvent.click(button);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it("dispatches the grant once and renders the state the DURABLE re-read reports", async () => {
    const refreshed: PlanningRunOutcome = Object.freeze({
      ...(SEALED_REVIEWABLE as Extract<PlanningRunOutcome, { status: "RUN" }>),
      approval: "BOUND",
      lifecycle: "PLAN_REVIEW",
      reviewable: false,
    });
    const offer = offerFor(DURABLE.runRef);
    const harness = renderApproval(
      frameWith([offer]), { commandId: "cmd-approved", ok: true },
      [SEALED_REVIEWABLE, refreshed],
    );
    const button = await screen.findByTestId("cr.approve.button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    await waitFor(() => { expect(harness.submit).toHaveBeenCalledTimes(1); });
    expect((harness.submit.mock.calls[0]?.[0] as ApprovalGrant).affordance).toBe(offer);
    // The new state is the DAEMON's, re-read after the write; nothing optimistic.
    await waitFor(() => { expect(harness.read).toHaveBeenCalledTimes(2); });
    const applied = await screen.findByTestId("cr.approve.applied");
    expect(applied.textContent).toContain(
      (refreshed as Extract<PlanningRunOutcome, { status: "RUN" }>).lifecycle,
    );
    expect(applied.textContent).toContain("approval BOUND");
    // The durable run still reads PLAN_REVIEW by design; the banner must say APPROVED, never
    // "still planning", once the daemon reports the decision bound (measured live 2026-09-02).
    const banner = screen.getByTestId("cr.approve.banner");
    expect(banner.getAttribute("data-approval")).toBe("BOUND");
    expect(banner.textContent).toMatch(/^Approved - /u);
    expect(banner.textContent).not.toContain("Still planning");
  });

  it("keeps a refusal visible with its exact code and layer, and refreshes nothing", async () => {
    const refusal = Object.freeze({
      code: "APPROVAL_AUTHORITY_HUMAN_REVIEW_REQUIRED",
      layer: "DAEMON_APPROVAL_INTENT",
      ok: false as const,
    });
    const harness = renderApproval(
      frameWith([offerFor(DURABLE.runRef)]), refusal, [SEALED_REVIEWABLE],
    );
    await userEvent.click(await screen.findByTestId("cr.approve.button"));
    const line = await screen.findByTestId("cr.approve.dispatch-refusal");
    expect(line.textContent).toContain(refusal.code);
    expect(line.textContent).toContain(refusal.layer);
    // A refusal must not silently re-read: the durable state did not move, and the
    // operator keeps both the plan they were reading and the reason it was refused.
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cr.approve.plan")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.dispatch-refusal").textContent).toContain(refusal.code);
  });
});
