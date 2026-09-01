import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import "../styles/cordum-pairing.css";

export interface PairingConfirmationProps {
  readonly busy?: boolean | undefined;
  readonly confirmationLabel: string;
  readonly onConfirm: () => void;
  readonly scope?: "daemon" | "manager" | undefined;
}

/**
 * The one screen a first-time owner cannot skip, so it states the whole ritual as
 * numbered steps: the terminal prints no prompt and no confirmation (nothing logs
 * either side of the pairing routes) and the launchers accept only a bare
 * lowercase label terminated by a newline, so "lowercase" and "press Enter" are
 * load-bearing facts, not politeness. The opaque pairing request identity never
 * enters this renderable surface.
 */
export function PairingConfirmation({
  busy = false,
  confirmationLabel,
  onConfirm,
  scope = "daemon",
}: PairingConfirmationProps): JSX.Element {
  // The daemon consumer renders this inside CordumShell's <main>, so only the
  // manager scope - which is its document's whole body - owns a main landmark.
  const Wrapper = scope === "manager" ? "main" : "div";
  // Both consumers keep this card mounted and flip busy back to false only when
  // the claim came back still pending, so that edge is an honest "not yet".
  const wasBusy = useRef(false);
  const [bounced, setBounced] = useState(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
    } else if (wasBusy.current) {
      setBounced(true);
    }
  }, [busy]);
  return (
    <Wrapper className="cr2-pairing">
      <section className="cr2-pairing-card" aria-labelledby="cr2-pairing-title">
        <p className="cr2-pairing-kicker">ONE-TIME PAIRING</p>
        <h2 id="cr2-pairing-title">Pair this browser with {scope === "manager" ? "Moe Projects" : "Moe"}</h2>
        <ol className="cr2-pairing-steps">
          <li className="cr2-pairing-step">
            {/* Adjacent text nodes only: the no-touch cordum-app.test.tsx matches
                "foreground terminal that launched this project" by regex in
                exactly one element, so no inline child may split this line. */}
            Go to the terminal window where you started {scope === "manager"
              ? "Moe Projects - the foreground terminal that launched the project manager."
              : "Moe - the foreground terminal that launched this project."}
            <output className="cr2-pairing-label" aria-label="Pairing confirmation label">
              {confirmationLabel}
            </output>
          </li>
          <li className="cr2-pairing-step">
            Type this label there in lowercase, exactly as shown, then press Enter. That window
            prints no prompt and no confirmation - Moe answers here, not there.
          </li>
          <li className="cr2-pairing-step">Come back to this tab and press the button below.</li>
        </ol>
        {scope === "manager" ? null : (
          <details className="cr2-pairing-alt">
            <summary>Did Moe Projects open this tab?</summary>
            <p>
              Then type that project&apos;s visible INSTANCE id and one space before the label, all
              on one line, in the window running Moe Projects.
            </p>
          </details>
        )}
        <p className="cr2-pairing-note">
          The label expires quickly and is valid only for this local instance. Reload this page for
          a new one.
        </p>
        {/* Mounted from the first render: a polite region is announced reliably
            when its text changes inside a node already in the tree, not when the
            node itself appears. The sheet collapses its box while it is empty. */}
        <p className="cr2-pairing-bounce" data-filled={bounced && !busy ? "true" : "false"} role="status">
          {bounced && !busy
            ? "Not paired yet - Moe has not approved this label. Check that you typed it and pressed"
              + " Enter in that terminal window, then press the button again. If it still does not"
              + " pair, reload this page for a new label."
            : ""}
        </p>
        <button
          className="cr2-btn"
          data-variant="primary"
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          {busy ? "Checking approval…" : "I entered this label"}
        </button>
      </section>
    </Wrapper>
  );
}
