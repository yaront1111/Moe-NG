import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from "react";

const FOCUSABLE = [
  "a[href]", "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)",
  "textarea:not(:disabled)", "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface InspectorSheetProps {
  readonly children?: ReactNode;
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly obscured?: boolean;
  readonly onDismiss: () => void;
}

export function InspectorSheet({
  children,
  expanded,
  narrow,
  obscured = false,
  onDismiss,
}: InspectorSheetProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const visible = expanded && !obscured;

  useEffect(() => {
    if (!narrow || !visible) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [narrow, onDismiss, visible]);

  useEffect(() => {
    if (!narrow || !expanded) return undefined;
    const focused = document.activeElement;
    returnFocusRef.current = focused instanceof HTMLElement ? focused : null;
    closeRef.current?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected === true) returnFocusRef.current.focus();
      returnFocusRef.current = null;
    };
  }, [expanded, narrow]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!narrow || !visible) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(inspectorRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
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
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onDismiss();
  };

  return (
    <>
      {narrow && visible ? (
        <div aria-hidden="true" className="cr-shell-inspector-backdrop"
          data-testid="cr.shell.inspector.backdrop" onMouseDown={closeFromBackdrop} />
      ) : null}
      <aside
        aria-label="Inspector"
        aria-modal={narrow && visible ? true : undefined}
        data-narrow={narrow ? "true" : undefined}
        data-testid="cr.shell.inspector"
        hidden={!visible}
        id="cr-shell-inspector"
        onKeyDown={handleKeyDown}
        ref={inspectorRef}
        role={narrow && visible ? "dialog" : undefined}
      >
        {narrow && expanded ? (
          <button className="cr-shell-inspector-close" onClick={onDismiss}
            ref={closeRef} type="button">
            <span aria-hidden="true">×</span> Close inspector
          </button>
        ) : null}
        {children}
      </aside>
    </>
  );
}
