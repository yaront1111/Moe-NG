/**
 * THE GOAL CARD: "N required variables unset for <environment>", and the section it links to.
 *
 * This is what stops a deploy failing for a reason nobody can see, so the arms below pin the
 * three ways it could lie: a wrong count, a card that appears when nothing is required, and a
 * card that omits WHICH environment it is counting for.
 *
 * The required names come from the APPROVED CONTRACT, read here through the same
 * `readPendingContract` outcome production reads - never re-derived from a fixture shape this
 * file invented.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EnvironmentVariablesOutcome } from "../../live/live-environment-variables.js";
import type { LiveSetup } from "../../live/live-config.js";
import { MIDDOT } from "../glyphs.js";
import { ENVIRONMENT_NAMES } from "../ops/environment-variables-model.js";
import { LiveGoalEnvironments } from "./goal-environments.js";
import { GOAL_SECTION_IDS } from "./goal-status-strip.js";

afterEach(cleanup);

const SETUP = { headers: {}, projectId: "proj-0001" } as unknown as LiveSetup;

/** A contract revision carrying the two required names, in the shape the read answers with. */
const contractWith = (names: readonly string[]): Awaited<ReturnType<
  Parameters<typeof LiveGoalEnvironments>[0]["readContract"] & object
>> => ({
  contractId: "contract-1",
  revision: {
    deploymentRequirements: names.length === 0
      ? [] : [{ environmentVariableNames: [...names], requirementId: "req-1" }],
  },
  revisionDigest: "d".repeat(64),
  revisionId: "rev-1",
  slot: "CURRENT",
  status: "CURRENT",
} as never);


const tableWith = (
  environment: string, setNames: readonly string[],
): EnvironmentVariablesOutcome => ({
  environment, status: "ENVIRONMENT_VARIABLES",
  variables: setNames.map((name) => ({
    fingerprintSha256: "a".repeat(64), isSet: true as const,
    name, updatedAt: "2026-09-07T09:00:00.000Z",
  })),
});

function renderSection(options: {
  readonly required: readonly string[];
  readonly set: Readonly<Record<string, readonly string[]>>;
}): ReturnType<typeof render> {
  return render(
    <LiveGoalEnvironments
      goalId="goal-1"
      readContract={() => Promise.resolve(contractWith(options.required))}
      readVariables={(environment) =>
        Promise.resolve(tableWith(environment, options.set[environment] ?? []))}
      setup={SETUP}
    />,
  );
}

describe("the unset count", () => {
  it("(a) shows ONE for a goal with two required names and one set", async () => {
    renderSection({
      required: ["DATABASE_URL", "SESSION_KEY"],
      set: { preview: ["DATABASE_URL"] },
    });
    const card = await screen.findByTestId("cr.env-vars.unset-card.preview");
    expect(card.textContent).toBe("1 required variables unset for preview");
    expect(card.getAttribute("data-count")).toBe("1");
  });

  it("counts per ENVIRONMENT, so two environments can differ", async () => {
    renderSection({
      required: ["DATABASE_URL", "SESSION_KEY"],
      set: { preview: ["DATABASE_URL", "SESSION_KEY"], production: [] },
    });
    await waitFor(() => {
      expect(screen.getByTestId("cr.env-vars.unset-card.preview").getAttribute("data-count")).toBe("0");
    });
    expect(screen.getByTestId("cr.env-vars.unset-card.production").getAttribute("data-count")).toBe("2");
  });

  it("NAMES the environment it counts for, because they are different facts", async () => {
    renderSection({
      required: ["DATABASE_URL"], set: {},
    });
    await waitFor(() => {
      expect(screen.getByTestId("cr.env-vars.unset-card.production")).toBeTruthy();
    });
    expect(screen.getByTestId("cr.env-vars.unset-card.preview").textContent)
      .toContain("unset for preview");
    expect(screen.getByTestId("cr.env-vars.unset-card.production").textContent)
      .toContain("unset for production");
  });

  it("(b) is ABSENT when the contract requires nothing - absent, not a zero badge", async () => {
    renderSection({ required: [], set: {} });
    // The section itself renders, so the absence below is not just "nothing mounted".
    await waitFor(() => { expect(screen.getAllByTestId("cr.env-vars.root").length).toBe(ENVIRONMENT_NAMES.length); });
    expect(screen.queryByTestId("cr.env-vars.unset-card.preview")).toBeNull();
  });

  it("is ABSENT when the contract could not be read, rather than reporting zero unset", async () => {
    // An unread contract is not the fact "nothing is required". A card saying 0 over an unread
    // contract is the kind of quiet green that gets believed.
    render(
      <LiveGoalEnvironments
        goalId="goal-1"
        readContract={() => Promise.resolve({ status: "NONE" } as never)}
        readVariables={(environment) => Promise.resolve(tableWith(environment, []))}
        setup={SETUP}
      />,
    );
    await waitFor(() => { expect(screen.getAllByTestId("cr.env-vars.root").length).toBe(ENVIRONMENT_NAMES.length); });
    expect(screen.queryByTestId("cr.env-vars.unset-card.preview")).toBeNull();
  });
});

