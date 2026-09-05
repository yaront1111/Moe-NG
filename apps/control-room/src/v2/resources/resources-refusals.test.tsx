import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mapActivationAnswer } from "../../live/live-activation.js";
import { mapHealthAnswer, mapPolicyAnswer } from "../../live/live-ops.js";
import { mapRepositoryRemoteAnswer } from "../../live/live-repository-remote.js";
import { mapSessionsAnswer } from "../../live/live-sessions.js";
import {
  ACTIVATION_BODY, HEALTH_EMPTY_STORE_BODY, REPO_ROOT, STORE_PATH, activation, allRead,
  decoded, refusalOf, withProviderReceipt,
} from "./resources-frames.fixture.js";
import { RESOURCES_LAYER } from "./resources-credential.js";
import { ResourcesScreen } from "./resources-screen.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/**
 * REFUSALS AND PARTIAL READS.
 *
 * A resources screen that silently omits a fact it could not read is indistinguishable
 * from a project that has no such resource - the difference between "your store is fine"
 * and "I could not read your store". So every arm asserts BOTH halves: the refusing
 * read's own rows carry ITS code verbatim, and every fact from every other read is still
 * on screen with a value. Asserting only the refusal would pass on a screen that had
 * blanked itself; asserting only the survivors would pass on one that hid the failure.
 *
 * Each refusal is built by `refusalOf`, which asserts the PRODUCTION decoder really read
 * the envelope AS a refusal carrying those exact bytes - so no arm here can be driven by
 * some other error the decoder invented for a frame it did not recognise.
 */

const LISTENER = "HTTP_LISTENER";
const value = (id: string): string =>
  screen.getByTestId(`cr.resources.value.${id}`).textContent ?? "";
const refusalText = (id: string): string =>
  screen.getByTestId(`cr.resources.refusal.${id}`).textContent ?? "";

const activationRefused = (): ReturnType<typeof mapActivationAnswer> =>
  refusalOf(mapActivationAnswer, "ACTIVATION_READ_FORBIDDEN", LISTENER, "REFUSED");
const healthRefused = (): ReturnType<typeof mapHealthAnswer> =>
  refusalOf(mapHealthAnswer, "HEALTH_READ_FORBIDDEN", LISTENER, "REFUSED");
const policyRefused = (): ReturnType<typeof mapPolicyAnswer> =>
  refusalOf(mapPolicyAnswer, "POLICY_READ_FORBIDDEN", LISTENER, "REFUSED");
const remoteRefused = (): ReturnType<typeof mapRepositoryRemoteAnswer> =>
  refusalOf(mapRepositoryRemoteAnswer, "REPOSITORY_REMOTE_READ_FORBIDDEN", LISTENER, "REFUSED");
const sessionsRefused = (): ReturnType<typeof mapSessionsAnswer> =>
  refusalOf(mapSessionsAnswer, "SESSIONS_READ_FORBIDDEN", LISTENER, "REFUSED");

/** Every row that keeps a VALUE while the named read alone refuses. */
const survivors = (ids: readonly string[]): void => {
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(value(id), id).not.toBe("");
};

describe("one refusing read never blanks the rest of the screen", () => {
  it("states the activation refusal on its own rows and keeps every other read's facts", () => {
    render(<ResourcesScreen reads={{ ...allRead(), activation: activationRefused() }} />);

    for (const id of [
      "repository.root", "repository.head", "provider.cli", "provider.credential",
      "store.backup", "store.distribution",
    ]) {
      expect(refusalText(id), id).toContain(`ACTIVATION_READ_FORBIDDEN @ ${LISTENER}`);
    }
    survivors(["repository.remote", "store.path", "governance.policy", "governance.seatlimit", "governance.seatsactive"]);
    // The store path is carried by /health/read TOO, so activation refusing cannot blank it.
    expect(value("store.path")).toBe(STORE_PATH);
  });

  it("states the policy refusal on the revision row alone", () => {
    render(<ResourcesScreen reads={{ ...allRead(), policy: policyRefused() }} />);
    expect(refusalText("governance.policy")).toContain(`POLICY_READ_FORBIDDEN @ ${LISTENER}`);
    survivors(["repository.root", "repository.head", "provider.cli", "store.path", "store.distribution", "governance.seatlimit"]);
  });

  it("states the sessions refusal on both seat rows alone", () => {
    render(<ResourcesScreen reads={{ ...allRead(), sessions: sessionsRefused() }} />);
    for (const id of ["governance.seatlimit", "governance.seatsactive"]) {
      expect(refusalText(id), id).toContain(`SESSIONS_READ_FORBIDDEN @ ${LISTENER}`);
    }
    survivors(["repository.root", "provider.cli", "store.path", "governance.policy"]);
  });

  it("states the remote refusal on the remote row alone", () => {
    render(<ResourcesScreen reads={{ ...allRead(), remote: remoteRefused() }} />);
    expect(refusalText("repository.remote"))
      .toContain(`REPOSITORY_REMOTE_READ_FORBIDDEN @ ${LISTENER}`);
    survivors(["repository.root", "repository.head", "provider.cli", "store.path", "governance.policy"]);
  });

  it("keeps the store path standing on whichever of its two carriers answered", () => {
    render(<ResourcesScreen reads={{ ...allRead(), activation: activationRefused() }} />);
    expect(value("store.path")).toBe(STORE_PATH);
    cleanup();

    render(<ResourcesScreen reads={{ ...allRead(), health: healthRefused() }} />);
    expect(value("store.path")).toBe(STORE_PATH);
    cleanup();

    // Only when BOTH carriers refuse does the row refuse - naming a code, never blanking.
    render(<ResourcesScreen reads={{
      ...allRead(), activation: activationRefused(), health: healthRefused(),
    }} />);
    expect(screen.queryByTestId("cr.resources.value.store.path")).toBeNull();
    expect(refusalText("store.path")).toContain(`HEALTH_READ_FORBIDDEN @ ${LISTENER}`);
  });

  it("states an unmeasured RECEIPT's own code, not the read's, when the read itself answered", () => {
    // /activation/read answered fine; the provider RECEIPT inside it is what could not be
    // measured. The row must say which, or an operator cannot tell a forbidden read from
    // an unconfigured provider - two very different things to go and fix.
    render(<ResourcesScreen reads={{
      ...allRead(),
      activation: activation(withProviderReceipt({
        code: "ACTIVATION_PROVIDER_UNMEASURED", hash: null, layer: "ACTIVATION_RECEIPTS",
        measured: false, member: "provider", reason: "no provider profile has been probed",
        ref: null,
      })),
    }} />);
    for (const id of ["provider.cli", "provider.credential"]) {
      expect(refusalText(id), id).toContain("ACTIVATION_PROVIDER_UNMEASURED @ ACTIVATION_RECEIPTS");
    }
    expect(value("repository.root")).toBe(REPO_ROOT);
  });
});

