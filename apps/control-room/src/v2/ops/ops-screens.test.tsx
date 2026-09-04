import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import { LiveHealth, LivePolicy } from "./live-ops.js";
import { HealthScreen, PolicyScreen, verifierWords } from "./ops-screens.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-02T20:00:00.000Z");
const POLICY: PolicyOutcome = {
  aggregateVersion: 3,
  evaluations: [{ decidedAt: "2026-09-02T19:30:00.000Z", decision: "ALLOW", policyRef: "f".repeat(64), principalId: "operator-local" }],
  slices: [
    { autoApprovalOptIns: 0, contentDigestMatches: true, installedAt: "2026-09-02T18:00:00.000Z", kind: "EVALUATION", riskClassifications: 7, rules: 0, sliceRef: "f".repeat(64) },
    { autoApprovalOptIns: null, contentDigestMatches: null, installedAt: "2026-09-02T18:00:00.000Z", kind: "VERIFIER_POLICY", riskClassifications: null, rules: null, sliceRef: "moe-verifier-policy/1" },
  ],
  standard: [
    { installed: true, kind: "VERIFIER_POLICY", slice: { sliceRef: "moe-verifier-policy/1" }, sliceRef: "moe-verifier-policy/1" },
    { installed: false, kind: "REVIEWER_CALIBRATION", slice: { sliceRef: "moe-reviewer-calibration/1" }, sliceRef: "moe-reviewer-calibration/1" },
    { installed: true, kind: "EVALUATION", slice: { sliceRef: "f".repeat(64) }, sliceRef: "f".repeat(64) },
  ],
  status: "POLICY",
  verifier: { calibration: false, policy: true },
  waivers: { reason: "No command on this daemon records a policy waiver.", supported: false },
};
/** The daemon's five-key pause, as /health/read serves it; the line is carried, never parsed. */
const PAUSED = {
  lastLine: "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude", resetAt: "2026-09-02T20:30:00.000Z", since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
};
const HEALTH: HealthOutcome = {
  agents: { paused: null },
  daemon: { commandAuthorityPlane: "V1", nodeSpecsDir: null, pid: 4242, projectId: "unai", protocolVersion: "moe-runtime-command/1", startedAt: "2026-09-02T19:00:00.000Z", storePath: "D:/store.sqlite" },
  ledger: { aggregates: 12, commandKinds: 9, decisionCount: 40, goals: 2, lastDecidedAt: "2026-09-02T19:35:00.000Z" },
  readAt: "2026-09-02T20:00:00.000Z", status: "HEALTH", verifier: { calibration: true, policy: true },
};

describe("verifierWords", () => {
  it("names exactly what is missing before delivered work can be accepted", () => {
    expect(verifierWords({ calibration: true, policy: true })).toBe("The verifier can accept delivered work.");
    expect(verifierWords({ calibration: false, policy: true })).toContain("the reviewer calibration (moe-reviewer-calibration/1) is installed");
    expect(verifierWords({ calibration: false, policy: false })).toContain("the verifier policy (moe-verifier-policy/1) and the reviewer calibration");
  });
});

