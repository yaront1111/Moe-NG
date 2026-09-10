import { useId, useState } from "react";
import type { JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { TruthChip } from "../components/truth-chip.js";
import { ENDASH } from "../glyphs.js";
import { CORDUM_TRUTH_CLASSES, cordumTruthPresentation } from "../truth-class.js";
import { CORDUM_NAV_ITEMS, NAV_BADGE_TONE_VAR } from "./shell-model.js";
import type { NavBadgeTone, NavId, NavItem } from "./shell-model.js";
import {
  NAV_UNAVAILABLE_LABELS, NAV_UNAVAILABLE_REASONS, resolveNavDestinations,
} from "./shell-routes.js";
import type { CordumRoute, NavDestination, NavUnavailableReason } from "./shell-routes.js";
import "./nav-rail.css";

/**
 * The left navigation rail: the Moe wordmark, the destination list, and - pinned
 * to the bottom - the "HOW TO READ CHIPS" legend naming all five truth classes.
 *
 * Badges (Approvals, Health) are supplied by the caller, never invented here:
 * they light up only when a surface can count them. The live build passes none,
 * so an unbacked count never appears.
 *
 * The rail holds NO route knowledge of its own: every button is driven from the
 * `shell-routes` source of truth. A destination that roster reports unreachable is
 * rendered DISABLED and described by its measured reason, never left inert - and
 * never enabled merely because a navigator happened to be passed.
 */

export interface NavBadge {
  readonly count: string;
  readonly tone: NavBadgeTone;
}

export interface NavRailProps {
  readonly items?: readonly NavItem[] | undefined;
  readonly activeId?: NavId;
  readonly badges?: Partial<Record<NavId, NavBadge>> | undefined;
  readonly destinations?: readonly NavDestination[] | undefined;
  readonly onNavigate?: ((route: CordumRoute) => void) | undefined;
  readonly initialLegendOpen?: boolean;
}

export function NavRail({
  items = CORDUM_NAV_ITEMS,
  activeId = "goals",
  badges,
  destinations,
  onNavigate,
  initialLegendOpen = false,
}: NavRailProps): JSX.Element {
  const [legendOpen, setLegendOpen] = useState(initialLegendOpen);
  const railId = useId();
  const roster = destinations ?? resolveNavDestinations();
  const reasonNodeId = (reason: NavUnavailableReason): string => `${railId}-${reason}`;
  // An item the roster does not name is unreachable by the same rule as one it
  // names as unbuilt: the roster is the measurement, so its silence is not a licence.
  const reasonFor = (id: NavId): NavUnavailableReason | null => {
    const destination = roster.find((candidate) => candidate.id === id);
    return destination === undefined ? "NAV_DESTINATION_NOT_BUILT" : destination.reason;
  };
  const routeFor = (id: NavId): CordumRoute | null =>
    roster.find((candidate) => candidate.id === id)?.route ?? null;
  const shownReasons = NAV_UNAVAILABLE_REASONS
    .filter((reason) => items.some((item) => reasonFor(item.id) === reason));
  return (
    <nav aria-label="Primary" className="cr2-navrail" data-testid="cr.shell.navrail">
      <div className="cr2-brand" data-testid="cr.shell.brand">
        <span aria-hidden="true" className="cr2-brand-mark">M</span>
        <span className="cr2-brand-name">Moe</span>
        <span className="cr2-brand-version">v0.1</span>
      </div>

      <ul className="cr2-navlist">
        {items.map((item) => {
          const badge = badges?.[item.id];
          const active = item.id === activeId;
          const reason = reasonFor(item.id);
          const route = routeFor(item.id);
          const unavailable = reason !== null;
          return (
            <li key={item.id}>
              <button
                aria-current={active ? "page" : undefined}
                aria-describedby={reason === null ? undefined : reasonNodeId(reason)}
                className="cr2-navitem"
                data-active={active ? "true" : undefined}
                data-testid={`cr.nav.${item.id}`}
                data-unavailable-reason={reason ?? undefined}
                disabled={unavailable}
                onClick={onNavigate === undefined || route === null
                  ? undefined
                  : () => onNavigate(route)}
                title={reason === null
                  ? active ? "Current view" : undefined
                  : NAV_UNAVAILABLE_LABELS[reason]}
                type="button"
              >
                <svg aria-hidden="true" className="cr2-navicon" fill="none" viewBox="0 0 24 24">
                  <path
                    d={item.icon}
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.7}
                  />
                </svg>
                <span className="cr2-navlabel">
                  {item.label}{reason === null ? null : " not available yet"}
                </span>
                {badge === undefined ? null : (
                  <StatusChip
                    label={badge.count}
                    testId={`cr.nav.${item.id}.badge`}
                    toneVar={NAV_BADGE_TONE_VAR[badge.tone]}
                  />
                )}
                {!unavailable ? null : (
                  <StatusChip
                    label="SOON"
                    testId={`cr.nav.${item.id}.unavailable`}
                    toneVar="--cr-ink-soft"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        One sentence per reason actually present on this rail, addressed by
        aria-describedby. Hidden from the visual layout - the SOON chip and the
        button's title already say it there - but read out with the control, so a
        disabled destination explains itself rather than looking broken.
      */}
      {shownReasons.map((reason) => (
        <p className="cr2-navreason" hidden id={reasonNodeId(reason)} key={reason}>
          {NAV_UNAVAILABLE_LABELS[reason]}
        </p>
      ))}

      <div className="cr2-legend" data-testid="cr.shell.legend">
        <button
          aria-expanded={legendOpen}
          className="cr2-legend-toggle"
          onClick={() => setLegendOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">{legendOpen ? ENDASH : "+"}</span>
          <span>What these marks mean</span>
        </button>
        {legendOpen ? (
          <div className="cr2-legend-body">
            <p className="cr2-legend-lede">
              Every value carries the class it was supplied with. Click a chip to
              read its receipt.
            </p>
            {CORDUM_TRUTH_CLASSES.map((truthClass) => (
              <div className="cr2-legend-row" data-testid={`cr.legend.${truthClass.toLowerCase()}`} key={truthClass}>
                <TruthChip compact interactive={false} truthClass={truthClass} />
                <span className="cr2-legend-name">{cordumTruthPresentation(truthClass).name}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
