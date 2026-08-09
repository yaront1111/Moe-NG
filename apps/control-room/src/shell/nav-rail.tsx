import type { JSX } from "react";

/** Nav rail, top to bottom (spec line 58). Timeline and graph are not rail items. */
export const CONTROL_ROOM_NAV_ITEMS = Object.freeze([
  "Goals", "Approvals", "Runs & leases", "Resources", "Health", "Policy",
] as const);

type NavLabel = (typeof CONTROL_ROOM_NAV_ITEMS)[number];

const NAV_ICONS: Readonly<Record<NavLabel, string>> = Object.freeze({
  Approvals: "✓",
  Goals: "◎",
  Health: "+",
  Policy: "§",
  Resources: "◇",
  "Runs & leases": "↻",
});

function navId(label: NavLabel): string {
  return label.split(" ")[0]?.toLowerCase() ?? label;
}

export function NavRail({ narrow }: { readonly narrow: boolean }): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      data-narrow={narrow ? "true" : undefined}
      data-testid="cr.shell.navrail"
    >
      {CONTROL_ROOM_NAV_ITEMS.map((label) => (
        <button aria-label={label} data-testid={`cr.nav.${navId(label)}`} key={label} type="button">
          <span aria-hidden="true" className="cr-shell-nav-icon">{NAV_ICONS[label]}</span>
          <span className="cr-shell-nav-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