describe("PolicyScreen", () => {
  it("lists each slice by kind with its digest check and counts, the evaluations, and the waiver note", () => {
    render(<PolicyScreen nowMs={NOW} outcome={POLICY} />);
    expect(screen.getByTestId("cr.policy.count").textContent).toBe("2 installed · 1 evaluation · version 3");
    const evaluation = screen.getByTestId(`cr.policy.slice.${"f".repeat(64)}`);
    expect(evaluation.textContent).toContain("Evaluation policy · installed 2 h ago · bytes match the ref");
    expect(evaluation.textContent).toContain("0 rules · 0 auto-approval opt-ins · 7 risk classifications");
    expect(screen.getByTestId("cr.policy.slice.moe-verifier-policy/1").textContent).toContain("Verifier policy");
    expect(screen.getByTestId("cr.policy.verifier").textContent).toContain("reviewer calibration");
    expect(screen.getByTestId("cr.policy.evaluations").textContent).toContain("ALLOW · 30 min ago · by operator-local");
    expect(screen.getByTestId("cr.policy.waivers").textContent).toContain("not supported here");
  });

  it("names the missing standard slices and offers one install when a wire is attached", () => {
    render(<PolicyScreen nowMs={NOW} outcome={POLICY} />);
    expect(screen.getByTestId("cr.policy.standard").textContent).toContain("1 of 3 slices missing");
    expect(screen.getByTestId("cr.policy.standard.REVIEWER_CALIBRATION").getAttribute("data-installed")).toBe("false");
    expect(screen.getByTestId("cr.policy.install.nowire")).toBeTruthy();
    expect(screen.queryByTestId("cr.policy.install")).toBeNull();
    cleanup();
    const onInstall = vi.fn();
    render(<PolicyScreen install={{ busy: false, onInstall, steps: [] }} nowMs={NOW} outcome={POLICY} />);
    const button = screen.getByTestId("cr.policy.install");
    expect(button.textContent).toBe("Install the standard policy (1 slice)");
    fireEvent.click(button);
    expect(onInstall).toHaveBeenCalledTimes(1);
    cleanup();
    render(<PolicyScreen install={{ busy: true, onInstall, steps: [
      { kind: "REVIEWER_CALIBRATION", outcome: { code: "BOOTSTRAP_POLICY_SLICE_INVALID", layer: "DAEMON", ok: false }, sliceRef: "moe-reviewer-calibration/1" },
    ] }} nowMs={NOW} outcome={POLICY} />);
    expect(screen.getByTestId("cr.policy.install").textContent).toBe("Installing...");
    expect(screen.getByTestId("cr.policy.install.steps").textContent).toContain("Reviewer calibration · refused");
    expect(screen.getByTestId("cr.policy.install.steps").textContent).toContain("BOOTSTRAP_POLICY_SLICE_INVALID · DAEMON");
    cleanup();
    // Once everything is installed the block clears, but the receipts of what was installed from here stay.
    render(<PolicyScreen install={{ busy: false, onInstall, steps: [
      { kind: "REVIEWER_CALIBRATION", outcome: { ok: true }, sliceRef: "moe-reviewer-calibration/1" },
    ] }} nowMs={NOW} outcome={{ ...POLICY, standard: POLICY.standard.map((row) => ({ ...row, installed: true })) }} />);
    expect(screen.queryByTestId("cr.policy.standard")).toBeNull();
    expect(screen.getByTestId("cr.policy.install.steps").textContent).toContain("Reviewer calibration · installed from here");
  });

  it("shows loading, a refusal and the empty project", () => {
    render(<PolicyScreen nowMs={NOW} outcome={null} />);
    expect(screen.getByTestId("cr.policy.loading")).toBeTruthy();
    cleanup();
    render(<PolicyScreen nowMs={NOW} outcome={{ code: "LISTENER_POLICY_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.policy.refusal").textContent).toContain("The policy could not be read right now.");
    cleanup();
    render(<PolicyScreen nowMs={NOW} outcome={{ ...POLICY, evaluations: [], slices: [] }} />);
    expect(screen.getByTestId("cr.policy.empty").textContent).toContain("No policy installed.");
  });
});

describe("HealthScreen", () => {
  it("states the process and ledger facts in a person's words", () => {
    render(<HealthScreen nowMs={NOW} outcome={HEALTH} />);
    expect(screen.getByTestId("cr.health.banner").textContent).toBe("The daemon answered just now · up for 1 h · last decision 25 min ago");
    expect(screen.getByTestId("cr.health.since").textContent).toBe("2026-09-02T19:00:00.000Z");
    expect(screen.getByTestId("cr.health.project").textContent).toBe("unai");
    expect(screen.getByTestId("cr.health.plane").textContent).toBe("V1");
    expect(screen.getByTestId("cr.health.store").textContent).toBe("D:/store.sqlite");
    expect(screen.getByTestId("cr.health.decisions").textContent).toBe("40");
    expect(screen.getByTestId("cr.health.verifier").textContent).toBe("The verifier can accept delivered work.");
    expect(screen.getByTestId("cr.health.agents").textContent).toBe("not paused");
  });

  it("names the paused provider and when it resumes, in the reader's own locale", () => {
    render(<HealthScreen nowMs={NOW} outcome={{ ...HEALTH, agents: { paused: PAUSED } }} />);
    expect(screen.getByTestId("cr.health.agents").textContent)
      .toBe(`paused: claude limit, resumes ${new Date("2026-09-02T20:30:00.000Z").toLocaleString()}`);
  });

  it("still names the pause when the reset instant is one this browser cannot read", () => {
    render(<HealthScreen nowMs={NOW} outcome={{ ...HEALTH, agents: { paused: { ...PAUSED, resetAt: "whenever" } } }} />);
    expect(screen.getByTestId("cr.health.agents").textContent).toBe("paused: claude limit, resumes whenever");
  });
});

describe("LivePolicy / LiveHealth", () => {
  it("read through the injected reader on mount and render the answer", async () => {
    const read = vi.fn(async () => HEALTH);
    const onConnection = vi.fn();
    render(<LiveHealth headers={{}} onConnection={onConnection} pollMs={60_000} read={read} />);
    expect(await screen.findByTestId("cr.health.banner")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onConnection).toHaveBeenLastCalledWith("CONNECTED");
    cleanup();
    const down = vi.fn();
    render(<LiveHealth headers={{}} onConnection={down} pollMs={60_000} read={async () => ({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_OPS", status: "ERROR" as const })} />);
    await screen.findByTestId("cr.health.refusal");
    expect(down).toHaveBeenLastCalledWith("DISCONNECTED");
    cleanup();
    render(<LivePolicy headers={{}} pollMs={60_000} read={() => Promise.reject(new Error("x"))} />);
    expect((await screen.findByTestId("cr.policy.refusal")).textContent).toContain("POLICY_READ_FAILED");
  });
});
