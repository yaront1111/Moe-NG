import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE } from "../kernel.js";
import { NodeAuthority, UNKNOWN_FACT_VALUE } from "./node-authority.js";
import type { NodeAuthorityProps, PresentedFact } from "./node-authority.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const observed = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const verified = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });

/** Every fact the daemon already projected and preclassified, in rendered order. */
const AUTHORITY_FACT_IDS = [
  "node.id", "node.objective", "node.criteria", "node.writescope", "node.authorityhash",
  "node.phase", "node.reopencount",
  "node.lease.principal", "node.lease.epoch", "node.lease.expiry",
  "node.lease.renewalsilence", "node.lease.activitysilence",
  "node.plan.revision", "node.plan.hash", "node.plan.approvalhash", "node.plan.validity",
] as const;

function authorityProps(): NodeAuthorityProps {
  return {
    identity: {
      acceptanceCriteria: verified("contract tests green; p99 under 120ms"),
      nodeAuthorityHash: verified("sha256:a3f9c2authority"),
      nodeId: observed("api-endpnt"),
      objective: verified("POST /retry endpoint with idempotency-key"),
      writeScope: verified("src/api/**"),
    },
    lease: {
      activitySilence: observed("no worker activity for 41m"),
      epoch: observed("7"),
      expiry: observed("2026-08-08T09:41:00.000Z"),
      principal: observed("w-3"),
      renewalSilence: observed("renewed 41s ago"),
    },
    legalCommandKinds: ["blocker.open", "approval.decide"],
    phase: { phase: observed("EXECUTING"), reopenCount: observed("0 of 3") },
    plan: {
      approvalHash: verified("sha256:approval-11"),
      approvalValidity: { truthClass: "HUMAN_APPROVED", value: "CURRENT" },
      planHash: verified("sha256:plan-7"),
      planRevision: observed("rev a3f9c2"),
    },
  };
}

const factIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("[data-testid^='cr.fact.']")]
    .map((node) => node.getAttribute("data-testid") ?? "");

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

describe("node authority renders daemon-projected facts, not derivations", () => {
  it("separates identity, phase, lease, and plan into their own labelled sections", () => {
    const { container } = render(<NodeAuthority {...authorityProps()} />);
    for (const section of ["identity", "phase", "lease", "plan"]) {
      const element = screen.getByTestId(`cr.inspector.section.${section}`);
      expect(element.tagName).toBe("SECTION");
      expect(within(element).getByRole("heading").textContent).not.toBe("");
    }
    expect(factIds(container)).toEqual(AUTHORITY_FACT_IDS.map((id) => `cr.fact.${id}`));
  });

  it("keeps objective, criteria, write scope, and the authority hash distinguishable", () => {
    render(<NodeAuthority {...authorityProps()} />);
    expect(valueOf("node.objective")).toBe("POST /retry endpoint with idempotency-key");
    expect(valueOf("node.criteria")).toBe("contract tests green; p99 under 120ms");
    expect(valueOf("node.writescope")).toBe("src/api/**");
    expect(valueOf("node.authorityhash")).toBe("sha256:a3f9c2authority");
    expect(valueOf("node.reopencount")).toBe("0 of 3");
    expect(screen.getByTestId("cr.inspector.loopcounter").textContent).toContain("0 of 3");
  });

  it("keeps lease principal, epoch, expiry, and the two silence datums apart", () => {
    render(<NodeAuthority {...authorityProps()} />);
    expect(valueOf("node.lease.principal")).toBe("w-3");
    expect(valueOf("node.lease.epoch")).toBe("7");
    expect(valueOf("node.lease.expiry")).toBe("2026-08-08T09:41:00.000Z");
    // Activity silence and renewal silence answer different questions; a surface that
    // collapses them lets a renewing-but-idle worker read as working.
    expect(valueOf("node.lease.renewalsilence")).toBe("renewed 41s ago");
    expect(valueOf("node.lease.activitysilence")).toBe("no worker activity for 41m");
    expect(valueOf("node.lease.renewalsilence")).not.toBe(valueOf("node.lease.activitysilence"));
  });

  it("keeps plan revision, plan hash, and approval hash separate", () => {
    render(<NodeAuthority {...authorityProps()} />);
    expect(valueOf("node.plan.revision")).toBe("rev a3f9c2");
    expect(valueOf("node.plan.hash")).toBe("sha256:plan-7");
    expect(valueOf("node.plan.approvalhash")).toBe("sha256:approval-11");
    expect(valueOf("node.plan.validity")).toBe("CURRENT");
  });
});

