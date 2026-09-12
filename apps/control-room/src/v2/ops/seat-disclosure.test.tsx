import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ActivationReadOutcome, ActivationReceiptView } from "../../live/live-activation.js";
import type { SessionView, SessionsAgentProvider } from "../../live/live-sessions.js";
import { SeatDisclosure, SeatStartFacts } from "./seat-disclosure.js";
import { credentialWords, providerOverrideWords, seatFactWords } from "./seat-disclosure-words.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/**
 * A value that is UNMISTAKABLE in a screenshot. The whole point of the arms below is that
 * this string never reaches an operator's screen, so it is written to look exactly like the
 * thing an operator would have to rotate if it did.
 */
const CREDENTIAL_VALUE = "sk-ant-oat01-7Qb3xZ9fLm2KpVtRw8YsNc4Hj6Ee1Ua0Bd5Gi7Ko9Pq";

const CONFIGURED: SessionsAgentProvider = { configured: "claude", envOverride: false };

const SEAT: SessionView = {
  agentVersionAtStart: "2.1.263 (Claude Code)", capabilities: ["work.write"],
  expiresAt: "2026-09-03T11:00:00.000Z", holding: [], liveness: "LIVE",
  principalId: "sess-wrap-abc", providerAtStart: "claude", sessionId: "sess-wrap-abc",
  status: "OPEN",
};

/**
 * The provider row AS THE DAEMON SERVES IT: `ref` is the committed `provider.probe` envelope
 * ref and the credential presence ref rides in `reason` (activation-receipts-measure.ts
 * `measureProvider` -> activation-read.ts `receiptRow`). This helper once carried the two
 * swapped, and every arm below was green against a wire the daemon never serves.
 */
const receipt = (over: Partial<ActivationReceiptView>): ActivationReceiptView => ({
  code: null, hash: null, layer: null, measured: true, member: "provider",
  reason: "credential/claude/env:ANTHROPIC_AUTH_TOKEN", ref: "provider-profile-1", ...over,
});

const activationWith = (provider: ActivationReceiptView): ActivationReadOutcome => ({
  blocking: [], distribution: null, measuredAt: "2026-09-03T10:00:00.000Z",
  members: [provider], provider: null, repository: null, schemaVersion: "1",
  signing: { measured: false, member: "signing", reason: "unsigned", ref: "none", trustBoundary: false },
  status: "ACTIVATION", store: null,
});

const renderDisclosure = (
  activation: ActivationReadOutcome | null, agentProvider = CONFIGURED, sessions = [SEAT],
): void => {
  render(
    <SeatDisclosure
      activation={activation}
      agentProvider={agentProvider}
      offer={null}
      port={null}
      sessions={sessions}
    />,
  );
};

const renderedText = (): string => document.body.textContent ?? "";

/**
 * DoD-2. THE ONE PROPERTY IN THIS ROW THAT CANNOT BE WALKED BACK.
 *
 * A credential in an operator's screenshot cannot be recalled: it is pasted into a bug
 * report, indexed, and the only remedy left is rotating the credential. These arms exist so
 * that the day someone echoes `receipt.reason` because the grammar "was not showing
 * anything useful", the suite says no.
 */
describe("no credential VALUE is ever rendered", () => {
  it("renders the SOURCE only when a credential-shaped value rides in on the reason", () => {
    // `reason` is the ONE field the grammar reads, so it is the field a value would arrive on.
    renderDisclosure(activationWith(receipt({ reason: `credential/claude/env:${CREDENTIAL_VALUE}` })));
    // THE GREP: the value appears nowhere in the rendered output, at all.
    expect(renderedText()).not.toContain(CREDENTIAL_VALUE);
    // ASSERTED POSITIVELY TOO, so the arm cannot pass merely because nothing rendered: the
    // refusal code stands where the source would have gone.
    expect(screen.getByTestId("cr.sessions.credential.code").textContent)
      .toBe("RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED");
    expect(screen.getByTestId("cr.sessions.credential").textContent)
      .toBe("The credential source was not stated in a form this screen can show.");
  });

  it("renders the SOURCE only when a value rides in on the receipt's REF", () => {
    // A measured receipt's other fields are not read at all, which is what makes the
    // property structural: there is no field left through which a value could arrive.
    renderDisclosure(activationWith(receipt({ ref: `provider-profile-${CREDENTIAL_VALUE}` })));
    expect(renderedText()).not.toContain(CREDENTIAL_VALUE);
    expect(screen.getByTestId("cr.sessions.credential").textContent)
      .toBe("claude \u00b7 Signed in through the ANTHROPIC_AUTH_TOKEN environment variable.");
  });

  it("names the variable that IS set, never its value, and says which CLI", () => {
    renderDisclosure(activationWith(receipt({ reason: "credential/codex/login-file" })));
    expect(screen.getByTestId("cr.sessions.credential").textContent)
      .toBe("codex \u00b7 Signed in through a signed-in credential file on this host.");
    expect(screen.queryByTestId("cr.sessions.credential.code")).toBeNull();
  });
});

