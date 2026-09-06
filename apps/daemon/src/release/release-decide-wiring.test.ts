import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import type { ReleaseDecideSeams } from "../daemon-command-async-entries.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release-decide-contracts.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import type { ReleaseDossierFacts } from "./release-decide-service.js";
import { GOAL_ID, HEAD_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";

/**
 * The COMPOSITION, not the service. `release-decide-service.test.ts` proves the behaviour;
 * this file proves the entry the daemon actually registers is the real handler when the
 * daemon is configured, and the fail-closed stub when it is not.
 *
 * It lives here rather than in `daemon-command-async-entries.test.ts` because that file is
 * a live peer's declared path (task-cf2d91d9); two rows editing one test file is how a
 * partial sweep breaks a branch head.
 */

afterEach(closeStores);

const OPERATOR = "human:operator";

function inputOf(): CommandHandlerInput {
  return {
    envelope: {
      commandId: "cmd-release-wiring",
      commandKind: RELEASE_DECIDE_COMMAND_KIND,
      correlationId: "corr-release-wiring",
      expectedVersion: 0,
      requestDigest: "0".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: randomUUID(),
      targetAggregateId: releaseDossierAggregateId(GOAL_ID),
      payload: { base: "main", decision: "APPROVE", goalId: GOAL_ID, sha: HEAD_SHA },
    },
    principal: { principalId: OPERATOR, projectId: PROJECT_ID, capabilities: [CAPABILITIES.GOAL] },
  };
}

function facts(): ReleaseDossierFacts {
  return { ancestry: ancestryOf().predicate, input: dossierInput({ projectId: PROJECT_ID }) };
}

function entryFor(
  store: ReturnType<typeof openStore>, releaseDecide: ReleaseDecideSeams | undefined,
): NonNullable<ReturnType<typeof createAsyncCommandEntries>[typeof
  RELEASE_DECIDE_COMMAND_KIND]["asyncHandler"]> {
  const entries = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
    store,
    ...(releaseDecide === undefined ? {} : { releaseDecide }),
  });
  const handler = entries[RELEASE_DECIDE_COMMAND_KIND].asyncHandler;
  if (handler === undefined) throw new Error("RELEASE_ASYNC_ENTRY_ABSENT");
  return handler;
}

async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const wired = (): ReleaseDecideSeams => ({
  dossierFacts: () => facts(),
  prPort: { async open() { return { ok: false, spawnErrorCode: null, stderrLastLine: "unused" }; } },
  publisher: { async publishOnce() { return []; } },
  workspace: "/tmp/workspace",
});

describe("release.decide composition", () => {
  it("stays fail-closed when no release seams are supplied", async () => {
    const refusal = await refusalOf(entryFor(openStore(), undefined)(inputOf()));
    expect(refusal.code).toBe("RELEASE_PR_FAILED");
    expect(refusal.detail).toBe("no release port is composed for this daemon");
  });

  it("composes the REAL handler once publisher, facts and workspace are all present",
    async () => {
      // RELEASE_REMOTE_MISSING is a code the stub can NEVER emit — the stub throws
      // RELEASE_PR_FAILED unconditionally. So this refusal is positive proof that the
      // registered entry is the real service and not the placeholder.
      const refusal = await refusalOf(entryFor(openStore(), wired())(inputOf()));
      expect(refusal.code).toBe("RELEASE_REMOTE_MISSING");
      expect(refusal.layer).toBe("PROJECT_REDUCER");
    });

  it("refuses rather than pushes when the workspace is null", async () => {
    let pushes = 0;
    const seams: ReleaseDecideSeams = {
      ...wired(),
      publisher: { async publishOnce() { pushes += 1; return []; } },
      workspace: null,
    };
    const refusal = await refusalOf(entryFor(openStore(), seams)(inputOf()));
    expect(refusal.code).toBe("RELEASE_PR_FAILED");
    expect(refusal.detail).toBe("no release port is composed for this daemon");
    expect(pushes).toBe(0);
  });

  it("stays fail-closed when the publisher is absent but everything else is present",
    async () => {
      const { publisher: _dropped, ...rest } = wired();
      const refusal = await refusalOf(entryFor(openStore(), rest)(inputOf()));
      expect(refusal.code).toBe("RELEASE_PR_FAILED");
      expect(refusal.detail).toBe("no release port is composed for this daemon");
    });

  it("keeps the entry's kind, capability and payload roster untouched", () => {
    const entries = createAsyncCommandEntries({
      operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store: openStore(),
      releaseDecide: wired(),
    });
    const entry = entries[RELEASE_DECIDE_COMMAND_KIND];
    // Child B owns the vocabulary; wiring a handler must not move any of it. Asserted
    // against the constant AND its literal value: a constant-only assertion moves with the
    // vocabulary and would stay green if the capability itself were changed.
    expect(entry.kind).toBe("release.decide");
    expect(entry.requiredCapability).toBe(CAPABILITIES.GOAL);
    expect(entry.requiredCapability).toBe("goal.write");
    expect([...entry.payloadKeys]).toEqual(["base", "decision", "goalId", "sha"]);
  });

  it("fences a non-operator principal even when fully composed", async () => {
    const agent = {
      envelope: inputOf().envelope, principal: { principalId: "agent:worker-1" },
    } as unknown as CommandHandlerInput;
    const refusal = await refusalOf(entryFor(openStore(), wired())(agent));
    expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
    expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
  });
});