describe("legal commands come only from the supplied list", () => {
  it("renders exactly the supplied kinds under the grammar's action ids", () => {
    const { container } = render(<NodeAuthority {...authorityProps()} />);
    const actions = [...container.querySelectorAll("[data-testid^='cr.action.']")]
      .map((node) => node.getAttribute("data-testid"));
    expect(actions).toEqual(["cr.action.blocker-open", "cr.action.approval-decide"]);
    expect(screen.getByTestId("cr.action.blocker-open").textContent).toBe("blocker.open");
  });

  it("stays empty for an empty list even in a phase that usually permits commands", () => {
    const props = authorityProps();
    const { container } = render(
      <NodeAuthority {...props} legalCommandKinds={[]} phase={props.phase} />,
    );
    expect(valueOf("node.phase")).toBe("EXECUTING");
    expect(container.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
    expect(screen.getByTestId("cr.inspector.legalcommands").textContent)
      .toBe("No commands supplied by the daemon.");
  });
});

describe("secrets never reach the DOM and every fact carries a chip", () => {
  it("declares no lease token or credential channel and drops hostile extra keys", () => {
    type Secret = Extract<
      keyof NodeAuthorityProps["lease"],
      "credential" | "leaseToken" | "secret" | "sessionToken" | "token"
    >;
    // A structural guard: adding any secret-bearing key makes this annotation false.
    const leaseCarriesNoSecret: [Secret] extends [never] ? true : false = true;
    expect(leaseCarriesNoSecret).toBe(true);
    const base = authorityProps();
    const hostile = {
      ...base,
      lease: { ...base.lease, leaseToken: "lease-token-9f", sessionCredential: "cred-77" },
    } as unknown as NodeAuthorityProps;
    const { container } = render(<NodeAuthority {...hostile} />);
    expect(container.textContent).not.toContain("lease-token-9f");
    expect(container.textContent).not.toContain("cred-77");
  });

  it("nests exactly one truth chip inside every fact wrapper", () => {
    const { container } = render(<NodeAuthority {...authorityProps()} />);
    const wrappers = container.querySelectorAll("[data-testid^='cr.fact.']");
    expect(wrappers.length).toBe(AUTHORITY_FACT_IDS.length);
    expect(container.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(wrappers.length);
    for (const wrapper of wrappers) {
      expect(wrapper.querySelector("[data-testid^='cr.chip.']")).not.toBeNull();
    }
  });

  it("identifies the originating fact when provenance is opened by keyboard", async () => {
    const opened: string[] = [];
    const user = userEvent.setup();
    render(
      <NodeAuthority {...authorityProps()} onProvenance={(factId) => opened.push(factId)} />,
    );
    const chip = within(screen.getByTestId("cr.fact.node.authorityhash"))
      .getByTestId("cr.chip.daemon_verified");
    chip.focus();
    expect(document.activeElement).toBe(chip);
    await user.keyboard("{Enter}");
    expect(opened).toEqual(["node.authorityhash"]);
  });
});

describe("absent and malformed authority facts stay honest", () => {
  it("renders UNKNOWN with the missing-class note rather than a blank or a zero", () => {
    const base = authorityProps();
    render(
      <NodeAuthority
        {...base}
        lease={{ ...base.lease, epoch: null }}
        plan={{ ...base.plan, approvalHash: { value: "" } }}
      />,
    );
    expect(valueOf("node.lease.epoch")).toBe(UNKNOWN_FACT_VALUE);
    expect(valueOf("node.plan.approvalhash")).toBe(UNKNOWN_FACT_VALUE);
    for (const factId of ["node.lease.epoch", "node.plan.approvalhash"]) {
      const chip = chipOf(factId);
      expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
      expect(chip.getAttribute("data-origin")).toBe("ABSENT");
      expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
    }
  });

  it("reports TRUTH_CLASS_INVALID for a present but unsupported class", () => {
    const base = authorityProps();
    render(
      <NodeAuthority
        {...base}
        identity={{ ...base.identity, nodeAuthorityHash: { truthClass: "verified", value: "h" } }}
      />,
    );
    const chip = chipOf("node.authorityhash");
    expect(chip.getAttribute("data-origin")).toBe("INVALID");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_INVALID_PROVENANCE);
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
  });
});
