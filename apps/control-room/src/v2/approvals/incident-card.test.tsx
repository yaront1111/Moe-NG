import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ERROR_LINE, LAST_PROBE_AT, OPENED_AT, TARGET_SHA, health, healthMap, rollbackOffer, surface,
} from "./incident-frames.fixture.js";
import { deriveNeedsYou } from "./needs-you-model.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { NeedsYou } from "./needs-you.js";

/**
 * THE INCIDENT CARD, rendered through the WHOLE queue rather than the leaf component: the
 * operator sees `NeedsYou`, and a leaf-only test would keep passing the day the queue stopped
 * rendering the leaf. Every fixture arrives through `deriveNeedsYou` over a health frame decoded
 * by the production client, so nothing here asserts against a shape the wire cannot produce.
 */

const KEY = "production#7";
const EMPTY_CATALOG = { connection: "CONNECTED", detail: "", goals: [], outcome: "GOALS" } as const;

function derive(
  input: Partial<Parameters<typeof deriveNeedsYou>[0]> = {},
): ReturnType<typeof deriveNeedsYou> {
  return deriveNeedsYou({
    catalog: EMPTY_CATALOG, coverage: new Map(), health: healthMap(health()),
    surface: surface([rollbackOffer()]), ...input,
  });
}

function draw(
  input: Partial<Parameters<typeof deriveNeedsYou>[0]> = {},
  props: Partial<Parameters<typeof NeedsYou>[0]> = {},
): void {
  render(
    <NeedsYou
      data={derive(input)}
      onDismissIncident={(): void => undefined}
      onOpenBoard={(): void => undefined}
      onRollback={(): void => undefined}
      {...props}
    />,
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });


describe("the incident card puts the real error line in front of the operator", () => {
  it("renders the environment, the since-instant and the error line VERBATIM", () => {
    draw();
    const card = screen.getByTestId(`cr.needsyou.item.incident.${KEY}`);
    // THE EXACT LINE, against the WHOLE rendered container: not a substring match on some
    // error-ish word, and not one hand-picked node. A card showing only "unhealthy" sends the
    // operator to the logs this card was built to replace.
    expect(card.textContent).toContain(ERROR_LINE);
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.error`).textContent).toBe(ERROR_LINE);
    expect(card.textContent).toContain(`production unhealthy since ${OPENED_AT}`);
  });

  it("does not truncate, ellipsise or re-case a long error line", () => {
    const line = `${"stack frame ".repeat(40)}Error: UPSTREAM said 502 (attempt 3/3)  `;
    draw({
      health: healthMap(health({
        lastError: {
          at: "2026-09-08T01:14:51.000Z", code: "DEPLOY_HEALTHCHECK_FAILED",
          layer: "DAEMON_DEPLOY_RUNNER", line, source: "DEPLOY_RECEIPT",
        },
      })),
    });
    const rendered = screen.getByTestId(`cr.needsyou.incident.${KEY}.error`);
    expect(rendered.textContent).toBe(line);
    expect(rendered.textContent).not.toContain("...");
  });

  it("names the refusing authority BESIDE the line, never interpolated into it", () => {
    draw();
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.errormeta`).textContent)
      .toContain("DEPLOY_HEALTHCHECK_FAILED @ DAEMON_DEPLOY_RUNNER");
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.error`).textContent)
      .not.toContain("DEPLOY_HEALTHCHECK_FAILED");
  });

  /**
   * SINCE IS THE INCIDENT'S OWN INSTANT. The probe answers every 30s, so `lastProbe.at` is
   * always "just now" during an outage; the operator needs how long this has been happening.
   * The two diverge exactly when it matters, so the probe instant must appear nowhere.
   */
  it("takes SINCE from the incident opened-at, not from the last probe", () => {
    draw();
    const card = screen.getByTestId(`cr.needsyou.item.incident.${KEY}`);
    expect(card.textContent).toContain(`open since ${OPENED_AT}`);
    expect(card.textContent).not.toContain(LAST_PROBE_AT);
  });

  it("says so plainly when the daemon has recorded no error line, rather than showing a blank", () => {
    draw({ health: healthMap(health({ lastError: null })) });
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.error`)).toBeNull();
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.noerror`).textContent)
      .toContain("no error line");
  });
});

describe("the roll back control is the daemon's offer or it does not exist", () => {
  it("is ABSENT - not disabled - when the daemon offers no rollback", () => {
    draw({ surface: surface([]) });
    // ABSENT: query for the testid and find nothing. A disabled button is still a button an
    // operator reaches for mid-incident, and this board has shipped that dead control once.
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.rollback`)).toBeNull();
    expect(screen.getByTestId(`cr.needsyou.item.incident.${KEY}`)).toBeTruthy();
  });

  it("is ABSENT when this environment has no receipt to roll back to", () => {
    draw({ health: healthMap(health({ rollbackTarget: null })) });
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.rollback`)).toBeNull();
  });

  it("is ABSENT when the browser was handed no rollback dispatcher", () => {
    draw({}, { onRollback: undefined });
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.rollback`)).toBeNull();
  });
});

