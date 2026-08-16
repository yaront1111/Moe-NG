/**
 * `work.resume` as an AUTHENTICATED COMMAND — the second edge this task owns.
 *
 * Before this, `evaluateContinuationCommandBytes` had no caller a credential
 * could reach: only `continuation-test-harness.ts` and its two suites. These
 * cases go through `handleCommandRequest` over the PRODUCTION provider, so the
 * authentication, the capability, the payload allow-list and the continuation
 * gate all answer for themselves.
 *
 * THE RECEIPT IS ASSERTED AS A DURABLE FACT, not as a returned shape: the binding
 * is read back with `readContinuationBindings` after the send.
 *
 * WINDOWS HANDLE DISCIPLINE: the provider and every extra store handle are closed
 * in `afterAll`, or the temp-directory cleanup throws EPERM and kills the worker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { CONTINUATION_COMMAND_KIND } from "./recovery/continuation-command.js";
import { readContinuationBindings } from "./recovery/continuation-service.js";
import { SETTLED, observation, records, situation } from "./recovery/recovery-test-fixtures.js";
import { reconcileOnRestart } from "./recovery/restart-reconciliation.js";

const CREDENTIAL = "continuation-operator-credential";
const PROJECT = "proj-continuation-command";
const DECIDED_AT = "2026-08-09T12:00:00.000Z";
const RECONCILED = "attempt-reconciled";

const directory = mkdtempSync(join(tmpdir(), "moe-continuation-command-"));
const storePath = join(directory, "store.db");

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);

/**
 * A crash the runner classifies ABSENT: proven gone, settled, resources released,
 * AND carrying a safe handoff. The handoff is not decoration — `admitResume`
 * refuses a resume whose release boundary carries none, with
 * `RECOVERY_RESUME_BOUNDARY_UNPROVEN` at `SAFE_BOUNDARY`, so a seed without it
 * would leave every case below testing that refusal instead of the command edge.
 */
const seeded = reconcileOnRestart(setupStore, {
  attempts: [{
    attemptRef: RECONCILED,
    situation: situation({
      observation: observation({
        effectStatus: "PROVEN_ABSENT", processExit: { code: 0, kind: "EXITED" },
      }),
      records: records({ ...SETTLED, safeHandoff: "handoff-1" }),
    }),
  }],
  correlationId: "corr-continuation-seed",
  decidedAt: DECIDED_AT,
  principalId: "daemon-1",
  projectId: PROJECT,
});
setupStore.close();

const provider = createStoreDependencies({
  clock: (): string => DECIDED_AT,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function send(
  commandId: string,
  payload: Readonly<Record<string, unknown>>,
  credential: string | null = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId,
      commandKind: CONTINUATION_COMMAND_KIND,
      correlationId: "corr-continuation-command",
      expectedVersion: 0,
      payload,
      requestDigest: "b".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential ?? "",
      targetAggregateId: "agg-continuation",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

function bindings(): readonly { readonly bindingRef: string; readonly successorRef: string }[] {
  const opened = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return readContinuationBindings(opened, PROJECT);
  } finally {
    opened.close();
  }
}

it("seeds a runner classification the continuation can actually stand on", () => {
  // Asserted before anything uses it: a seed that silently refused would leave
  // every case below testing UNRECONCILED instead of what it claims to test.
  expect(seeded.ok).toBe(true);
});

it("answers an authenticated continuation with a real receipt and a durable binding", () => {
  const result = send("cmd-continuation-1", {
    attemptRef: RECONCILED, successorRef: "successor-1",
  });
  expect(result).toMatchObject({
    decision: { disposition: "DECIDED", resultCode: "BOUND" },
    httpStatus: 200,
    ok: true,
    outcome: "ACCEPTED",
  });
  const bound = bindings().filter((binding) => binding.successorRef === "successor-1");
  expect(bound).toHaveLength(1);
  expect(result).toMatchObject({ decision: { effectId: bound[0]?.bindingRef } });
});

it("reports REPLAYED, not DECIDED, when the identical continuation is sent again", () => {
  // The producer answers BOUND either way, so a hard-coded DECIDED would pass the
  // case above and lie here. The disposition is measured, not assumed.
  const result = send("cmd-continuation-1-again", {
    attemptRef: RECONCILED, successorRef: "successor-1",
  });
  expect(result).toMatchObject({
    decision: { disposition: "REPLAYED", resultCode: "BOUND" },
    outcome: "ACCEPTED",
  });
  expect(bindings().filter((binding) => binding.successorRef === "successor-1")).toHaveLength(1);
});

it("refuses an unauthenticated send with its exact code and stage", () => {
  const before = bindings().length;
  expect(send("cmd-continuation-unauth", {
    attemptRef: RECONCILED, successorRef: "successor-unauth",
  }, null)).toMatchObject({
    error: { code: "AUTHENTICATION_FAILED" },
    httpStatus: 401,
    ok: false,
    outcome: "REFUSED",
    stage: "AUTHENTICATE",
  });
  expect(bindings()).toHaveLength(before);
});

it("refuses a payload carrying a SERVER FACT rather than silently overwriting it", () => {
  // `principalId` is assembled from the authenticated principal. A caller that
  // could send one would attribute a continuation to somebody else, so the
  // allow-list refuses the whole payload before dispatch — it never trims it.
  const before = bindings().length;
  expect(send("cmd-continuation-smuggled", {
    attemptRef: RECONCILED, principalId: "somebody-else", successorRef: "successor-smuggled",
  })).toMatchObject({
    error: { code: "INPUT_INVALID" },
    httpStatus: 400,
    ok: false,
    outcome: "REFUSED",
    stage: "PAYLOAD_SHAPE",
  });
  expect(bindings()).toHaveLength(before);
});

it("refuses an attempt reconciliation never classified, at the CONTINUATION layer", () => {
  expect(send("cmd-continuation-unreconciled", {
    attemptRef: "attempt-never-seen", successorRef: "successor-unreconciled",
  })).toMatchObject({
    httpStatus: 422,
    ok: false,
    outcome: "PORT_REFUSED",
    refusal: { code: "CONTINUATION_ATTEMPT_UNRECONCILED", layer: "CONTINUATION" },
    stage: "DISPATCH",
  });
});
