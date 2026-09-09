import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";
import { readRepositoryLandingEvidence, recordRepositoryLandingCompletion, recordRepositoryLandingIntent } from "../repository/repository-landing-intent.js";
import { finishRepositoryLandingNoEffect, repositoryLandingMayRetry, startRepositoryLandingAttempt } from "../repository/repository-landing-attempt.js";
import { createLandingFaultInjector } from "./landing-fault-injection.js";
import type { LandingFaultInjector } from "./landing-fault-injection.js";

export function landingJournalGate(store: SqliteEventStore, handle: RepositoryExecutionHandle | undefined): string | null {
  if (handle === undefined) return null;
  const journal = readRepositoryLandingEvidence(store, handle);
  if (!journal.ok) return journal.code === "REPOSITORY_RECOVERY_EVIDENCE_MISSING" ? null : journal.code;
  return journal.completion === null && repositoryLandingMayRetry(store, journal.intent) ? null : "REPOSITORY_RECOVERY_REQUIRED";
}

/**
 * Journal the start before Git; an unresolved start can never mint another Git effect.
 *
 * The four `fault.trip` calls are the DEVELOPMENT-ONLY crash knob (see
 * `landing-fault-injection.ts`). They are no-ops in every normal run — the injector is
 * disarmed unless the environment both names a point and sets development mode — and they
 * are here rather than in a test double because the window this row has to prove, between
 * the Git effect and the completion that records it, does not exist anywhere else.
 */
export async function commitJournaledLanding(input: { readonly handle: RepositoryExecutionHandle | undefined; readonly store: SqliteEventStore;
  readonly port: VerifiedWorkspacePort; readonly workspace: string; readonly binding: VerifiedWorkspaceBinding;
  readonly verifierReceiptId: string; readonly paths: readonly string[]; readonly message: string;
  readonly fault?: LandingFaultInjector }): ReturnType<VerifiedWorkspacePort["commit"]> {
  const fault = input.fault ?? createLandingFaultInjector();
  fault.trip("before-intent");
  if (input.handle === undefined) {
    const legacy = await input.port.commit(input.workspace, input.paths, input.message, input.binding);
    if (legacy.ok) fault.trip("after-commit");
    return legacy;
  }
  const intent = recordRepositoryLandingIntent(input.store, { handle: input.handle, binding: input.binding,
    verifierReceiptId: input.verifierReceiptId, paths: input.paths, message: input.message });
  if (!intent.ok) return intent;
  const started = startRepositoryLandingAttempt(input.store, intent.intent); if (!started.ok) return started;
  fault.trip("after-intent");
  const committed = await input.port.commit(input.workspace, input.paths, input.message, input.binding);
  if (!committed.ok) {
    if (committed.code === "VERIFIED_WORKSPACE_INDEX_LOCKED") {
      const recorded = finishRepositoryLandingNoEffect(input.store, intent.intent, started.version); if (!recorded.ok) return recorded;
    }
    return committed;
  }
  fault.trip("after-commit");
  const completed = recordRepositoryLandingCompletion(input.store, { intent: intent.intent, commit: committed.receipt });
  fault.trip("after-completion");
  return completed.ok ? committed : completed;
}