describe("the confirm names the target sha and the environment", () => {
  it("names BOTH at the confirm itself, and the sha is the receipt's own", () => {
    draw();
    const before = screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`);
    // Before arming there is no confirm surface at all.
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.confirm`)).toBeNull();
    fireEvent.click(before);
    // THE CONFIRM SURFACE ITSELF - the elements that exist only once armed - and the sha is
    // compared against the read's own rollbackTarget.sha, never against a hex pattern.
    const confirm = screen.getByTestId(`cr.needsyou.incident.${KEY}.confirm`);
    expect(confirm.textContent).toContain(TARGET_SHA);
    expect(confirm.textContent).toContain("production");
    const armedButton = screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`);
    expect(armedButton.textContent).toContain(TARGET_SHA);
    expect(armedButton.textContent).toContain("production");
    expect(armedButton.getAttribute("aria-label")).toContain(TARGET_SHA);
  });

  it("spends the offer only on the SECOND press, and can be stood down", () => {
    const onRollback = vi.fn();
    draw({}, { onRollback });
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`));
    expect(onRollback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback.cancel`));
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.confirm`)).toBeNull();
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`));
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`));
    expect(onRollback).toHaveBeenCalledTimes(1);
    const item: NeedsYouItem | undefined = onRollback.mock.calls[0]?.[0] as NeedsYouItem | undefined;
    expect(item?.incident?.rollback?.target.sha).toBe(TARGET_SHA);
  });

  it("shows the refusing authority's own code and layer when the dispatch is refused", () => {
    render(
      <NeedsYou
        data={derive()}
        decisionResults={new Map([[KEY, {
          busy: false,
          outcome: { code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: "DAEMON_DEPLOY_ENGINE", ok: false },
        }]])}
        onDismissIncident={(): void => undefined}
        onOpenBoard={(): void => undefined}
        onRollback={(): void => undefined}
      />,
    );
    const card = within(screen.getByTestId(`cr.needsyou.item.incident.${KEY}`));
    expect(card.getByTestId(`cr.needsyou.result.${KEY}`).textContent)
      .toContain("DEPLOY_ROLLBACK_IN_PROGRESS");
  });
});

/**
 * TWO ENVIRONMENTS DOWN AT ONCE is the shape that makes the confirm's sha a real question. The
 * `deployment.rollback` offer is minted ONCE PER PROJECT, so both cards are offered by the same
 * affordance and the only per-environment authority is each frame's own `rollbackTarget`. If the
 * queue keyed its cards on anything an incident leaves empty - `goalId` is "" by design here -
 * React would reuse ONE card instance and the two would SHARE the armed confirm: the operator
 * arms staging, reads production's sha, and confirms. That is DoD 2's own hazard arriving as a
 * reconciliation bug, and no single-environment fixture can see it.
 */
describe("two environments in an open incident do not share a confirm", () => {
  const STAGING_SHA = "77fedcba9876543210fedcba9876543210fedcba";
  const staging = (): ReturnType<typeof health> => health({
    environment: "staging",
    rollbackTarget: {
      imageDigest: `sha256:${"b".repeat(64)}`, sha: STAGING_SHA, toReceiptRef: "d".repeat(64),
    },
  });

  it("gives each card its own armed state and its OWN sha at the confirm", () => {
    draw({ health: healthMap(health(), staging()) });
    const stagingKey = "staging#7";
    expect(STAGING_SHA).not.toBe(TARGET_SHA);
    fireEvent.click(screen.getByTestId(`cr.needsyou.incident.${stagingKey}.rollback`));
    // The armed card names ITS OWN target, not the other environment's.
    const confirm = screen.getByTestId(`cr.needsyou.incident.${stagingKey}.confirm`);
    expect(confirm.textContent).toContain(STAGING_SHA);
    expect(confirm.textContent).toContain("staging");
    expect(confirm.textContent).not.toContain(TARGET_SHA);
    // The other card did NOT arm: no confirm surface, and its button is still the first press.
    expect(screen.queryByTestId(`cr.needsyou.incident.${KEY}.confirm`)).toBeNull();
    expect(screen.getByTestId(`cr.needsyou.incident.${KEY}.rollback`).textContent).toBe("Roll back");
  });

  it("hands the port the environment whose card was pressed, with that card's receipt", () => {
    const onRollback = vi.fn();
    draw({ health: healthMap(health(), staging()) }, { onRollback });
    fireEvent.click(screen.getByTestId("cr.needsyou.incident.staging#7.rollback"));
    fireEvent.click(screen.getByTestId("cr.needsyou.incident.staging#7.rollback"));
    const item: NeedsYouItem | undefined = onRollback.mock.calls[0]?.[0] as NeedsYouItem | undefined;
    expect(item?.incident?.environment).toBe("staging");
    expect(item?.incident?.rollback?.target.sha).toBe(STAGING_SHA);
    expect(item?.incident?.rollback?.target.toReceiptRef).toBe("d".repeat(64));
  });

  it("keeps one card's refusal off the other card", () => {
    render(
      <NeedsYou
        data={derive({ health: healthMap(health(), staging()) })}
        decisionResults={new Map([["staging#7", {
          busy: false,
          outcome: { code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: "DAEMON_DEPLOY_ENGINE", ok: false },
        }]])}
        onDismissIncident={(): void => undefined}
        onOpenBoard={(): void => undefined}
        onRollback={(): void => undefined}
      />,
    );
    expect(within(screen.getByTestId("cr.needsyou.item.incident.staging#7"))
      .getByTestId("cr.needsyou.result.staging#7").textContent)
      .toContain("DEPLOY_ROLLBACK_IN_PROGRESS");
    expect(within(screen.getByTestId(`cr.needsyou.item.incident.${KEY}`))
      .queryByTestId(`cr.needsyou.result.${KEY}`)).toBeNull();
  });
});