/** DoD-3. The operator's whole fix is the variable NAMES, so they are repeated verbatim. */
describe("a missing credential names the variables, not a generic phrase", () => {
  const MISSING = "MOE_UP_ENV_MISSING: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN,"
    + " ANTHROPIC_API_KEY (set one, or sign in once: run `claude` and `/login`;"
    + " `claude setup-token` also works); no sign-in at C:\\Users\\you\\.claude\\.credentials.json";

  it("repeats the launcher's roster VERBATIM", () => {
    renderDisclosure(activationWith(receipt({
      code: "ACTIVATION_PROVIDER_UNMEASURED", layer: "ACTIVATION_MEASURE",
      measured: false, reason: MISSING, ref: null,
    })));
    // Asserted on a NAME, not on the sentence: a paraphrase that happened to keep the
    // sentence shape would still leave an operator with nothing to set.
    const said = screen.getByTestId("cr.sessions.credential").textContent ?? "";
    expect(said).toBe(MISSING);
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(said).toContain(name);
    }
    expect(screen.getByTestId("cr.sessions.credential.code").textContent)
      .toBe("ACTIVATION_PROVIDER_UNMEASURED");
  });

  it("says the read failed rather than inventing a source when activation refuses", () => {
    renderDisclosure({ code: "ACTIVATION_READ_CAPABILITY_DENIED", layer: "ACTIVATION_READ", status: "REFUSED" });
    expect(screen.getByTestId("cr.sessions.credential").textContent)
      .toBe("The credential source could not be read.");
    expect(screen.getByTestId("cr.sessions.credential.code").textContent)
      .toBe("ACTIVATION_READ_CAPABILITY_DENIED");
  });

  it("states the absence when the daemon published no provider receipt at all", () => {
    renderDisclosure({
      blocking: [], distribution: null, measuredAt: "2026-09-03T10:00:00.000Z", members: [],
      provider: null, repository: null, schemaVersion: "1",
      signing: { measured: false, member: "signing", reason: "unsigned", ref: "none", trustBoundary: false },
      status: "ACTIVATION", store: null,
    });
    expect(screen.getByTestId("cr.sessions.credential.code").textContent)
      .toBe("RESOURCES_CREDENTIAL_SOURCE_UNRECOGNISED");
  });
});

/** DoD-4. A browser choice that is being IGNORED must be legible, not mysterious. */
describe("an env override is named, not silently applied", () => {
  it("says the effective provider AND that a launcher override is in force", () => {
    renderDisclosure(null, { configured: "codex", envOverride: true });
    const said = screen.getByTestId("cr.sessions.provider.override").textContent ?? "";
    // BOTH halves: the effective provider, and the NAME of what is overriding the choice.
    expect(said).toContain("codex");
    expect(said).toContain("MOE_AGENT_COMMAND");
    expect(said).toContain("whatever this browser chooses");
  });

  it("says the browser choice is what is in force when nothing overrides it", () => {
    renderDisclosure(null, { configured: "codex", envOverride: false });
    const said = screen.getByTestId("cr.sessions.provider.override").textContent ?? "";
    expect(said).toContain("codex");
    expect(said).not.toContain("MOE_AGENT_COMMAND");
  });

  it("is a pure function of the daemon's own flag", () => {
    expect(providerOverrideWords({ configured: "claude", envOverride: true }))
      .toContain("MOE_AGENT_COMMAND is set in the daemon environment");
  });
});

/** DoD-1. Per-seat provider and CLI version, as second-hand facts rather than readings. */
describe("each seat states the provider and CLI version measured at its start", () => {
  it("renders both from the daemon's per-seat members", () => {
    render(<SeatStartFacts session={SEAT} />);
    expect(screen.getByTestId("cr.sessions.seat.start.sess-wrap-abc").textContent)
      .toBe("started under claude \u00b7 2.1.263 (Claude Code)");
  });

  it("says nobody measured it rather than printing a bare UNKNOWN", () => {
    render(<SeatStartFacts session={{ ...SEAT, agentVersionAtStart: "UNKNOWN", providerAtStart: "UNKNOWN", sessionId: "sess-op-1" }} />);
    const said = screen.getByTestId("cr.sessions.seat.start.sess-op-1").textContent ?? "";
    // A bare "UNKNOWN" reads like a provider actually named UNKNOWN.
    expect(said).toBe("started under no provider was recorded when this seat started"
      + " \u00b7 no CLI version was recorded when this seat started");
  });

  it("maps the stated unknown in the pure layer too", () => {
    expect(seatFactWords("codex", "codex-cli 0.153.4"))
      .toEqual({ cliVersion: "codex-cli 0.153.4", provider: "codex" });
  });

  it("warns only when a RUNNING seat disagrees with the setting", () => {
    renderDisclosure(null, { configured: "codex", envOverride: false });
    // The seat started under claude; the setting now says codex.
    expect(screen.getByTestId("cr.sessions.provider.divergent").textContent).toContain("claude");
    cleanup();
    renderDisclosure(null, CONFIGURED);
    // A standing warning is one nobody reads, so agreement says nothing.
    expect(screen.queryByTestId("cr.sessions.provider.divergent")).toBeNull();
  });

  it("never reports the stated unknown as a divergent provider", () => {
    // EVERY paired browser carries "UNKNOWN" here, and so does every seat opened before the
    // wrapper recorded starts - so on a live board the unfiltered version of this line tells
    // an operator that seats are running under a provider named UNKNOWN. Found by reading
    // this diff as an attacker, not by a fixture: the fixture had one seat.
    renderDisclosure(null, { configured: "codex", envOverride: false }, [
      { ...SEAT, providerAtStart: "UNKNOWN", sessionId: "browser-1" },
    ]);
    expect(screen.queryByTestId("cr.sessions.provider.divergent")).toBeNull();
  });

  it("ignores seats that are no longer live", () => {
    // A seat that closed under the old provider is history, not a divergence to act on.
    renderDisclosure(null, { configured: "codex", envOverride: false }, [
      { ...SEAT, liveness: "CLOSED", providerAtStart: "claude", sessionId: "sess-old" },
    ]);
    expect(screen.queryByTestId("cr.sessions.provider.divergent")).toBeNull();
  });
});

describe("the pure credential layer is reachable without a renderer", () => {
  it("is pending, not refused, before the first activation read answers", () => {
    expect(credentialWords(null)).toEqual({
      code: null, cli: null, said: "Reading where the credential comes from...",
    });
  });
});
