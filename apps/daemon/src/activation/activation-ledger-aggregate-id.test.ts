import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEffectIntent } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { commitActivationLedgerRecord } from "./activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerCommitInput } from "./activation-ledger-contracts.js";
import { record } from "./activation-ledger-fixtures.js";

const HASH_PREFIX = "moe-activation-ledger/1|aggregate|sha256:";
const PROJECT_ID = "activation-aggregate-id-project";

const MAXIMUM_CASES = [
  {
    aggregateId: "a".repeat(400),
    expected: `${HASH_PREFIX}bdd4da6783d902fb5f8b32dd80ab9d6eb2ce872584cac2b7c03baa7bff881dc4`,
    idempotencyKey: "b".repeat(400),
    name: "ascii",
  },
  {
    aggregateId: "界".repeat(400),
    expected: `${HASH_PREFIX}c2c6dfeaf460969855dc3f31ef92ee3169ad2e3a04c38caa79f630cd4a9ffe42`,
    idempotencyKey: "é".repeat(400),
    name: "multibyte",
  },
] as const;

function parsedIntent(aggregateId: string, idempotencyKey: string, identity: string) {
  const fixture = record().effectIntent;
  const parsed = parseEffectIntent({
    ...fixture,
    aggregateId,
    idempotencyKey,
    intentId: `intent-${identity}`,
  });
  expect(parsed, `public parser rejected ${identity}`).not.toBeNull();
  if (parsed === null) throw new Error(`parseEffectIntent rejected ${identity}`);
  return parsed;
}

