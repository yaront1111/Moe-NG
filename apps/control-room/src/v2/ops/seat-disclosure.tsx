import type { JSX } from "react";

import type { ActivationReadOutcome } from "../../live/live-activation.js";
import { SEAT_FACT_UNMEASURED } from "../../live/live-sessions.js";
import type { SessionView, SessionsAgentProvider } from "../../live/live-sessions.js";
import { MIDDOT } from "../glyphs.js";
import { AgentProviderToggle } from "./agent-provider-toggle.js";
import type { AgentProviderPort } from "./agent-provider-port.js";
import { credentialWords, providerOverrideWords, seatFactWords } from "./seat-disclosure-words.js";

/**
 * WHICH PROVIDER IS RUNNING ON WHAT CREDENTIAL, above the seat list.
 *
 * Three facts a person needs before they can trust what they are looking at: which agent CLI
 * the project is configured to staff with (and whether the browser can still change that),
 * WHERE its credential comes from, and - per seat - which provider and CLI version the
 * wrapper actually measured at spawn. The last one can disagree with the first, and it is
 * shown separately rather than reconciled: a seat that started under claude keeps running
 * under claude after the setting moves, and hiding that would make a live fleet unreadable.
 *
 * NO CREDENTIAL VALUE IS RENDERED HERE. Every word about a credential comes from
 * `credentialWords`, which reads the closed grammar's OUTPUT only.
 */

export interface SeatDisclosureProps {
  readonly activation: ActivationReadOutcome | null;
  readonly agentProvider: SessionsAgentProvider;
  readonly offer: Readonly<Record<string, unknown>> | null;
  readonly port: AgentProviderPort | null;
  readonly sessions: readonly SessionView[];
  readonly onChosen?: (() => void) | undefined;
}

/** One seat's second-hand start facts, in the wrapper's words rather than this screen's. */
export function SeatStartFacts({ session }: { readonly session: SessionView }): JSX.Element {
  const words = seatFactWords(session.providerAtStart, session.agentVersionAtStart);
  return (
    <span
      className="cr2-approve-mono cr2-activity-target"
      data-testid={`cr.sessions.seat.start.${session.sessionId}`}
    >
      {`started under ${words.provider} ${MIDDOT} ${words.cliVersion}`}
    </span>
  );
}

export function SeatDisclosure({
  activation, agentProvider, offer, port, sessions, onChosen,
}: SeatDisclosureProps): JSX.Element {
  const credential = credentialWords(activation);
  // THREE filters, and every one of them removes a false warning a live board would show.
  // LIVE only: a seat that closed an hour ago under the old provider is history, not a
  // divergence. NOT the stated unknown: every paired browser and every seat opened before the
  // wrapper recorded starts carries "UNKNOWN", so without this the panel tells an operator
  // that seats are running under a provider called UNKNOWN. And not the configured one.
  const divergent = [...new Set(sessions
    .filter((session) => session.liveness === "LIVE")
    .map((session) => session.providerAtStart))]
    .filter((provider) => provider !== SEAT_FACT_UNMEASURED && provider !== agentProvider.configured);
  return (
    <div data-testid="cr.sessions.disclosure">
      <AgentProviderToggle
        agentProvider={agentProvider}
        offer={offer}
        onChosen={onChosen}
        port={port}
      />
      <p className="cr2-needs-note" data-testid="cr.sessions.provider.override">
        {providerOverrideWords(agentProvider)}
      </p>
      <p className="cr2-needs-note" data-testid="cr.sessions.credential">
        {credential.cli === null ? credential.said : `${credential.cli} ${MIDDOT} ${credential.said}`}
      </p>
      {credential.code === null ? null : (
        <p className="cr2-approve-mono" data-testid="cr.sessions.credential.code">{credential.code}</p>
      )}
      {divergent.length === 0 ? null : (
        <p className="cr2-needs-note" data-testid="cr.sessions.provider.divergent">
          {`Seats are running that started under ${divergent.join(", ")}. A seat keeps the provider it started with;`
            + ` the setting applies to the next one.`}
        </p>
      )}
    </div>
  );
}
