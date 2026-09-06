import { useCallback, useRef, useState } from "react";
import type { JSX } from "react";

import { readActivation } from "../../live/live-activation.js";
import type {
  ActivationMember, ActivationProviderView, ActivationReadOutcome, ActivationReceiptView,
  ActivationSigningView,
} from "../../live/live-activation.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { WORK_KIND_LABELS } from "../goals/work-labels.js";
import {
  createActivationPort, driveActivationChain, readSurfaceOnce,
} from "./activation-port.js";
import type { ActivationChainKind, ActivationPort, ActivationStep } from "./activation-port.js";
import { useOpsRead } from "./live-ops.js";

/**
 * ACTIVATE THE PROJECT: the card an operator meets on Goals when New goal is refused because
 * nothing is activated yet. It shows the daemon's six receipts as measured or missing WITH
 * ITS OWN REASON, and one button drives register -> bind -> probe -> activate.
 *
 * Every string below that describes a receipt or a refusal is the daemon's, rendered as TEXT
 * and never as markup: `reason` may be long and may contain angle brackets, and a card that
 * prettified a refusal would hide which authority answered. Signing is rendered on its own
 * terms — not a trust boundary in this release — and is never counted as a measured receipt.
 */

const POLL_MS = 5_000;

/** Plain words for the six the daemon measures. The receipt's `reason` stays the daemon's. */
const MEMBER_WORDS: Readonly<Record<ActivationMember, string>> = Object.freeze({
  backup: "Store backup",
  distribution: "Distribution manifest",
  policy: "Installed policy",
  provider: "Model provider probe",
  repository: "Repository HEAD",
  store: "Store driver",
});

const ACTIVATION_FAILURE: ActivationReadOutcome = Object.freeze({
  code: "ACTIVATION_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const,
});

/** What the card knows about driving: the handler (null with no wire), whether one runs, each answer. */
export interface ActivationChainState {
  readonly busy: boolean;
  readonly onActivate: (() => void) | null;
  readonly steps: readonly ActivationStep[];
}

const kindWords = (kind: string): string => WORK_KIND_LABELS[kind]?.label ?? kind;

/**
 * The provider CLI version the DAEMON read, rendered beside the member it belongs to and
 * NOWHERE ELSE: this line is the operator's only sight of that reading, and a card that
 * showed it while the provider receipt was missing would be asserting a measurement that
 * did not stand. `version` is printed verbatim, `UNKNOWN` included — the daemon says that
 * when the CLI answered something it could not read, and softening it here would put the
 * browser back to describing a reading nobody took.
 */
function ReceiptRow({ reading, receipt }: {
  readonly reading?: ActivationProviderView | null | undefined;
  readonly receipt: ActivationReceiptView;
}): JSX.Element {
  return (
    <li
      className="cr2-coverage-section"
      data-measured={receipt.measured ? "true" : "false"}
      data-testid={`cr.activate.receipt.${receipt.member}`}
    >
      <span className="cr2-approve-step-body">
        {`${MEMBER_WORDS[receipt.member]} ${MIDDOT} ${receipt.measured ? "measured" : "missing"}`}
      </span>
      <span className="cr2-needs-detail" data-testid={`cr.activate.reason.${receipt.member}`}>
        {receipt.reason}
      </span>
      {reading === undefined || reading === null ? null : (
        <span className="cr2-approve-mono" data-testid="cr.activate.version">
          {`${reading.command} --version ${MIDDOT} ${reading.version}`}
        </span>
      )}
      {receipt.measured ? null : (
        <span className="cr2-approve-mono" data-testid={`cr.activate.code.${receipt.member}`}>
          {`${receipt.code ?? ""} @ ${receipt.layer ?? ""}`}
        </span>
      )}
    </li>
  );
}

/**
 * Signing sits OUTSIDE the receipt list, with its own testid and `data-measured="false"`, so
 * neither a reader nor a test can take it for one of the six.
 */
function SigningRow({ signing }: { readonly signing: ActivationSigningView }): JSX.Element {
  return (
    <p
      className="cr2-needs-note"
      data-measured="false"
      data-testid="cr.activate.signing"
      data-trust-boundary="false"
    >
      {`Signing ${MIDDOT} not a trust boundary ${MIDDOT} ${signing.reason}`}
    </p>
  );
}

function StepRow({ step }: { readonly step: ActivationStep }): JSX.Element {
  const done = step.state === "ALREADY_COMMITTED";
  const ok = done || step.outcome.ok;
  return (
    <li
      className="cr2-coverage-section"
      data-ok={ok ? "true" : "false"}
      data-testid={`cr.activate.step.${step.kind}`}
    >
      <span className="cr2-approve-step-body">
        {`${kindWords(step.kind)} ${MIDDOT} ${done ? "already done" : ok ? "accepted" : "refused"}`}
      </span>
      {done || step.outcome.ok ? null : (
        <span className="cr2-approve-mono" data-testid={`cr.activate.refusal.${step.kind}`}>
          {`${step.outcome.code} @ ${step.outcome.layer}`}
        </span>
      )}
    </li>
  );
}

