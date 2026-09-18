import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { exact, hash, isObject, ref } from "../json-record-shape.js";
import { validPublicationBranch } from "./publication-approval-contracts.js";
import type { PublicationCandidate } from "./publication-approval-contracts.js";
import type { PublicationGitPort } from "./publication-effect-contracts.js";
import { NODE_PUBLISHER_PRINCIPAL_ID, remoteAggregateId } from "./publish-receipt-contracts.js";

/**
 * A project remote's DEFAULT branch, as the remote itself last reported it. It is its own event on
 * the remote aggregate and never a fourth key on `RepositoryRemoteBound`: `decodeBinding` demands
 * that binding's exact key set, so widening it would unbind every project already stored, and
 * publish and release would both refuse. `readProjectRemote` folds only its own event type, so this
 * one is invisible to it. Nothing already stored can be broken by an event type it never reads.
 */
const MEASURED_EVENT_TYPE = "RepositoryRemoteDefaultMeasured";
const MEASURED_KIND = "internal.repository.remote_default_measured";
const MEASURED_KEYS = ["defaultBranch", "measuredAt", "remoteUrl"] as const;
const encoder = new TextEncoder();

export interface RemoteDefaultMeasurement {
  readonly projectId: string;
  readonly remoteUrl: string;
  /** null: the remote answered and advertises no default branch. */
  readonly defaultBranch: string | null;
  readonly measuredAt: string;
}

type Measured = Readonly<{ defaultBranch: string | null; measuredAt: string; remoteUrl: string }>;

/** Its OWN exact key set: a malformed measurement reads exactly like no measurement. */
function decodeMeasurement(payload: Uint8Array): Measured | null {
  const decoded = decodeBoundedJsonBytes(payload);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, MEASURED_KEYS)) return null;
  const { defaultBranch, measuredAt, remoteUrl } = decoded.value;
  return ref(remoteUrl) && ref(measuredAt) && (defaultBranch === null || validPublicationBranch(defaultBranch))
    ? { defaultBranch: defaultBranch ?? null, measuredAt, remoteUrl } : null;
}

/** The project's latest measurement, whichever remote it names; null when there is none or it is malformed. */
function latestMeasurement(store: SqliteEventStore, projectId: string): Measured | null {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(remoteAggregateId(projectId));
  } catch {
    return null;
  }
  let latest: StoredEvent | null = null;
  for (const event of events) {
    if (event.eventType !== MEASURED_EVENT_TYPE) continue;
    if (latest === null || event.aggregateSequence >= latest.aggregateSequence) latest = event;
  }
  return latest === null ? null : decodeMeasurement(latest.payload);
}

/**
 * Records one measurement, fenced on `store.getAggregateVersion` exactly as `bindingLeg` is (the
 * durable ledger never versions this aggregate, so its version would read 0). Answers whether the
 * measurement is now the latest one:
 * - an answer equal to the latest is not written again, so the aggregate `readProjectRemote` reads
 *   grows only when a default changes, never once per publish;
 * - a write that loses its fence to a concurrent rebind is dropped, never retried;
 * - a measurement that would not decode is never written over a good one.
 * The fenced version is part of the decision key, so the same answer at a later position is a new
 * write, never a replay of the earlier one.
 */
export function recordRemoteDefaultBranch(store: SqliteEventStore, input: RemoteDefaultMeasurement): boolean {
  const payload = encoder.encode(JSON.stringify({ defaultBranch: input.defaultBranch, measuredAt: input.measuredAt, remoteUrl: input.remoteUrl }));
  if (decodeMeasurement(payload) === null) return false;
  const latest = latestMeasurement(store, input.projectId);
  if (latest?.remoteUrl === input.remoteUrl && latest.defaultBranch === input.defaultBranch) return true;
  const aggregateId = remoteAggregateId(input.projectId);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = hash([MEASURED_KIND, input.projectId, input.remoteUrl, input.defaultBranch, input.measuredAt, expectedVersion]);
  const written = store.commitExpectedVersionDecision({ commandKind: MEASURED_KIND, committedResultBytes: payload,
    correlationId: "remote-default-measured", decidedAt: input.measuredAt,
    events: [{ eventId: `${commandId}-measured`, eventType: MEASURED_EVENT_TYPE, payload }], expectedVersion,
    key: { commandId, principalId: NODE_PUBLISHER_PRINCIPAL_ID, projectId: input.projectId },
    requestBytes: payload, targetAggregateId: aggregateId });
  return written.decision.effectDisposition === "EFFECTS_COMMITTED";
}

/**
 * Measures the candidate's remote and records the answer ONLY when the remote gave one: a refusal
 * is no fact about the remote and never overwrites an earlier measurement. A port without the
 * method measures nothing, leaving the default unknown. Every failure is swallowed, so a
 * measurement can never change the outcome of the publish it rides on.
 */
export async function measureRemoteDefaultBranch(store: SqliteEventStore, projectId: string, git: PublicationGitPort,
  candidate: PublicationCandidate, clock: () => string): Promise<void> {
  try {
    const measured = await git.measureDefaultBranch?.(candidate);
    if (measured?.ok === true) {
      recordRemoteDefaultBranch(store, { projectId, remoteUrl: candidate.approval.remoteUrl, defaultBranch: measured.defaultBranch, measuredAt: clock() });
    }
  } catch { /* the default stays as last recorded; the next fresh publish measures again */ }
}

/**
 * The default branch of `remoteUrl`, or null when it was never measured, advertises none, or the
 * LATEST measurement names a different remote: a re-bound remote is never answered by the old
 * remote's default, even after a rebind back, until it is measured again.
 */
export function readRemoteDefaultBranch(store: SqliteEventStore, projectId: string, remoteUrl: string): string | null {
  const latest = latestMeasurement(store, projectId);
  return latest?.remoteUrl === remoteUrl ? latest.defaultBranch : null;
}
