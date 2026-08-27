import type { JSX } from "react";

export interface PairingConfirmationProps {
  readonly busy?: boolean | undefined;
  readonly confirmationLabel: string;
  readonly onConfirm: () => void;
  readonly scope?: "daemon" | "manager" | undefined;
}

/** The opaque pairing request identity never enters this renderable surface. */
export function PairingConfirmation({
  busy = false,
  confirmationLabel,
  onConfirm,
  scope = "daemon",
}: PairingConfirmationProps): JSX.Element {
  // The daemon consumer renders this inside CordumShell's <main>, so only the
  // manager scope - which is its document's whole body - owns a main landmark.
  const Wrapper = scope === "manager" ? "main" : "div";
  return (
    <Wrapper className="cr2-pairing">
      <section className="cr2-pairing-card" aria-labelledby="cr2-pairing-title">
        <p className="cr2-pairing-kicker">LOCAL OPERATOR CONFIRMATION</p>
        <h2 id="cr2-pairing-title">Pair this browser with {scope === "manager" ? "Moe Projects" : "Moe"}</h2>
        <p className="cr2-pairing-copy">
          Type this exact label into the foreground terminal that launched {scope === "manager" ? "the project manager" : "this project"}.
        </p>
        {scope === "manager" ? null : (
          <p className="cr2-pairing-copy">
            If Moe Projects opened this tab, prefix the label with that project&apos;s visible
            INSTANCE id and one space.
          </p>
        )}
        <output className="cr2-pairing-label" aria-label="Pairing confirmation label">
          {confirmationLabel}
        </output>
        <p className="cr2-pairing-note">The label expires quickly and is valid only for this local instance.</p>
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
