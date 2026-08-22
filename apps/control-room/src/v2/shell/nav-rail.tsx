import { useState } from "react";
import type { JSX } from "react";

import { StatusChip } from "../components/primitives.js";
import { TruthChip } from "../components/truth-chip.js";
import { ENDASH } from "../glyphs.js";
import { CORDUM_TRUTH_CLASSES, cordumTruthPresentation } from "../truth-class.js";
import { CORDUM_NAV_ITEMS, NAV_BADGE_TONE_VAR } from "./shell-model.js";
import type { NavBadgeTone, NavId, NavItem } from "./shell-model.js";

/**
 * The left navigation rail: the Moe wordmark, the destination list, and - pinned
 * to the bottom - the "HOW TO READ CHIPS" legend naming all five truth classes.
 *
 * Badges (Approvals, Health) are supplied by the caller, never invented here:
 * they light up only when a surface can count them. The live build passes none,
 * so an unbacked count never appears.
 */

export interface NavBadge {
  readonly count: string;
  readonly tone: NavBadgeTone;
}

export interface NavRailProps {
  readonly items?: readonly NavItem[] | undefined;
  readonly activeId?: NavId;
  readonly badges?: Partial<Record<NavId, NavBadge>> | undefined;
  readonly onNavigate?: ((id: NavId) => void) | undefined;
  readonly initialLegendOpen?: boolean;
}

export function NavRail({
  items = CORDUM_NAV_ITEMS,
  activeId = "goals",
  badges,
  onNavigate,
  initialLegendOpen = true,
}: NavRailProps): JSX.Element {
  const [legendOpen, setLegendOpen] = useState(initialLegendOpen);
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
          return (
            <li key={item.id}>
              <button
                aria-current={active ? "page" : undefined}
                className="cr2-navitem"
                data-active={active ? "true" : undefined}
                data-testid={`cr.nav.${item.id}`}
                onClick={() => onNavigate?.(item.id)}
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
                <span className="cr2-navlabel">{item.label}</span>
                {badge === undefined ? null : (
                  <StatusChip
                    label={badge.count}
                    testId={`cr.nav.${item.id}.badge`}
                    toneVar={NAV_BADGE_TONE_VAR[badge.tone]}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="cr2-legend" data-testid="cr.shell.legend">
        <button
          aria-expanded={legendOpen}
          className="cr2-legend-toggle"
          onClick={() => setLegendOpen((open) => !open)}
          type="button"
        >
          <span aria-hidden="true">{legendOpen ? ENDASH : "+"}</span>
          <span>HOW TO READ CHIPS</span>
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
