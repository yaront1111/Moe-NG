import { describe, expect, it, vi } from "vitest";

import { createDeployPort, deployTargetAggregateId } from "./deploy-port.js";
import type { OfferWire } from "../approvals/offer-wire.js";

/**
 * THE PORT, NOT THE CARD. Every arm here renders nothing and asserts what reached the WIRE,
 * because a control can be labelled perfectly while dispatching the wrong thing -- and for
 * `deployment.set_target` the wrong thing is a target bound to an environment the operator
 * did not choose, on a host nothing downstream can tell was a slip.
 *
 * The fake wire is the `goal-deployments.test.tsx:109` / `goal-publish.test.tsx:61` shape, kept
 * so the REAL `createDeployPort` runs: `spendOffer` takes `affordance` and `payload` (both
 * `Readonly<Record<string, unknown>>`) then `correlationPrefix` and `layer` (both string), as
 * four positional arguments. Either PAIR can be transposed and still typecheck, so without a
 * wire that records what was built, a swapped argument ships.
 */

const PROJECT = "proj-1";
const SET_TARGET = "deployment.set_target";

/** The offer the daemon serves for ONE environment, at the aggregate its setter fences. */
function offerFor(environment: string, expectedVersion: number): Record<string, unknown> {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-set-${environment}`,
    commandKind: SET_TARGET, expectedVersion,
    inputSchemaVersion: "moe-bootstrap-command/1",
    // BUILT WITH THE PRODUCTION KEY FUNCTION, never a hand-spelled literal: if the producer's
    // key shape moves, these arms must break rather than keep passing against a frame the
    // daemon has stopped serving.
    targetAggregateId: deployTargetAggregateId(PROJECT, environment),
  });
}

interface Built {
  readonly affordance: unknown;
  readonly payload: Readonly<Record<string, unknown>>;
}

function wireWith(response: unknown = { ok: true }): {
  readonly built: Built[]; readonly sent: number[]; readonly wire: OfferWire;
} {
  const built: Built[] = [];
  const sent: number[] = [];
  const wire = {
    client: { commands: { [SET_TARGET]: (
      affordance: unknown, input: Record<string, unknown>,
    ) => {
      built.push({ affordance, payload: input["payload"] as Readonly<Record<string, unknown>> });
      return { envelope: { commandId: "cmd-set", payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-1",
    transport: { sendCommand: vi.fn(async () => {
      sent.push(1);
      return { delivered: true as const, response, status: 200 };
    }) },
  } as unknown as OfferWire;
  return { built, sent, wire };
}

const FIELDS = Object.freeze({ network: "moe-preview", sshTarget: null, url: null });

describe("bindTarget spends the daemon's own offer, down the one wire (A)", () => {
  it("passes THE AFFORDANCE THE SURFACE SERVED, by identity, not a constructed one", async () => {
    const { built, wire } = wireWith();
    const offer = offerFor("preview", 0);

    const outcome = await createDeployPort(wire).bindTarget(offer, PROJECT, "preview", FIELDS);

    expect(outcome.ok ? "ok" : `${outcome.code}@${outcome.layer}`).toBe("ok");
    expect(built).toHaveLength(1);
    // toBe, not toEqual: an equal-looking object the port built ITSELF would be a second
    // decision path wearing the shape of the first. Only the served object can pass this.
    expect(built[0]?.affordance).toBe(offer);
  });

  it("REFUSES a mismatched offer at a stable code, before anything reaches the transport", async () => {
    const { built, sent, wire } = wireWith();
    // The operator is on the `production` row; the browser is holding `preview`'s offer.
    const outcome = await createDeployPort(wire)
      .bindTarget(offerFor("preview", 0), PROJECT, "production", FIELDS);

    // THE REASON CODE AND THE LAYER, not merely "did not succeed": this refusal is the browser's
    // own, and an arm that accepted any failure would still pass if the daemon refused instead.
    expect(outcome.ok ? "ok" : `${outcome.code}@${outcome.layer}`)
      .toBe("DEPLOY_TARGET_OFFER_MISMATCH@CONTROL_ROOM_DEPLOY");
    // Nothing was built and nothing was sent. The daemon cannot catch this pair itself: it keys
    // its write off the PAYLOAD and its fence off the OFFER, so a mismatch binds the payload's
    // environment against another environment's version rather than refusing.
    expect(built).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("the payload is the daemon's exact roster (B), and it agrees with the offer (M)", () => {
  it("sends EXACTLY environment, network, sshTarget and url -- no fifth key, none missing", async () => {
    const { built, wire } = wireWith();

    await createDeployPort(wire).bindTarget(offerFor("preview", 0), PROJECT, "preview", {
      network: "moe-preview", sshTarget: "deploy@host.example", url: "https://preview.example",
    });

    // SET EQUALITY on the keys, against the roster daemon-command-payload-keys.ts:181 declares.
    // The decoder is exact-arity: a fifth key is refused at the edge and a missing one is read
    // as malformed rather than as a default, so a subset check would not be testing the rule.
    expect(new Set(Object.keys(built[0]?.payload ?? {})))
      .toEqual(new Set(["environment", "network", "sshTarget", "url"]));
  });

  it("keys the payload's environment to the SPENT OFFER, for each of two different rows", () => {
    // (M) These are the two values whose disagreement the per-environment axis exists to make
    // impossible. Asserted EQUAL to each other, not each separately correct: checking them
    // separately against a literal would still pass if the control paired the wrong two.
    return Promise.all(["preview", "production"].map(async (environment, index) => {
      const { built, wire } = wireWith();
      const offer = offerFor(environment, index * 2);

      await createDeployPort(wire).bindTarget(offer, PROJECT, environment, FIELDS);

      const spent = String(built[0]?.affordance !== undefined
        ? (built[0].affordance as Record<string, unknown>)["targetAggregateId"] : "");
      expect(spent).toBe(deployTargetAggregateId(PROJECT, String(built[0]?.payload["environment"])));
      // And the fence travels with it: production's own version, never preview's.
      expect((built[0]?.affordance as Record<string, unknown>)["expectedVersion"])
        .toBe(index * 2);
    })).then(() => undefined);
  });
});

describe("a blank ssh destination means LOCAL DOCKER, not a missing field (C)", () => {
  it("sends null -- not an empty string, and not an omitted key", async () => {
    const { built, wire } = wireWith();

    const outcome = await createDeployPort(wire)
      .bindTarget(offerFor("preview", 0), PROJECT, "preview",
        { network: "moe-preview", sshTarget: null, url: null });

    // THE LOCAL PATH IS REACHABLE: this is an ACCEPTED dispatch, not a refusal.
    expect(outcome.ok).toBe(true);
    const payload = built[0]?.payload ?? {};
    // The key is PRESENT and its value is null. An omitted key arrives as malformed under an
    // exact-arity decoder, and "" is a destination the daemon would try to use and refuse --
    // so a control that used either for "blank" would make local deploys unreachable.
    expect("sshTarget" in payload).toBe(true);
    expect(payload["sshTarget"]).toBeNull();
    expect(payload["sshTarget"]).not.toBe("");
    expect(payload["url"]).toBeNull();
  });
});

describe("the operator's input reaches the daemon UNMODIFIED (D)", () => {
  /**
   * THIS ARM LOOKS BACKWARDS ON PURPOSE. It asserts the browser SENDS a url carrying userinfo,
   * which is the exact value the daemon then refuses. That is the design: `admitDeployUrl`
   * refuses `https://user:secret@host` outright rather than stripping it, because the url is
   * copied onto every deploy receipt and stripping would silently change where the operator
   * believes the environment answers. A client that "helpfully" cleaned it would submit a
   * target nobody typed and report success for it.
   */
  it("dispatches a userinfo-bearing url AS TYPED, leaving the refusal to the daemon", async () => {
    const { built, wire } = wireWith();
    const typed = "https://deployer:hunter2@preview.example.test/app";

    await createDeployPort(wire).bindTarget(offerFor("preview", 0), PROJECT, "preview",
      { network: "moe-preview", sshTarget: null, url: typed });

    expect(built[0]?.payload["url"]).toBe(typed);
  });

  it("does not trim, lowercase or otherwise repair network and sshTarget", async () => {
    const { built, wire } = wireWith();
    // Values the daemon WILL refuse -- leading space, uppercase, a shell metacharacter. The
    // port's job is to carry them, so the refusal names what the operator actually typed.
    const network = "  Moe-Preview$(id)  ";
    const sshTarget = "deploy@HOST.example; rm -rf /";

    await createDeployPort(wire)
      .bindTarget(offerFor("preview", 0), PROJECT, "preview", { network, sshTarget, url: null });

    expect(built[0]?.payload["network"]).toBe(network);
    expect(built[0]?.payload["sshTarget"]).toBe(sshTarget);
  });
});

