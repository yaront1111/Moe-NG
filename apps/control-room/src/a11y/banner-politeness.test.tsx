import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApprovalDetailPlan } from "../approvals/approval-detail-plan.js";
import {
  APPROVAL_FIXTURE_RECORDS,
  FIXTURE_REVISION_HASH,
  FIXTURE_SUPERSEDING_HASH,
  approvalAffordance,
  withRecord,
} from "../approvals/approval-fixtures.js";
import { CONTROL_ROOM_FIXTURES } from "../fixtures.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { SuppliedFact } from "../nodes/node-authority.js";
import type { CircuitBreakerFact } from "../shell/circuit-breaker-banner.js";
import { ShellFrame } from "../shell/frame.js";
import { FixtureBanner } from "../shell-mode-view.js";

/**
 * Spec section 11.1 line 687: banners announce POLITELY.
 *
 * This is deliberately STRICTER than `auditLiveRegions` in `surface-audit.ts`, which asks
 * only whether a banner IS a live region and accepts `alert`/`assertive`. An assertive
 * region interrupts a screen-reader user mid-sentence; these are statuses, not alerts.
 *
 * `cr.banner.disconnected` and `cr.banner.lag` are asserted in `shell/gating-keyboard.test.tsx`,
 * which already renders both. This file covers the two that need their own surfaces, and
 * pins the banner-id set so a FIFTH banner cannot appear without a politeness test.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "banner-target";

/**
 * Every banner id that exists in production today. `cr.banner.revision` and
 * `cr.graph.refusal` are NOT here because they do not exist; no stub may be created to
 * give this sweep something to find.
 */
const BANNER_IDS = Object.freeze([
  "cr.banner.circuitbreaker",
  "cr.banner.disconnected",
  "cr.banner.fixture",
  "cr.banner.invalidated",
  "cr.banner.lag",
]);

const BANNER_ID_DECLARATION = /data-testid="(cr\.banner\.[a-z]+)"/gu;

const obs = (value: string): SuppliedFact => ({ truthClass: "OBSERVED", value });

const BREAKER: CircuitBreakerFact = Object.freeze({
  command: obs("pnpm --filter @moe/control-room test"),
  correlatedChildren: obs("3"),
  locus: obs("apps/control-room"),
  targetAggregateId: TARGET,
});

function connected(): FixtureAffordanceSnapshot {
  const base = CONTROL_ROOM_FIXTURES.affordances.find((item) => item.connection === "CONNECTED");
  if (base === undefined) throw new Error("missing CONNECTED acceptance fixture");
  return base;
}

/** The invalidation banner renders only when a supersession delta is supplied. */
function approvalWithDelta(): JSX.Element {
  const ver = (value: string): SuppliedFact => ({ truthClass: "DAEMON_VERIFIED", value });
  return (
    <ApprovalDetailPlan
      affordances={[approvalAffordance("approval.decide", { targetAggregateId: TARGET })]}
      delta={{ supersededHash: FIXTURE_SUPERSEDING_HASH, unchangedSteps: 2 }}
      node="node-banner"
      objective={ver("banner politeness")}
      oracle={ver("focused tests exit 0")}
      recipeValid={ver("valid")}
      record={withRecord(APPROVAL_FIXTURE_RECORDS.PLAN, {
        exactRevisionHash: FIXTURE_REVISION_HASH,
      })}
      steps={["audit"]}
      targetAggregateId={TARGET}
      writeScope={ver("apps/control-room/**")}
    />
  );
}

/** Stable reason codes, so a failure says WHICH way the banner stopped being polite. */
function politeness(banner: Element): string {
  const role = banner.getAttribute("role");
  const live = banner.getAttribute("aria-live");
  if (role === "alert" || live === "assertive") return "ASSERTIVE";
  return role === "status" || live === "polite" ? "POLITE" : "NO_LIVE_REGION";
}

function bannerIn(root: ParentNode, id: string): Element {
  const found = root.querySelector(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`${id} did not render`);
  return found;
}

function productionSources(): readonly string[] {
  return readdirSync(SRC_ROOT, { encoding: "utf8", recursive: true })
    .filter((entry) => entry.endsWith(".tsx"))
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => !entry.includes(".test.") && !entry.includes("fixtures"));
}

describe("every banner that exists announces politely", () => {
  it("keeps the supersession-invalidation banner polite", () => {
    const root = render(
      <ShellFrame affordance={connected()}>{approvalWithDelta()}</ShellFrame>,
    ).container;
    expect(politeness(bannerIn(root, "cr.banner.invalidated"))).toBe("POLITE");
  });

  it("keeps the circuit-breaker banner polite alongside the connection banners", () => {
    const root = render(
      <ShellFrame affordance={connected()} breaker={BREAKER}>
        <p>{"surface"}</p>
      </ShellFrame>,
    ).container;
    expect(politeness(bannerIn(root, "cr.banner.circuitbreaker"))).toBe("POLITE");
  });

  it("keeps the fixture-board banner polite", () => {
    // It is persistent rather than event-driven, but it still lands mid-session
    // for anyone who follows a ?fixtures=1 link, and interrupting a screen-reader
    // user to say "these numbers are frozen" is the same overreach as any other
    // assertive banner here.
    const root = render(<FixtureBanner />).container;
    expect(politeness(bannerIn(root, "cr.banner.fixture"))).toBe("POLITE");
  });

  it("pins the banner-id set so a new banner cannot skip this file", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(20);
    const declared = new Set<string>();
    for (const source of sources) {
      const text = readFileSync(join(SRC_ROOT, ...source.split("/")), "utf8");
      for (const match of text.matchAll(BANNER_ID_DECLARATION)) {
        const id = match[1];
        if (id !== undefined) declared.add(id);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...BANNER_IDS]);
  });
});