export function ActivateScreen({ chain, outcome }: {
  readonly chain?: ActivationChainState | undefined;
  readonly outcome: ActivationReadOutcome | null;
}): JSX.Element {
  if (outcome === null) {
    return (
      <section className="cr2-ops-card" data-testid="cr.activate.root">
        <p className="cr2-slot-kicker" data-testid="cr.activate.loading">Reading the activation receipts...</p>
      </section>
    );
  }
  if (outcome.status !== "ACTIVATION") {
    return (
      <section className="cr2-ops-card" data-testid="cr.activate.root">
        <OutcomeNote
          code={outcome.code}
          layer={outcome.layer}
          said="The daemon did not state its activation receipts."
          testId="cr.activate.refusal"
        />
      </section>
    );
  }
  const measured = outcome.members.filter((row) => row.measured).length;
  return (
    <section className="cr2-ops-card cr2-policy-standard" data-testid="cr.activate.root">
      <p className="cr2-slot-kicker" data-testid="cr.activate.count">
        {`Activate the project ${MIDDOT} ${String(measured)} of ${String(outcome.members.length)} receipts measured`}
      </p>
      <ul className="cr2-approve-obligations" data-testid="cr.activate.receipts">
        {outcome.members.map((receipt) => (
          <ReceiptRow
            key={receipt.member}
            reading={receipt.member === "provider" ? outcome.provider : undefined}
            receipt={receipt}
          />
        ))}
      </ul>
      <SigningRow signing={outcome.signing} />
      {chain === undefined || chain.onActivate === null ? (
        <p className="cr2-needs-note" data-testid="cr.activate.nowire">
          Pair a session with project.admin to activate from here.
        </p>
      ) : (
        <ActionButton disabled={chain.busy} onClick={chain.onActivate} testId="cr.activate.button">
          {chain.busy ? "Activating..." : "Activate the project"}
        </ActionButton>
      )}
      {chain === undefined || chain.steps.length === 0 ? null : (
        <ol className="cr2-approve-obligations cr2-policy-steps" data-testid="cr.activate.steps">
          {chain.steps.map((step) => <StepRow key={step.kind} step={step} />)}
        </ol>
      )}
    </section>
  );
}

export interface LiveActivateProps {
  readonly headers: Readonly<Record<string, string>>;
  /** Injectable for tests; the default drives the real chain. */
  readonly drive?: ((
    port: ActivationPort, readSurface: () => Promise<SurfaceFrame>,
    kinds?: readonly ActivationChainKind[],
  ) => Promise<readonly ActivationStep[]>) | undefined;
  readonly onConnection?: ((connection: "CONNECTED" | "DISCONNECTED") => void) | undefined;
  readonly pollMs?: number | undefined;
  /** Injectable for tests; the default spends the attached session's own wire. */
  readonly port?: ActivationPort | undefined;
  readonly read?: (() => Promise<ActivationReadOutcome>) | undefined;
  /** Injectable for tests; the default reads POST /affordances/read with the session's headers. */
  readonly readSurface?: (() => Promise<SurfaceFrame>) | undefined;
  /** The attached session; absent (fixtures, tests) means the card can read but not activate. */
  readonly setup?: LiveSetup | undefined;
}

export function LiveActivate({
  drive, headers, onConnection, pollMs, port, read, readSurface, setup,
}: LiveActivateProps): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<ActivationReadOutcome> => readActivation(headers)));
  const { outcome, refresh } = useOpsRead(reader, ACTIVATION_FAILURE, pollMs ?? POLL_MS, onConnection);
  const [chainPort] = useState<ActivationPort | null>(
    () => port ?? (setup === undefined ? null : createActivationPort(setup)),
  );
  const [surfaceReader] = useState(() => readSurface ?? ((): Promise<SurfaceFrame> => readSurfaceOnce(headers)));
  const [driver] = useState(() => drive ?? driveActivationChain);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<readonly ActivationStep[]>([]);
  // The guard is a REF, not the `busy` state: two clicks can land in the same batch, before
  // React re-renders the disabled button, and two chains would race the same aggregate version.
  const inFlight = useRef(false);
  const onActivate = useCallback((): void => {
    if (chainPort === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSteps([]);
    const settle = (): void => { inFlight.current = false; setBusy(false); };
    void driver(chainPort, surfaceReader).then((done) => {
      setSteps(done);
      settle();
      refresh();
    }, settle);
  }, [chainPort, driver, refresh, surfaceReader]);
  const chain: ActivationChainState = {
    busy, onActivate: chainPort === null ? null : onActivate, steps,
  };
  return <ActivateScreen chain={chain} outcome={outcome} />;
}
