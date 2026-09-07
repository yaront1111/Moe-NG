import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { SessionsAgentProvider } from "../../live/live-sessions.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { KNOWN_PROVIDERS } from "./agent-provider-port.js";
import type { AgentProviderOutcome, AgentProviderPort, KnownProvider } from "./agent-provider-port.js";

/**
 * THE PROVIDER TOGGLE. One button per provider the daemon knows, in the daemon's own order.
 *
 * The choice is DURABLE and the daemon owns it, so this control never moves its own label on
 * a click: it reports the answer and waits for the next Seats read to say what is configured
 * now. That is the same rule the rest of the board follows - only the ledger moves a card -
 * and here it also keeps an accepted write and an IGNORED one visually distinguishable, which
 * is the whole point of the override disclosure beside it.
 */

export interface AgentProviderToggleProps {
  readonly agentProvider: SessionsAgentProvider;
  /** The daemon's offer for `project.set_agent_provider`, or null when it offered none. */
  readonly offer: Readonly<Record<string, unknown>> | null;
  readonly port: AgentProviderPort | null;
  readonly onChosen?: (() => void) | undefined;
}

/** What a person is told when the daemon has not offered the setting to this session. */
const NOT_OFFERED =
  "This browser session cannot change the provider. The daemon offers that setting only to a"
  + " paired operator, so pair this browser and read the seats again.";

export function AgentProviderToggle({
  agentProvider, offer, port, onChosen,
}: AgentProviderToggleProps): JSX.Element {
  const [busy, setBusy] = useState<KnownProvider | null>(null);
  const [report, setReport] = useState<AgentProviderOutcome | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const choose = async (provider: KnownProvider): Promise<void> => {
    if (port === null || offer === null || sending.current) return;
    sending.current = true;
    setBusy(provider);
    setReport(null);
    let result: AgentProviderOutcome;
    try {
      result = await port.submit(offer, provider);
    } catch {
      result = { code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_AGENT_PROVIDER", ok: false };
    }
    sending.current = false;
    if (!mounted.current) return;
    setBusy(null);
    setReport(result);
    if (result.ok) onChosen?.();
  };

  const disabled = port === null || offer === null || busy !== null;
  return (
    <div className="cr2-ops-card" data-testid="cr.sessions.provider">
      <p className="cr2-needs-note" data-testid="cr.sessions.provider.configured">
        {`Seats are staffed with ${agentProvider.configured} ${MIDDOT} choose which agent CLI runs the next seat.`}
      </p>
      <div data-testid="cr.sessions.provider.choices">
        {KNOWN_PROVIDERS.map((provider) => (
          <ActionButton
            ariaLabel={`Staff seats with ${provider}`}
            ariaPressed={agentProvider.configured === provider}
            disabled={disabled}
            key={provider}
            onClick={() => { void choose(provider); }}
            testId={`cr.sessions.provider.choose.${provider}`}
            variant={agentProvider.configured === provider ? "primary" : "secondary"}
          >
            {provider}
          </ActionButton>
        ))}
      </div>
      {offer === null && port !== null ? (
        <p className="cr2-needs-note" data-testid="cr.sessions.provider.unoffered">{NOT_OFFERED}</p>
      ) : null}
      {busy === null ? null : (
        <p role="status" data-testid="cr.sessions.provider.busy">{`Recording ${busy} as the provider for the next seat...`}</p>
      )}
      {report?.ok === true ? (
        <p role="status" data-testid="cr.sessions.provider.recorded">
          {"The daemon recorded the choice. Seats already running keep the provider they started under."}
        </p>
      ) : null}
      {report?.ok === false ? (
        <>
          <OutcomeNote
            code={report.code}
            layer={report.layer}
            said="The provider was not changed."
            testId="cr.sessions.provider.refusal"
          />
          {/* The refusing authority's OWN words, when it sent any. offer-wire carries this
              field deliberately and omits it when the daemon merely echoed its code, so a
              present detail always says something the code does not. */}
          {report.detail === undefined ? null : (
            <p className="cr2-approve-mono" data-testid="cr.sessions.provider.refusal.detail">{report.detail}</p>
          )}
        </>
      ) : null}
    </div>
  );
}
