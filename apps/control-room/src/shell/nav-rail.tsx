import { useId } from "react";
import type { JSX } from "react";

/** Nav rail, top to bottom (spec line 58). Timeline and graph are not rail items. */
export const CONTROL_ROOM_NAV_ITEMS = Object.freeze([
  "Goals", "Approvals", "Runs & leases", "Resources", "Health", "Policy",
] as const);

export type NavLabel = (typeof CONTROL_ROOM_NAV_ITEMS)[number];

const NAV_ICON_PATHS: Readonly<Record<NavLabel, string>> = Object.freeze({
  Approvals: "M5.5 12.5 9.5 16.5 18.5 7.5 M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z",
  Goals: "M12 4a8 8 0 1 0 8 8 M12 7a5 5 0 1 0 5 5 M12 10a2 2 0 1 0 2 2",
  Health: "M3.5 12h4l2-5 4 10 2.5-5h4.5 M12 3.5a8.5 8.5 0 1 0 8.5 8.5",
  Policy: "M12 3.5 19 6v5.4c0 4.3-2.8 7.5-7 9.1-4.2-1.6-7-4.8-7-9.1V6l7-2.5Z M9 12l2 2 4-4",
  Resources: "M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z M12 8v8 M8 12h8",
  "Runs & leases": "M7 7h7.5a5.5 5.5 0 0 1 0 11H11 M7 7l3-3 M7 7l3 3 M17 17l-3-3 M17 17l-3 3",
});

function navId(label: NavLabel): string {
  return label.split(" ")[0]?.toLowerCase() ?? label;
}

function NavIcon({ label }: { readonly label: NavLabel }): JSX.Element {
  return (
    <svg aria-hidden="true" className="cr-shell-nav-icon" fill="none" viewBox="0 0 24 24">
      <path d={NAV_ICON_PATHS[label]} stroke="currentColor" strokeLinecap="round"
        strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

export interface NavRailProps {
  readonly activeItem?: NavLabel | undefined;
  readonly narrow: boolean;
  readonly onNavigate?: ((label: NavLabel) => void) | undefined;
  readonly unavailableReason?: string | undefined;
}

export function NavRail({
  activeItem, narrow, onNavigate, unavailableReason,
}: NavRailProps): JSX.Element {
  const unavailableId = useId();
  const unavailable = unavailableReason !== undefined;
  return (
    <nav
      aria-label="Primary"
      data-narrow={narrow ? "true" : undefined}
      data-testid="cr.shell.navrail"
    >
      <div className="cr-shell-brand" data-testid="cr.shell.brand">
        <span aria-hidden="true" className="cr-shell-brand-mark">M</span>
        <span className="cr-shell-brand-name">Moe</span>
      </div>
      {unavailable ? (
        <p className="cr-shell-nav-unavailable" id={unavailableId}>{unavailableReason}</p>
      ) : null}
      <div className="cr-shell-nav-items">
        {CONTROL_ROOM_NAV_ITEMS.map((label) => (
          <button
            aria-current={!unavailable && activeItem === label ? "page" : undefined}
            aria-describedby={unavailable ? unavailableId : undefined}
            aria-label={label}
            data-testid={`cr.nav.${navId(label)}`}
            disabled={unavailable}
            key={label}
            onClick={() => { onNavigate?.(label); }}
            type="button"
          >
            <NavIcon label={label} />
            <span className="cr-shell-nav-label">{label}</span>
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="cr-shell-rail-signature">
        <span>M</span><span>O</span><span>E</span>
      </div>
    </nav>
  );
}
