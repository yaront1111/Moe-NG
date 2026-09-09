import { useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { writeFailedSaid } from "../outcome-words.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { deployTargetAggregateId } from "./deploy-port.js";
import type { DeployPort } from "./deploy-port.js";

/**
 * BINDING A DEPLOY TARGET, from the environment row that needs one.
 *
 * THE ENVIRONMENT IS NOT A FIELD ON THIS FORM, and that is the safety design rather than a
 * convenience. The daemon serves ONE `deployment.set_target` offer PER ENVIRONMENT
 * (affordance-deploy-target-offers.ts), each targeted at
 * `deploy-target:<projectId>:<environment>` and fenced at THAT aggregate's version. This
 * control renders on one environment row and spends that row's own offer, so the payload's
 * `environment` and the aggregate the write fences are the SAME FACT. A typed environment
 * field would let the two disagree, and a target bound to the wrong environment silently
 * redirects a later deploy to another host with nothing downstream able to tell it was a
 * slip -- the daemon stores exactly what it was handed.
 *
 * THE OFFER IS FOUND BY CONSTRUCTING ITS KEY, NEVER BY PARSING ONE. The producer states the
 * contract in as many words: the card constructs `deployTargetAggregateId(projectId,
 * environment)` and must not read the environment back out of an id. No offer for this row
 * means NO CONTROL for this row -- nothing is ever minted here.
 *
 * NOTHING THE OPERATOR TYPES IS REPAIRED. Not trimmed, not lowercased, and above all a url
 * carrying `user:password@` is NOT cleaned before sending. `admitDeployUrl` refuses such a
 * url outright rather than stripping it, deliberately, because the url is copied onto every
 * deploy receipt: stripping would silently change where the operator believes the
 * environment answers. So this form SURFACES the daemon refusal instead of pre-judging or
 * repairing the value, and it holds no copy of the daemon admission grammar -- a second copy
 * in the browser is a second authority, and it would drift.
 *
 * THERE IS NO CREDENTIAL FIELD. No password, no token, no key, no passphrase. `sshTarget` is
 * a DESTINATION (`[user@]host[:port]`), not an authenticator; the daemon reaches it with the
 * host's own ssh configuration. Nothing here accepts, stores or renders a secret.
 */

export const BIND_TESTID_ROOT = "cr.deploy.bind" as const;

export function bindTestId(environment: string, part: string): string {
  return `${BIND_TESTID_ROOT}.${environment}.${part}`;
}

/**
 * The refusals this control can show, as operator words.
 *
 * ONE DAEMON CODE COVERS ALL FOUR ADMISSION FAILURES, and pretending otherwise would be
 * inventing authority: `setDeployTarget` answers `DEPLOY_TARGET_INVALID` @ `DAEMON_INGRESS`
 * whenever `admitDeployTargetPayload` returns null, whether it was the url carrying userinfo
 * or a network or ssh destination carrying whitespace, a shell metacharacter, a newline or a
 * NUL. So the words name every one of those causes rather than guessing which fired, and the
 * code travels with them so the operator can quote it.
 */
const BIND_REFUSAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  DEPLOY_TARGET_INVALID:
    "The daemon refused this target and bound nothing. A url cannot carry a user and password"
    + " inside it, and a network or ssh destination cannot contain spaces, shell characters, a"
    + " newline or a NUL. It refuses rather than cleaning the value up, so that what gets bound"
    + " is only ever what you typed.",
  DEPLOY_TARGET_OFFER_MISMATCH:
    "This browser was holding an offer for a different environment, so nothing was sent."
    + " Reload the screen and try again.",
});

export function bindRefusalWords(code: string): string {
  return BIND_REFUSAL_WORDS[code] ?? code;
}

/** The daemon offer that binds THIS environment, or null when the surface served none. */
export function setTargetOffer(
  frame: SurfaceFrame | null, projectId: string | null | undefined, environment: string,
): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  if (typeof projectId !== "string" || projectId === "") return null;
  const wanted = deployTargetAggregateId(projectId, environment);
  return frame.offers.find((row) =>
    row["commandKind"] === "deployment.set_target" && row["targetAggregateId"] === wanted) ?? null;
}

export interface DeployTargetFormProps {
  readonly environment: string;
  readonly frame: SurfaceFrame | null;
  readonly port: DeployPort | null;
  readonly projectId: string | null | undefined;
}