function commitInput(index: number, aggregateId: string, idempotencyKey: string): ActivationLedgerCommitInput {
  const identity = `maximum-${index}`;
  const fixture = record();
  const intent = parsedIntent(aggregateId, idempotencyKey, identity);
  const attemptId = `attempt-${identity}`;
  return {
    correlationId: `correlation-${identity}`,
    decidedAt: `2026-08-16T00:00:0${index}.000Z`,
    key: {
      commandId: `command-${identity}`,
      principalId: "principal-aggregate-id",
      projectId: PROJECT_ID,
    },
    record: record({
      attempt: { ...fixture.attempt, aggregateId, attemptId, intentId: intent.intentId },
      budgetReservation: {
        ...fixture.budgetReservation,
        attemptRef: attemptId,
        reservationId: `reservation-${identity}`,
      },
      effectIntent: intent,
      grant: {
        ...fixture.grant,
        grantId: `grant-${identity}`,
        intentId: intent.intentId,
        wrapperIdentity: `wrapper-${identity}`,
      },
      providerSlot: {
        ...fixture.providerSlot,
        attemptRef: attemptId,
        requestId: `request-${identity}`,
        slotRef: `slot-${identity}`,
      },
    }),
    requestBytes: new TextEncoder().encode(`activation-request-${identity}`),
  };
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-activation-aggregate-id-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("activation ledger aggregate identifiers", () => {
  it("preserves exactly two store-valid legacy identifiers", () => {
    const boundaryAggregate = "a".repeat(200);
    const boundaryKey = "b".repeat(269);
    const cases = [
      {
        actual: deriveActivationAggregateId("effect-aggregate-1", "idem-key-1"),
        expected: "moe-activation-ledger/1|aggregate|18:effect-aggregate-1|10:idem-key-1",
      },
      {
        actual: deriveActivationAggregateId(boundaryAggregate, boundaryKey),
        expected: `moe-activation-ledger/1|aggregate|200:${boundaryAggregate}|269:${boundaryKey}`,
      },
    ];

    expect(cases).toHaveLength(2);
    expect(Buffer.byteLength(cases[1]?.expected ?? "", "utf8")).toBe(512);
    for (const testCase of cases) {
      expect(testCase.actual).toBe(testCase.expected);
      expect(testCase.actual).not.toContain("|sha256:");
    }
  });

  it("hashes exactly two parser-admitted maximum pairs to stable framed vectors", () => {
    expect(MAXIMUM_CASES).toHaveLength(2);
    expect(MAXIMUM_CASES.map(({ aggregateId }) => aggregateId.length)).toEqual([400, 400]);
    expect(MAXIMUM_CASES.map(({ idempotencyKey }) => idempotencyKey.length)).toEqual([400, 400]);
    expect(MAXIMUM_CASES.map(({ aggregateId }) => aggregateId.normalize("NFC"))).toEqual(
      MAXIMUM_CASES.map(({ aggregateId }) => aggregateId),
    );
    expect(MAXIMUM_CASES.map(({ idempotencyKey }) => idempotencyKey.normalize("NFC"))).toEqual(
      MAXIMUM_CASES.map(({ idempotencyKey }) => idempotencyKey),
    );

    const derivedCases = MAXIMUM_CASES.map((testCase) => {
      const intent = parsedIntent(testCase.aggregateId, testCase.idempotencyKey, testCase.name);
      const derived = deriveActivationAggregateId(intent.aggregateId, intent.idempotencyKey);
      const aggregateVariant = parsedIntent(
        `${intent.aggregateId.slice(0, -1)}z`,
        intent.idempotencyKey,
        `${testCase.name}-aggregate-variant`,
      );
      const keyVariant = parsedIntent(
        intent.aggregateId,
        `${intent.idempotencyKey.slice(0, -1)}z`,
        `${testCase.name}-key-variant`,
      );
      return {
        derived,
        expected: testCase.expected,
        oneFieldVariants: [
          derived,
          deriveActivationAggregateId(aggregateVariant.aggregateId, aggregateVariant.idempotencyKey),
          deriveActivationAggregateId(keyVariant.aggregateId, keyVariant.idempotencyKey),
        ],
        repeated: deriveActivationAggregateId(intent.aggregateId, intent.idempotencyKey),
      };
    });
    expect(derivedCases).toHaveLength(2);
    for (const { derived, expected, oneFieldVariants, repeated } of derivedCases) {
      expect(derived).toBe(expected);
      expect(repeated).toBe(derived);
      expect(Buffer.byteLength(derived, "utf8")).toBeLessThanOrEqual(512);
      expect(derived).toMatch(/^moe-activation-ledger\/1\|aggregate\|sha256:[0-9a-f]{64}$/u);
      expect(oneFieldVariants).toHaveLength(3);
      expect(new Set(oneFieldVariants).size).toBe(3);
    }
  });

  it("keeps two swapped-length overflow identities distinct from bare concatenation", () => {
    const pairs = [
      {
        aggregateId: "x".repeat(399),
        expected: `${HASH_PREFIX}2f8707d26da0515f83b21cacee2e29ee339ed1c13a2f3bb3ac78e7bbabaee6a0`,
        idempotencyKey: "x".repeat(400),
      },
      {
        aggregateId: "x".repeat(400),
        expected: `${HASH_PREFIX}f5d4c1cb9d030deb779e5cfb34d55febee5c6193809c756a25116e9eea3fbcb5`,
        idempotencyKey: "x".repeat(399),
      },
    ];
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map(({ aggregateId, idempotencyKey }) => aggregateId + idempotencyKey)).size).toBe(1);

    const derived = pairs.map(({ aggregateId, expected, idempotencyKey }) => ({
      actual: deriveActivationAggregateId(aggregateId, idempotencyKey),
      expected,
    }));
    expect(derived).toHaveLength(2);
    for (const { actual, expected } of derived) {
      expect(actual).toBe(expected);
    }
    expect(new Set(derived.map(({ actual }) => actual)).size).toBe(2);
  });

  it("commits exactly two parser-admitted maximum identities through a reopened file store", () => {
    expect(MAXIMUM_CASES).toHaveLength(2);
    withDirectory((directory) => {
      const databasePath = join(directory, "store.sqlite");
      const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      let committed: { aggregateId: string; eventId: string }[] = [];
      try {
        const attempts = MAXIMUM_CASES.map((testCase, index) => ({
          eventId: `grant-maximum-${index}`,
          expected: testCase.expected,
          result: commitActivationLedgerRecord(
            store,
            commitInput(index, testCase.aggregateId, testCase.idempotencyKey),
          ),
        }));
        expect(attempts).toHaveLength(2);
        const outcomes = attempts.map(({ result }) => result.ok
          ? { ok: true as const }
          : {
              code: result.code,
              layer: result.layer,
              ok: false as const,
              outcome: result.outcome,
              storeCode: result.storeCode,
            });
        expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
        committed = attempts.map(({ eventId, expected, result }) => {
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error(`${result.code} at ${result.layer}`);
          expect(result.aggregateId).toBe(expected);
          return { aggregateId: result.aggregateId, eventId };
        });
      } finally {
        store.close();
      }

      const reopened = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      try {
        expect(committed).toHaveLength(2);
        for (const result of committed) {
          const events = reopened.readEvents(result.aggregateId);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            eventId: result.eventId,
            eventType: ACTIVATION_LEDGER_EVENT_TYPE,
          });
        }
      } finally {
        reopened.close();
      }
    });
  });
});