describe("nothing readable renders something honest, not an empty panel", () => {
  const allRefused = (): void => {
    render(<ResourcesScreen reads={{
      activation: activationRefused(), health: healthRefused(), policy: policyRefused(),
      remote: remoteRefused(), sessions: sessionsRefused(),
    }} />);
  };

  it("keeps every row on screen, each carrying a code", () => {
    allRefused();
    const rows = [...screen.getByTestId("cr.resources.screen")
      .querySelectorAll("[data-testid^='cr.resources.fact.']")];
    expect(rows).toHaveLength(13);
    for (const row of rows) {
      expect(row.getAttribute("data-state"), row.getAttribute("data-testid") ?? "").toBe("REFUSED");
    }
    expect(screen.queryAllByTestId(/^cr\.resources\.value\./u)).toHaveLength(0);
    // And it SAYS so, with the denominator, rather than looking like a project that
    // simply has no resources.
    expect(screen.getByTestId("cr.resources.banner").textContent)
      .toBe("None of this project's resources could be read. 13 of 13 facts state why below.");
  });

  it("carries each refusing read's OWN code, so the rows are not one generic failure", () => {
    allRefused();
    for (const [id, code] of [
      ["repository.root", "ACTIVATION_READ_FORBIDDEN"],
      ["repository.remote", "REPOSITORY_REMOTE_READ_FORBIDDEN"],
      ["store.path", "HEALTH_READ_FORBIDDEN"],
      ["governance.policy", "POLICY_READ_FORBIDDEN"],
      ["governance.seatlimit", "SESSIONS_READ_FORBIDDEN"],
      ["repository.branch", "RESOURCES_FACT_NOT_SERVED"],
    ] as const) {
      expect(refusalText(id), id).toContain(`${code} @ `);
    }
    // Five distinct codes across the rows: a screen that mapped every failure to one
    // house code would pass every arm above and still tell the operator nothing.
    const codes = new Set([...screen.queryAllByTestId(/^cr\.resources\.refusal\./u)]
      .map((node) => (/([A-Z][A-Z0-9_]+) @ /u.exec(node.textContent ?? "")?.[1] ?? "")));
    expect(codes.size).toBeGreaterThanOrEqual(5);
    expect(codes.has("")).toBe(false);
  });

  it("shows the daemon's code behind Details, with the person's sentence in front", () => {
    allRefused();
    const note = screen.getByTestId("cr.resources.refusal.governance.policy");
    expect(note.querySelector(".cr2-outcome-said")?.textContent)
      .toBe("The policy revision could not be read right now.");
    // VERBATIM: the code and layer as the daemon stated them, not paraphrased into a bucket.
    expect(note.querySelector("code")?.textContent).toBe(`POLICY_READ_FORBIDDEN @ ${LISTENER}`);
  });
});

describe("an empty store path is refused, never rendered as a blank row", () => {
  /**
   * The two carriers are not equally strict, and this arm exists because of it.
   * `/activation/read`'s decoder requires a NON-EMPTY path (live-activation.ts:204-206),
   * so an empty one fails the whole frame - asserted below, so the asymmetry is measured
   * here rather than assumed. `/health/read`'s checks only the type (live-ops.ts:244), so
   * `""` decodes cleanly and really does reach the screen.
   */
  it("proves only /health/read can hand the screen an empty path", () => {
    expect(mapActivationAnswer(200, { ...ACTIVATION_BODY, store: { storePath: "" } }).status)
      .toBe("ERROR");
    expect(mapHealthAnswer(200, HEALTH_EMPTY_STORE_BODY).status).toBe("HEALTH");
  });

  it("falls through to the other carrier, then refuses with a code when neither states one", () => {
    const emptyOnHealth = decoded(mapHealthAnswer, HEALTH_EMPTY_STORE_BODY, "HEALTH");

    // /health/read states "" - the ACTIVATION carrier still has the real path, so the
    // row shows it rather than a blank.
    render(<ResourcesScreen reads={{ ...allRead(), health: emptyOnHealth }} />);
    expect(value("store.path")).toBe(STORE_PATH);
    cleanup();

    // Health states "" and activation refuses: neither carrier has a path, so the row
    // states a code rather than rendering an empty value.
    render(<ResourcesScreen reads={{
      ...allRead(), activation: activationRefused(), health: emptyOnHealth,
    }} />);
    expect(screen.queryByTestId("cr.resources.value.store.path")).toBeNull();
    expect(refusalText("store.path"))
      .toContain(`RESOURCES_STORE_PATH_EMPTY @ ${RESOURCES_LAYER}`);
  });
});