export function DeployTargetForm({
  environment, frame, port, projectId,
}: DeployTargetFormProps): JSX.Element | null {
  const [network, setNetwork] = useState("");
  const [sshTarget, setSshTarget] = useState("");
  const [url, setUrl] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<OfferOutcome | null>(null);
  const offer = setTargetOffer(frame, projectId, environment);
  // No offer means the daemon is not offering this decision for this environment: the control
  // is not a thing on this row, rather than a button that cannot work.
  if (offer === null || typeof projectId !== "string") return null;
  const ready = port !== null && !busy && network !== "";
  const send = (): void => {
    if (port === null) return;
    setArmed(false);
    setBusy(true);
    setAnswer(null);
    // EXACTLY AS TYPED. The only transformation is blank -> null, which is a MEANING and not a
    // repair: `sshTarget` null is a LOCAL docker daemon and `url` null is an environment with
    // no public url, while "" is a destination the daemon would try to use and refuse.
    void port.bindTarget(offer, projectId, environment, {
      network,
      sshTarget: sshTarget === "" ? null : sshTarget,
      url: url === "" ? null : url,
    }).then((outcome) => {
      setAnswer(outcome);
      setBusy(false);
    }, () => {
      setAnswer({ code: "DEPLOY_TARGET_DISPATCH_FAILED", layer: "CONTROL_ROOM_DEPLOY", ok: false });
      setBusy(false);
    });
  };
  const sshLabel = `SSH destination for ${environment} (optional). Leave this empty to deploy`
    + " with the docker daemon on this host.";
  return (
    <div className="cr2-ops-panel" data-testid={bindTestId(environment, "root")}>
      <p className="cr2-approve-step-body" data-testid={bindTestId(environment, "heading")}>
        {`Bind a deploy target for ${environment}`}
      </p>
      <label className="cr2-slot-kicker" htmlFor={bindTestId(environment, "network")}>
        {`Docker network for ${environment}`}
      </label>
      <input
        className="cr2-input"
        data-testid={bindTestId(environment, "network")}
        id={bindTestId(environment, "network")}
        onChange={(event): void => { setNetwork(event.target.value); setArmed(false); }}
        value={network}
      />
      <label className="cr2-slot-kicker" htmlFor={bindTestId(environment, "ssh")}>
        {sshLabel}
      </label>
      <input
        className="cr2-input"
        data-testid={bindTestId(environment, "ssh")}
        id={bindTestId(environment, "ssh")}
        onChange={(event): void => { setSshTarget(event.target.value); setArmed(false); }}
        value={sshTarget}
      />
      <label className="cr2-slot-kicker" htmlFor={bindTestId(environment, "url")}>
        {`Public url for ${environment} (optional)`}
      </label>
      <input
        className="cr2-input"
        data-testid={bindTestId(environment, "url")}
        id={bindTestId(environment, "url")}
        onChange={(event): void => { setUrl(event.target.value); setArmed(false); }}
        value={url}
      />
      {!armed ? null : (
        // THE CONFIRM NAMES THE ENVIRONMENT IN ITS OWN SENTENCE, not only inside the button,
        // and states what an empty ssh destination means, because this is the moment the
        // operator decides and the last one at which a wrong environment can still be caught.
        <p className="cr2-approve-mono" data-testid={bindTestId(environment, "confirm")}>
          {`This binds the ${environment} environment to network ${network}`
            + `${sshTarget === "" ? " on the docker daemon of this host" : ` over ssh to ${sshTarget}`}`
            + `${url === "" ? " with no public url" : `, published at ${url}`}`
            + `. Only ${environment} changes.`}
        </p>
      )}
      <ActionButton
        ariaLabel={`Bind a deploy target for the ${environment} environment`}
        disabled={!ready}
        onClick={(): void => { if (!armed) { setArmed(true); return; } send(); }}
        testId={bindTestId(environment, "button")}
      >
        {busy ? "Binding..."
          : armed ? `Confirm: bind ${environment} to ${network}`
            : `Bind a target for ${environment}`}
      </ActionButton>
      {armed && !busy ? (
        <ActionButton
          onClick={(): void => setArmed(false)}
          testId={bindTestId(environment, "cancel")}
          variant="secondary"
        >
          {`Do not bind ${environment}`}
        </ActionButton>
      ) : null}
      {answer === null ? null : answer.ok ? (
        <p aria-live="polite" className="cr2-needs-note" data-testid={bindTestId(environment, "answer")} role="status">
          {`Bound. ${environment} deploys to network ${network} from now on.`}
        </p>
      ) : (
        <OutcomeNote
          code={answer.code}
          layer={answer.layer}
          // THE ENVIRONMENT IS NAMED ON THE REFUSAL TOO: one screen carries a row per
          // environment, and an operator reading "that did not go through" beside three of
          // them cannot tell which binding failed.
          said={`${writeFailedSaid()} (${environment}) ${bindRefusalWords(answer.code)}`}
          testId={bindTestId(environment, "answer")}
        />
      )}
    </div>
  );
}
