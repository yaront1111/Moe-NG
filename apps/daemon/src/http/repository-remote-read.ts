/**
 * REPOSITORY REMOTE: the git remote this project's first publish bound, as the operator sees it.
 * One aggregate (`remote:<projectId>`), folded by the publish ledger, so the read is constant
 * cost and never walks a decision page. Nothing here binds or resolves a remote: `readRemote`
 * projects what `repository.publish` already committed, and answers NULLS while nothing is bound.
 *
 * Unbound is a legitimate state, not an error: the Publish control renders an all-null view as
 * "no remote yet". Note what the shipped reader collapses INTO that state, because a consumer
 * cannot tell the cases apart from the response and must not try: `readProjectRemote` catches
 * its own store failure and re-applies today's admission rule on the read, so a broken store,
 * an undecodable binding, and a url the rule no longer admits ALL read as unbound. That is
 * deliberate fail-closed behaviour -- surfacing a superseded remote would point a push at a
 * repository the operator has already moved away from -- and it means REFUSED is reachable only
 * when the injected reader itself throws, never from a store fault. Both paths are pinned by
 * arms in this module's test.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readProjectRemote } from "../repository/publish-ledger.js";
import type { ProjectRemote } from "../repository/publish-ledger.js";
import { decodePublicationCandidate } from "../repository/publication-approval-contracts.js";
import type { PublicationApproval, PublicationCandidateReader } from "../repository/publication-approval-contracts.js";
import { admitRemoteUrl } from "../repository/publish-receipt-contracts.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const REPOSITORY_REMOTE_READ_PATH = "/repository/remote/read" as const;
const LAYER = "REPOSITORY_REMOTE_READ" as const;

export const REPOSITORY_REMOTE_READ_CODES = Object.freeze([
  "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", "REPOSITORY_REMOTE_READ_PROJECT_MISMATCH",
  "REPOSITORY_REMOTE_READ_UNREADABLE",
] as const);

export interface RepositoryRemoteView {
  /** When the binding was decided, or null while nothing is bound. */
  readonly boundAt: string | null;
  /** The PRINCIPAL that bound it, never a credential, or null while nothing is bound. */
  readonly boundBy: string | null;
  readonly outcome: "REMOTE";
  readonly readAt: string;
  readonly remoteUrl: string | null;
}
export interface RepositoryRemoteRefused {
  readonly code: string; readonly layer: string; readonly outcome: "REFUSED";
}
export type RepositoryRemoteReadResult = RepositoryRemoteRefused | RepositoryRemoteView;
export type PublicationCandidateView = RepositoryRemoteRefused | Readonly<{
  outcome: "PUBLICATION_CANDIDATE"; goalId: string; approval: PublicationApproval;
}>;
export interface RepositoryRemoteReadPort {
  readonly boundProjectId: string;
  readRemote(): RepositoryRemoteReadResult;
  preparePublication?(goalId: string, remoteUrl: string | null): PublicationCandidateView;
}

const refused = (code: string): RepositoryRemoteRefused =>
  Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });

export interface RepositoryRemoteReadOptions {
  readonly readPublicationCandidate?: PublicationCandidateReader;
  readonly clock?: () => string;
  readonly projectId: string;
  readonly readRemote?: (store: SqliteEventStore, projectId: string) => ProjectRemote | null;
  readonly store: SqliteEventStore;
}

export function createRepositoryRemoteReadPort(
  options: RepositoryRemoteReadOptions,
): RepositoryRemoteReadPort {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const readRemote = options.readRemote ?? readProjectRemote;
  const read = (): RepositoryRemoteReadResult => {
    try {
      const now = clock();
      const bound = readRemote(store, projectId);
      return Object.freeze({
        boundAt: bound === null ? null : bound.boundAt,
        boundBy: bound === null ? null : bound.boundBy,
        outcome: "REMOTE" as const,
        readAt: now,
        remoteUrl: bound === null ? null : bound.remoteUrl,
      });
    } catch {
      return refused("REPOSITORY_REMOTE_READ_UNREADABLE");
    }
  };
  const preparePublication = (goalId: string, raw: string | null): PublicationCandidateView => {
    try {
      const goal = stateOf(readDurableLedger(store, projectId), goalId);
      if (typeof goal !== "object" || goal === null || Array.isArray(goal)
        || (goal as Record<string, unknown>)["goalId"] !== goalId) return refused("PUBLISH_GOAL_UNBOUND");
      const remote = raw === null ? readRemote(store, projectId)?.remoteUrl ?? null : admitRemoteUrl(raw);
      if (remote === null) return refused(raw === null ? "PUBLISH_REMOTE_UNBOUND" : "PUBLISH_REMOTE_URL_INVALID");
      const measured = options.readPublicationCandidate?.(remote);
      if (measured === undefined) return refused("PUBLISH_WORKSPACE_UNCONFIGURED");
      if (!measured.ok) return refused(measured.code);
      const candidate = decodePublicationCandidate(measured.candidate);
      if (candidate === null || candidate.approval.remoteUrl !== remote) return refused("PUBLISH_CANDIDATE_UNREADABLE");
      return Object.freeze({ outcome: "PUBLICATION_CANDIDATE", goalId, approval: candidate.approval });
    } catch { return refused("PUBLISH_CANDIDATE_UNREADABLE"); }
  };
  return Object.freeze({ boundProjectId: projectId, readRemote: read, preparePublication });
}

export type RepositoryRemoteReadDispatch =
  | { readonly body: RepositoryRemoteReadResult | PublicationCandidateView | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID" | "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && typeof decoded.value === "object" && decoded.value !== null
    && !Array.isArray(decoded.value) && Object.keys(decoded.value).length === 0;
}

export function handleRepositoryRemoteReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly repositoryRemote?: RepositoryRemoteReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): RepositoryRemoteReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("REPOSITORY_REMOTE_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.repositoryRemote;
  if (port === undefined) return Object.freeze({ code: "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("REPOSITORY_REMOTE_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  if (!emptyBody(request.body)) {
    const decoded = decodeBoundedJsonBytes(request.body);
    const value = decoded.ok && typeof decoded.value === "object" && decoded.value !== null && !Array.isArray(decoded.value)
      ? decoded.value as Record<string, unknown> : null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 2 && typeof value["goalId"] === "string" && value["goalId"] !== ""
      && (value["remoteUrl"] === null || typeof value["remoteUrl"] === "string")) {
      return Object.freeze({ body: port.preparePublication?.(value["goalId"], value["remoteUrl"])
        ?? refused("PUBLISH_WORKSPACE_UNCONFIGURED"), httpStatus: 200, kind: "REPLY" });
    }
    return Object.freeze({ code: "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({ body: port.readRemote(), httpStatus: 200, kind: "REPLY" });
}
