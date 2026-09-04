import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { aggregateIdFor, readWorkClaimLedger } from "./work/work-claim-services.js";

/**
 * The conflict refusal on the REAL MCP command wire, and the seat behaviour it is FOR.
 *
 * A seat that is told only "EXPECTED_VERSION_CONFLICT" cannot recover: it does not know which
 * version to resend at, so it guesses, and every guess writes another rejection row into the
 * decision ledger. The arms here pin the fix end to end — the wire names the observed version,
 * and one retry AT that version succeeds — with the ledger's rejection count as the
 * discriminator between the fixed seat and the guessing one.
 *
 * Lives beside `mcp-dispatch-port.test.ts` rather than inside it: that file is being edited
 * concurrently by a sibling task in this shared worktree.
 */

const CREDENTIAL = "mcp-conflict-operator-credential";
const PROJECT = "proj-mcp-conflict";
const CLAIMANT = "operator-local";

const directory = mkdtempSync(join(tmpdir(), "moe-mcp-conflict-"));
const storePath = join(directory, "store.db");
const provider = createStoreDependencies({
  clock: () => "2026-08-09T12:00:00.000Z",
  credential: CREDENTIAL,
  principalId: CLAIMANT,
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

const port = createMcpDispatchPort({
  deps: provider.provide(),
  fallbackCredential: CREDENTIAL,
  subscriptions,
});

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Refusal {
  readonly code: string;
  readonly detail: string;
  readonly httpStatus: number;
  readonly layer: string;
}

interface Answer {
  readonly outcome: string;
  readonly refusal?: Refusal;
  readonly stage?: string;
}

const REFUSED_OUTCOME = "PORT_REFUSED";

let sequence = 0;

/** One command over the real MCP command wire, exactly as an MCP seat sends it. */
async function dispatch(
  commandKind: string,
  payload: Readonly<Record<string, unknown>>,
  expectedVersion: number,
): Promise<Answer> {
  const envelope = {
    commandId: `cmd-mcp-conflict-${String(sequence += 1)}`,
    commandKind,
    correlationId: "corr-mcp-conflict",
    expectedVersion,
    payload,
    requestDigest: createHash("sha256")
      .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL,
    targetAggregateId: PROJECT,
  };
  const bytes = await port.dispatchCommandBytes(encoder.encode(JSON.stringify(envelope)));
  return JSON.parse(decoder.decode(bytes)) as Answer;
}

const claim = async (item: string, expectedVersion: number): Promise<Answer> =>
  await dispatch("work.claim", { expiresAt: "2026-08-09T13:00:00.000Z", workItemId: item },
    expectedVersion);

const release = async (item: string, expectedVersion: number): Promise<Answer> =>
  await dispatch("work.release", { workItemId: item }, expectedVersion);

/**
 * Every EXPECTED_VERSION_CONFLICT the store durably recorded for one work item. This is the
 * count a live seat's blind retry loop inflates, so it is the measurement that tells a fixed
 * seat from a guessing one — and it is read from the LEDGER, not from what the seat believed.
 */
function rejectionCount(item: string): number {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  const aggregateId = aggregateIdFor(item);
  let count = 0;
  let cursor = 0n;
  try {
    for (;;) {
      const page = reader.readCommandDecisionsAfter(cursor, 200);
      for (const decision of page.items) {
        if (decision.targetAggregateId !== aggregateId) continue;
        if (decision.resultCode === "EXPECTED_VERSION_CONFLICT") count += 1;
      }
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  } finally {
    reader.close();
  }
  return count;
}

function claimStatus(item: string): string | undefined {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return readWorkClaimLedger(reader, PROJECT).claims.get(item)?.status;
  } finally {
    reader.close();
  }
}

/**
 * `refusal()` in daemon-command-dispatch.ts builds `{outcome: "REFUSED", refusal}`, and the
 * command adapter both wires share re-wraps it as `PORT_REFUSED` with the dispatch stage before
 * it reaches a caller. `PORT_REFUSED` is therefore what a REAL seat reads off the MCP wire, and
 * it is what these arms assert; the inner literal is never observable from out here.
 */
function refusalOf(answer: Answer): Refusal {
  if (answer.outcome !== REFUSED_OUTCOME || answer.refusal === undefined) {
    throw new Error(`expected a refused frame, got ${answer.outcome}`);
  }
  expect(answer.stage).toBe("DISPATCH");
  return answer.refusal;
}

describe("expected-version conflicts on the MCP command wire", () => {
  it("names the expected AND the observed version in the refusal detail", async () => {
    const item = "node.deliver@mcp-conflict-wire";
    expect(await claim(item, 0)).toMatchObject({ outcome: "ACCEPTED" });

    const refusal = refusalOf(await release(item, 0));
    expect(refusal.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(refusal.layer).toBe("DURABLE_STORE");
    // The exact string, not a pattern: the seat parses this, so the vocabulary is pinned.
    // `actualVersion=1` is the head the claim left behind; `expectedVersion=0` is what was sent.
    expect(refusal.detail).toBe("EXPECTED_VERSION_CONFLICT actualVersion=1 expectedVersion=0");
    // The refused frame's key roster does not move — the versions ride in the existing string.
    expect(Object.keys(refusal).sort()).toEqual(["code", "detail", "httpStatus", "layer"]);
  });

  it("lets a seat that reads the observed version release on ONE retry", async () => {
    const item = "node.deliver@mcp-conflict-seat";
    expect(await claim(item, 0)).toMatchObject({ outcome: "ACCEPTED" });

    // The scripted seat: exactly what the mission text will tell a real seat to do. It sends
    // one command, and on a conflict resends that SAME command once at the named version.
    const first = await release(item, 0);
    const refusal = refusalOf(first);
    expect(refusal.code).toBe("EXPECTED_VERSION_CONFLICT");
    const observed = /actualVersion=(\d+)/.exec(refusal.detail);
    if (observed === null) throw new Error("the refusal detail named no observed version");
    const retried = await release(item, Number(observed[1]));

    expect(retried.outcome).not.toBe(REFUSED_OUTCOME);
    expect(retried).toMatchObject({ outcome: "ACCEPTED" });
    expect(claimStatus(item)).toBe("RELEASED");
    // ONE planted conflict, one retry, one rejection row. Nothing was written while guessing.
    expect(rejectionCount(item)).toBe(1);
  });

  it("records one rejection per blind guess when the seat ignores the observed version", async () => {
    const item = "node.deliver@mcp-conflict-blind";
    expect(await claim(item, 0)).toMatchObject({ outcome: "ACCEPTED" });

    // The NEGATIVE CONTROL — the live failure shape this row was filed for. A seat that does
    // not read the detail guesses, and EVERY guess that misses the head is a durable rejection
    // row. Without this arm, "exactly one record" above could not discriminate: an assertion
    // that cannot go up is not measuring anything.
    const seen: string[] = [];
    const guesses = [2, 3, 4, 5, 6, 7, 8];
    for (const guess of guesses) {
      seen.push((await release(item, guess)).outcome);
    }

    // The head sits at 1 and no guess is 1, so all seven are refused and the claim never leaves
    // OPEN — one wasted durable decision per guess, which is what the live seat produced.
    expect(seen).toEqual(guesses.map(() => REFUSED_OUTCOME));
    expect(rejectionCount(item)).toBe(guesses.length);
    expect(claimStatus(item)).toBe("OPEN");
  });
});