describe("no credential ever reaches the wire (E, epic rail 3)", () => {
  const TOKEN_SHAPES = [/password/iu, /passwd/iu, /secret/iu, /\btoken\b/iu, /BEGIN [A-Z ]*PRIVATE KEY/u];

  it("carries no token shape in the dispatched payload, with a positive control", async () => {
    const { built, wire } = wireWith();

    await createDeployPort(wire).bindTarget(offerFor("preview", 0), PROJECT, "preview", {
      network: "moe-preview", sshTarget: "deploy@host.example", url: "https://preview.example",
    });

    const onTheWire = JSON.stringify(built[0]?.payload);
    for (const shape of TOKEN_SHAPES) expect(onTheWire).not.toMatch(shape);

    // POSITIVE CONTROL, so the loop above cannot be passing because the shapes never match
    // anything. Every shape must fire against a literal that really does carry a secret.
    const planted = JSON.stringify({
      environment: "preview", network: "n",
      sshTarget: "deploy@host.example", url: "https://user:password@h/?token=abc",
      note: "secret passwd -----BEGIN RSA PRIVATE KEY-----",
    });
    for (const shape of TOKEN_SHAPES) expect(planted).toMatch(shape);
  });

  it("has NO field on the port that could carry an authenticator", () => {
    // The type is the guard here: `DeployTargetFields` is exactly three keys. A password field
    // could not be dispatched without widening it, and widening it breaks this arm.
    const fieldKeys = Object.keys(FIELDS);
    expect(new Set(fieldKeys)).toEqual(new Set(["network", "sshTarget", "url"]));
    expect(fieldKeys).toHaveLength(3);
  });
});
