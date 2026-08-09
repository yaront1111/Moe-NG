import type { JSX } from "react";

import { SuppliedActions } from "../goals/supplied-actions.js";
import { FactRow, readIdentity } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { useGating } from "../shell/frame.js";

/**
 * Shared resources (spec section 4.12, section 11.3).
 *
 * The property this surface exists to preserve is the QUEUE ORDER. Waiting order is a
 * daemon decision — it encodes fairness, priority ageing and policy this client cannot
 * see. So `waiters` is rendered in the supplied order and there is no sort, no comparator
 * and no priority parsing anywhere below. A client-side sort would produce a list that
 * looks correct and silently contradicts the daemon's own queue.
 *
 * `priority` is therefore a displayed FACT, never a sort key.
 */
export interface ResourceWaiterProjection {
  readonly priority: SuppliedFact;
  /** Display identity; opaque, shown and compared but never interpreted. */
  readonly waiterId: string;
  readonly waiting: SuppliedFact;
}

export interface ResourceProjection {
  /** Aggregate id the daemon's own commands target; never derived from `resourceId`. */
  readonly actionTargetId: string;
  readonly holder: SuppliedFact;
  readonly holdingTask: SuppliedFact;
  readonly leaseExpiry: SuppliedFact;
  readonly resourceId: string;
  /** In the daemon's order. Rendered as given — see the header. */
  readonly waiters: readonly ResourceWaiterProjection[];
}

export interface ResourcesSurfaceProps {
  readonly degraded?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly rows: readonly ResourceProjection[];
}

/** Spec section 11.3, verbatim. The surface may not soften or shorten this. */
export const RESOURCES_EMPTY_COPY
  = "No shared resources declared. They appear on first acquisition or via policy.";

const SKELETON_ROWS = 3;

const RESOURCE_FACTS: readonly (readonly [
  suffix: string, label: string, pick: (resource: ResourceProjection) => SuppliedFact,
])[] = [
  ["resource.holder", "Holder", (resource) => resource.holder],
  ["resource.holdingtask", "Holding task", (resource) => resource.holdingTask],
  ["resource.leaseexpiry", "Lease expiry", (resource) => resource.leaseExpiry],
];

function Waiter(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly waiter: ResourceWaiterProjection;
}): JSX.Element {
  const { onProvenance, waiter } = props;
  const identity = readIdentity(waiter.waiterId);
  return (
    <li data-testid={`cr.resources.waiter.${identity}`}>
      <FactRow
        fact={waiter.priority}
        factId={`resource.waiter.priority.${identity}`}
        label="Priority"
        onProvenance={onProvenance}
      />
      <FactRow
        fact={waiter.waiting}
        factId={`resource.waiter.waiting.${identity}`}
        label="Waiting"
        onProvenance={onProvenance}
      />
    </li>
  );
}

function ResourceRow(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly resource: ResourceProjection;
  readonly stale: boolean;
}): JSX.Element {
  const { onProvenance, resource, stale } = props;
  const identity = readIdentity(resource.resourceId);
  return (
    <li
      data-stale={stale ? "true" : undefined}
      data-testid={`cr.resources.row.${identity}`}
      tabIndex={-1}
    >
      {RESOURCE_FACTS.map(([suffix, label, pick]) => (
        <FactRow
          fact={pick(resource)}
          factId={suffix}
          key={suffix}
          label={label}
          onProvenance={onProvenance}
        />
      ))}
      {/*
        Rendered with no sort and no comparator. The section element is present even when
        the queue is empty, so "nobody is waiting" is visible rather than indistinguishable
        from "the queue did not render".
      */}
      <ol data-testid="cr.resources.queue">
        {resource.waiters.map((waiter) => (
          <Waiter key={waiter.waiterId} onProvenance={onProvenance} waiter={waiter} />
        ))}
      </ol>
      <SuppliedActions
        targetAggregateId={resource.actionTargetId}
        testId={`cr.resources.actions.${identity}`}
      />
    </li>
  );
}

function Skeletons(): JSX.Element {
  return (
    <ul aria-busy="true" data-testid="cr.resources.loading">
      {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
        <li data-testid="cr.resources.skeleton" key={`skeleton-${String(index)}`}>
          <span aria-hidden="true">…</span>
        </li>
      ))}
    </ul>
  );
}

export function ResourcesSurface(props: ResourcesSurfaceProps): JSX.Element {
  const { degraded, loading, onProvenance, rows } = props;
  const { stale } = useGating();
  const flagged = degraded === true || stale;
  return (
    <section aria-label="Shared resources" data-testid="cr.resources">
      {flagged ? (
        <p data-testid="cr.resources.stalelabel" role="status">
          Rows may be stale.
        </p>
      ) : null}
      {loading === true ? <Skeletons /> : null}
      {loading !== true && rows.length === 0 ? (
        <p data-testid="cr.resources.empty">{RESOURCES_EMPTY_COPY}</p>
      ) : null}
      {rows.length === 0 ? null : (
        <ul data-testid="cr.resources.list">
          {rows.map((resource) => (
            <ResourceRow
              key={resource.resourceId}
              onProvenance={onProvenance}
              resource={resource}
              stale={flagged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
