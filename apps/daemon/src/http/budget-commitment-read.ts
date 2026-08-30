/**
 * The reachable consumer edge for the decide-time budget COMMITMENT
 * (task-80b6bf7c). A project-scoped read route: it names one run and answers
 * with whatever the shared builder derives from durable state alone.
 *
 * THIS MODULE DERIVES NOTHING. `deriveApprovalBudgetRef` composes the SAME
 * `budgetCommitmentMaterial` + `budgetCommitmentDigest` pair the activation
 * bind-back verifies against, so the transport and the fence agree by
 * construction rather than by review. A second material list here would be the
 * single-builder violation this row exists to avoid.
 *
 * Every refusal travels out with the code and layer its owner stamped.
 * Collapsing an upstream refusal into a local code would be indistinguishable
 * from not detecting it.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { deriveApprovalBudgetRef } from "../planning/approval-budget-ref.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const BUDGET_COMMITMENT_READ_PATH = "/budget/commitment/read" as const;

/**
 * PRIVATE ON PURPOSE. An exported `*_LAYER` constant is a rostered security
 * boundary owing its own coverage arms; this route declares no boundary of its
 * own beyond the two codes below, both of which are local facts about the
 * caller, never about authority.
 */
const BUDGET_COMMITMENT_READ_LAYER = "BUDGET_COMMITMENT_READ" as const;

/** Body keys this route accepts. A caller names work; it never presents authority. */
const REQUEST_KEYS = Object.freeze(["runId"]);

/**
 * ROUTE-LOCAL codes only, and there are exactly two: capability and project
 * binding are this route's OWN questions about its caller.
 *
 * There is deliberately no local "unreadable". `deriveApprovalBudgetRef` is
 * total — the ledger reader, the run binding and the material builder each
 * answer with their own code and layer — so a store failure already arrives
 * stably identified. A catch here could only replace one of those with a local
 * code, which is the collapse DoD 3 forbids.
 */
export const BUDGET_COMMITMENT_READ_CODES = Object.freeze([
  "BUDGET_COMMITMENT_READ_CAPABILITY_DENIED",
  "BUDGET_COMMITMENT_READ_PROJECT_MISMATCH",
] as const);

export type BudgetCommitmentReadCode = (typeof BUDGET_COMMITMENT_READ_CODES)[number];

export type BudgetCommitmentReadLayer = typeof BUDGET_COMMITMENT_READ_LAYER;

export interface BudgetCommitmentView {
  readonly outcome: "COMMITMENT";
  readonly ref: string;
}

/**
 * The forwarding shape. `code` and `layer` are whatever their owner stamped —
 * this route's own two codes carry its private layer, and every other pair
 * belongs to the ledger reader, the run binding, the material builder or the
 * durable store.
 */
export interface BudgetCommitmentRefused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export type BudgetCommitmentReadResult = BudgetCommitmentRefused | BudgetCommitmentView;

export interface BudgetCommitmentReadPort {
  readonly boundProjectId: string;
  readCommitment(runId: string): BudgetCommitmentReadResult;
}

function refusedLocally(code: BudgetCommitmentReadCode): BudgetCommitmentRefused {
  return Object.freeze({
    code, layer: BUDGET_COMMITMENT_READ_LAYER, outcome: "REFUSED" as const,
  });
}

/**
 * Reads the commitment for ONE caller-named run. The caller shapes nothing else:
 * not the project, not the store, and — because the derivation's vocabulary is
 * only {projectId, runId} — not the goal, the revision, the binding or the
 * material.
 */
export function readBudgetCommitment(
  store: SqliteEventStore, projectId: string, runId: string,
): BudgetCommitmentReadResult {
  const derived = deriveApprovalBudgetRef(store, projectId, runId);
  return "ref" in derived
    ? Object.freeze({ outcome: "COMMITMENT" as const, ref: derived.ref })
    : Object.freeze({
      code: derived.upstream.code, layer: derived.upstream.layer, outcome: "REFUSED" as const,
    });
}

export function createBudgetCommitmentReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): BudgetCommitmentReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readCommitment: (runId: string): BudgetCommitmentReadResult =>
      readBudgetCommitment(config.store, config.projectId, runId),
  });
}

type BudgetCommitmentListenerCode =
  | "LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID"
  | "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE";

export type BudgetCommitmentReadDispatch =
  | { readonly body: BudgetCommitmentReadResult | HttpPortRefused | HttpRefused;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: BudgetCommitmentListenerCode; readonly kind: "LISTENER_REFUSAL" };

/**
 * The exact-key body fence. A request names `runId` and nothing else.
 *
 * The STRING check lives here rather than downstream on purpose: a non-string
 * `runId` is a malformed request, and answering it at the listener keeps the
 * route's own roster at two codes instead of inventing a third for a shape
 * question the transport already owns.
 */
function requestedRunId(body: unknown): { readonly ok: boolean; readonly runId?: string } {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return { ok: false };
  const record = decoded.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { ok: false };
  const keys = Object.keys(record as Readonly<Record<string, unknown>>);
  if (keys.length !== REQUEST_KEYS.length || keys[0] !== REQUEST_KEYS[0]) return { ok: false };
  const runId = (record as Readonly<Record<string, unknown>>)["runId"];
  return typeof runId === "string" ? { ok: true, runId } : { ok: false };
}

export function handleBudgetCommitmentReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly budgetCommitment?: BudgetCommitmentReadPort | undefined;
  },
  request: {
    readonly body: unknown; readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): BudgetCommitmentReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.PLANNING)) {
    return Object.freeze({
      body: refusedLocally("BUDGET_COMMITMENT_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.budgetCommitment;
  if (port === undefined) {
    return Object.freeze({
      code: "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE", kind: "LISTENER_REFUSAL",
    });
  }
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({
      body: refusedLocally("BUDGET_COMMITMENT_READ_PROJECT_MISMATCH"),
      httpStatus: 200, kind: "REPLY",
    });
  }
  const requested = requestedRunId(request.body);
  if (!requested.ok || requested.runId === undefined) {
    return Object.freeze({
      code: "LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID", kind: "LISTENER_REFUSAL",
    });
  }
  return Object.freeze({
    body: port.readCommitment(requested.runId), httpStatus: 200, kind: "REPLY",
  });
}
