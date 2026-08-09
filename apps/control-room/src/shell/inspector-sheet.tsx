import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

export interface InspectorSheetProps {
  readonly children?: ReactNode;
  readonly expanded: boolean;
  readonly narrow: boolean;
}

export function InspectorSheet({
  children,
  expanded,
  narrow,
}: InspectorSheetProps): JSX.Element {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!narrow || !expanded) setDismissed(false);
  }, [expanded, narrow]);

  useEffect(() => {
    if (!narrow || !expanded || dismissed) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dismissed, expanded, narrow]);

  const visible = expanded && (!narrow || !dismissed);
  return (
    <aside
      aria-label="Inspector"
      data-narrow={narrow ? "true" : undefined}
      data-testid="cr.shell.inspector"
      hidden={!visible}
      role={narrow && visible ? "dialog" : undefined}
    >
      {children}
    </aside>
  );
}