describe("the card links to the screen, and carries nothing else", () => {
  it("links to the environments section anchor", async () => {
    renderSection({ required: ["DATABASE_URL"], set: {} });
    const link = (await screen.findByTestId("cr.env-vars.unset-card.preview"))
      .querySelector("a");
    expect(link?.getAttribute("href")).toBe(`#${GOAL_SECTION_IDS.environments}`);
    // And the anchor the link points at actually exists on the page.
    expect(document.getElementById(GOAL_SECTION_IDS.environments)).not.toBeNull();
  });

  it("renders NAMES and COUNTS only - no value, and no fingerprint on the card", async () => {
    const { container } = renderSection({
      required: ["DATABASE_URL", "SESSION_KEY"],
      set: { preview: ["DATABASE_URL"] },
    });
    const card = await screen.findByTestId("cr.env-vars.unset-card.preview");
    // A fingerprint on a summary card is the thing an operator would most plausibly mistake for
    // a truncated secret, so it must not be there even though it is not itself a value.
    expect(card.innerHTML).not.toContain("a".repeat(64));
    expect(card.innerHTML).not.toContain("fingerprint");
    // CONTROL: the fingerprint IS present further down, in the table, so its absence on the card
    // is a property of the card rather than of the whole render.
    expect(container.innerHTML).toContain("sha256 fingerprint");
  });
});

describe("the section mounts the screen it links to", () => {
  it("renders one screen per environment the STORE roster names, deployed or not", async () => {
    // The roster is the store's own closed `ENVIRONMENT_NAMES`, not a deploy-derived list: an
    // operator must reach `preview` variables before anything is ever deployed, which is exactly
    // the case a deploy-derived list would show nothing for.
    renderSection({ required: ["DATABASE_URL"], set: {} });
    await waitFor(() => {
      expect(screen.getAllByTestId("cr.env-vars.root").length).toBe(ENVIRONMENT_NAMES.length);
    });
    // One kicker per environment, each naming its own - so the screens are not copies of one
    // environment stacked - and in the roster's own order.
    expect(screen.getAllByTestId("cr.env-vars.kicker").map((node) => node.textContent))
      .toEqual(ENVIRONMENT_NAMES.map((name) => `Environment variables ${MIDDOT} ${name}`));
  });

  it("lists preview, production and verify - the three the store admits", () => {
    // Pinned as a literal rather than derived from the constant, so a drift away from the
    // daemon's `ENVIRONMENT_NAMES` reds here instead of silently changing what an operator sees.
    // The e2e journey holds the other end: an unrostered name refuses ENV_ENVIRONMENT_UNKNOWN.
    expect([...ENVIRONMENT_NAMES]).toEqual(["preview", "production", "verify"]);
  });
});
