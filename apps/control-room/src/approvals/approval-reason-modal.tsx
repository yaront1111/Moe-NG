import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";

export interface ReasonModalProps {
  readonly auditEvent: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
  readonly scope: string;
  readonly title: string;
}

const FOCUSABLE = [
  "a[href]", "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)",
  "textarea:not(:disabled)", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Required-reason dialog shared by every destructive approval decision. */
export function ReasonModal(props: ReasonModalProps): JSX.Element {
  const { auditEvent, body, confirmLabel, onCancel, onConfirm, scope, title } = props;
  const [reason, setReason] = useState("");
  const modalRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const ready = reason.trim() !== "";

  useEffect(() => {
    const focused = document.activeElement;
    const invoker = focused instanceof HTMLElement ? focused : null;
    reasonRef.current?.focus();
    return () => {
      if (invoker?.isConnected === true) invoker.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      aria-label={title}
      aria-modal="true"
      data-testid="cr.approvals.reasonmodal"
      onKeyDown={handleKeyDown}
      ref={modalRef}
      role="dialog"
    >
      <h3>{title}</h3>
      <p>{body}</p>
      <p>{`Scope of effect: ${scope}`}</p>
      <p>{`This records event ${auditEvent} with your identity.`}</p>
      <label htmlFor="cr-approvals-reason">Reason (required):</label>
      <textarea
        id="cr-approvals-reason"
        onChange={(event) => setReason(event.target.value)}
        ref={reasonRef}
        value={reason}
      />
      <button disabled={!ready} onClick={() => onConfirm(reason)} type="button">
        {confirmLabel}
      </button>
      <button onClick={onCancel} type="button">Cancel</button>
    </div>
  );
}
