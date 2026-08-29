import type { CommandReceipt, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  IMPORT_GENERATION_READ_LAYER,
  IMPORT_GENERATION_REFUSAL_CODES,
} from "./import-generation-reader.js";
import type {
  ImportGenerationRead,
  ImportGenerationStorePort,
} from "./import-generation-reader.js";
import { readDurableImportGeneration } from "./import-generation-reader.js";
import { IMPORT_SHADOW_READ_LAYER } from "./import-shadow-contracts.js";
import {
  DIGEST,
  aggregateOf,
  capturedCommit,
  commitRaw,
  recordOf,
  seedImport,
  withStore,
  witness,
} from "./import-shadow-test-fixtures.js";

/**
 * task-f25077c5 - the durable import-generation digest.
 *
 * WHAT IS UNDER TEST IS WHICH DURABLE FACT IS RETURNED, not merely that something is.
 * `importGenerationSha256` is the store's own `CommandReceipt.effectSha256` for the committed
 * legacy import - the verified import HEAD. It is deliberately NOT the `SourceManifest`
 * digest, which names the locked INPUT and is only ever a locator here. Every accepted arm
 * therefore compares against a receipt read independently out of production's own store API,
 * and additionally asserts the answer differs from the manifest suffix, so a reader that
 * returned the locator would red rather than look plausible.
 *
 * WHICH LAYER ANSWERED IS ITSELF AN ASSERTION. Three layers can refuse on this path:
 * `@moe/import`'s decoder at `DECODE`, the existing shadow adapter at `DAEMON_IMPORT_SHADOW`,
 * and this reader at `DAEMON_IMPORT_GENERATION`. A test asserting only `ok === false` would
 * stay green if this reader started restamping an upstream diagnosis as its own, or if a
 * downstream fence quietly began answering for a guard that was loosened. Every arm below
 * pins the exact code AND the exact layer.
 *
 * The caller supplies NOTHING. There is no locator, no digest, no aggregate id and no
 * "current" selector in the request vocabulary, because a caller-presented generation would
 * make the cutover drift check compare a value against itself.
 */

const OTHER_DIGEST = "b".repeat(64);

/** Overrides exactly one method of a real store, leaving every other answer production's. */
function portOver(
  store: ImportGenerationStorePort,
  over: Partial<ImportGenerationStorePort>,
): ImportGenerationStorePort {
  return {
    enumerateAggregateIdsByPrefix: (prefix: string) =>
      store.enumerateAggregateIdsByPrefix(prefix),
    getCommandReceipt: (commandId: string) => store.getCommandReceipt(commandId),
    readEventHorizon: () => store.readEventHorizon(),
    readEvents: (aggregateId: string) => store.readEvents(aggregateId),
    ...over,
  };
}

function refused(read: ImportGenerationRead): Extract<ImportGenerationRead, { ok: false }> {
  if (read.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(read)}`);
  }
  // A refusal carries no digest field at all, so a zero-filled or empty-string generation is
  // unrepresentable rather than merely unproduced. Two zero-filled generations compare EQUAL,
  // which would make the cutover drift comparison vacuous while still looking answered.
  expect(Object.hasOwn(read, "importGenerationSha256")).toBe(false);
  expect(read.detail.length).toBeGreaterThan(0);
  return read;
}

/** The receipt production itself recorded, read back through the store's own public API. */
function productionReceiptOf(store: ImportGenerationStorePort, digest: string): CommandReceipt {
  const events = store.readEvents(aggregateOf(digest));
  const [first] = events;
  if (first === undefined) throw new Error("no committed import to read a receipt for");
  const receipt = store.getCommandReceipt(first.commandId);
  if (receipt === null) throw new Error("production committed without a receipt");
  return receipt;
}

describe("durable import generation - the declared refusal vocabulary", () => {
  it("declares exactly the seven codes this reader can answer with", () => {
    expect([...IMPORT_GENERATION_REFUSAL_CODES]).toEqual([
      "IMPORT_GENERATION_ABSENT",
      "IMPORT_GENERATION_AMBIGUOUS",
      "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
      "IMPORT_GENERATION_HORIZON_DRIFT",
      "IMPORT_GENERATION_INPUT_INVALID",
      "IMPORT_GENERATION_RECEIPT_ABSENT",
      "IMPORT_GENERATION_RECEIPT_MISMATCH",
    ]);
    expect(Object.isFrozen(IMPORT_GENERATION_REFUSAL_CODES)).toBe(true);
    expect(IMPORT_GENERATION_READ_LAYER).toBe("DAEMON_IMPORT_GENERATION");
    // The reader must be distinguishable from the adapter it composes, or "forwarded
    // unchanged" and "restamped locally" would be the same observation.
    expect(IMPORT_GENERATION_READ_LAYER).not.toBe(IMPORT_SHADOW_READ_LAYER);
  });
});

describe("durable import generation - ACCEPTED", () => {
  it("returns the committed receipt effect digest, not the source manifest locator", () => {
    withStore((store, path) => {
      seedImport(store, DIGEST, [recordOf()]);
      const receipt = productionReceiptOf(store, DIGEST);

      const read = readDurableImportGeneration(store, {});

      expect(read).toEqual({ ok: true, importGenerationSha256: receipt.effectSha256 });
      // Pins WHICH durable notion was chosen. Returning the manifest suffix would satisfy
      // "64 lowercase hex" and every shape check, and would still be the wrong fact.
      expect(receipt.effectSha256).not.toBe(DIGEST);
      expect(read.ok && read.importGenerationSha256).not.toBe(DIGEST);
      expect(Object.isFrozen(read)).toBe(true);

      const before = witness(store, path, aggregateOf(DIGEST));
      const again = readDurableImportGeneration(store, {});
      const after = witness(store, path, aggregateOf(DIGEST));

      expect(again).toEqual(read);
      expect(after.events).toBe(before.events);
      expect(after.decisions).toBe(before.decisions);
      expect(after.version).toBe(before.version);
    });
  });
});

describe("durable import generation - the caller supplies nothing", () => {
  it("refuses a caller-presented generation digest at this reader's own layer", () => {
    withStore((store) => {
      // The store is fully valid and would otherwise ACCEPT. Only the request differs, so a
      // loosened input guard cannot hide behind a downstream import or receipt fence: every
      // one of them passes here, and the call would accept the caller's own bytes.
      seedImport(store, DIGEST, [recordOf()]);
      expect(readDurableImportGeneration(store, {}).ok).toBe(true);

      const read = refused(
        readDurableImportGeneration(store, { importGenerationSha256: "f".repeat(64) }),
      );

      expect(read.code).toBe("IMPORT_GENERATION_INPUT_INVALID");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("refuses any other request key, a non-plain request, and a revoked proxy", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const revoked = Proxy.revocable<Record<string, unknown>>({}, {});
      revoked.revoke();
      const hostile: readonly unknown[] = [
        { manifestDigest: DIGEST },
        { aggregateId: aggregateOf(DIGEST) },
        { current: true },
        null,
        undefined,
        "current",
        [],
        revoked.proxy,
      ];
      // A sweep that silently produced zero cases would pass while testing nothing.
      expect(hostile.length).toBe(8);

      for (const request of hostile) {
        const read = refused(readDurableImportGeneration(store, request));
        expect(read.code).toBe("IMPORT_GENERATION_INPUT_INVALID");
        expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
      }
    });
  });
});

describe("durable import generation - absence refuses, it does not default", () => {
  it("refuses an empty store rather than answering with zeroes or an empty string", () => {
    withStore((store) => {
      const read = refused(readDurableImportGeneration(store, {}));

      expect(read.code).toBe("IMPORT_GENERATION_ABSENT");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
      expect(read.detail).toContain("legacy-import:");
    });
  });

  it("refuses two committed imports rather than electing one without authority", () => {
    withStore((store) => {
      // Both candidates are seeded through production applyImport and both pass their own
      // import and receipt validation, so this is genuine ambiguity and not one corrupt
      // candidate masquerading as it.
      seedImport(store, DIGEST, [recordOf()]);
      seedImport(store, OTHER_DIGEST, [recordOf()]);
      expect(productionReceiptOf(store, DIGEST).effectSha256).not.toBe(
        productionReceiptOf(store, OTHER_DIGEST).effectSha256,
      );

      const read = refused(readDurableImportGeneration(store, {}));

      expect(read.code).toBe("IMPORT_GENERATION_AMBIGUOUS");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });
});

describe("durable import generation - the receipt must bind the events it names", () => {
  it("refuses a missing receipt without falling through to absent", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const blind = portOver(store, { getCommandReceipt: () => null });

      const read = refused(readDurableImportGeneration(blind, {}));

      expect(read.code).toBe("IMPORT_GENERATION_RECEIPT_ABSENT");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("refuses a receipt whose binding disagrees with the durable events", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const honest = productionReceiptOf(store, DIGEST);
      const detached = portOver(store, {
        // Everything else about this receipt is production's, including its effect digest.
        // Only the aggregate it claims differs, so a reader that read the scalar without
        // joining it to the event roster would return a genuine-looking foreign identity.
        getCommandReceipt: () => ({ ...honest, aggregateId: aggregateOf(OTHER_DIGEST) }),
      });

      const read = refused(readDurableImportGeneration(detached, {}));

      expect(read.code).toBe("IMPORT_GENERATION_RECEIPT_MISMATCH");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("refuses a receipt whose event roster is not the aggregate's own", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const honest = productionReceiptOf(store, DIGEST);
      const swapped = portOver(store, {
        getCommandReceipt: () => ({ ...honest, eventIds: [...honest.eventIds].reverse() }),
      });
      expect(honest.eventIds.length).toBeGreaterThan(0);

      const read = refused(
        readDurableImportGeneration(
          honest.eventIds.length > 1
            ? swapped
            : portOver(store, { getCommandReceipt: () => ({ ...honest, currentVersion: 99 }) }),
          {},
        ),
      );

      expect(read.code).toBe("IMPORT_GENERATION_RECEIPT_MISMATCH");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });
});

describe("durable import generation - the store's own failures stay legible", () => {
  it("refuses an enumeration that throws as unreadable, never as absent", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const broken = portOver(store, {
        enumerateAggregateIdsByPrefix: () => {
          throw new Error("database is locked");
        },
      });

      const read = refused(readDurableImportGeneration(broken, {}));

      expect(read.code).toBe("IMPORT_GENERATION_EVIDENCE_UNREADABLE");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("refuses an enumeration answering with a non-list as unreadable, never as absent", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const shapeless = portOver(store, {
        enumerateAggregateIdsByPrefix: () => "legacy-import:" as unknown as readonly string[],
      });

      const read = refused(readDurableImportGeneration(shapeless, {}));

      expect(read.code).toBe("IMPORT_GENERATION_EVIDENCE_UNREADABLE");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("refuses an enumerated id outside legacy-import:<64 hex> instead of skipping it", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const real = store.enumerateAggregateIdsByPrefix("legacy-import:");
      expect(real).toEqual([aggregateOf(DIGEST)]);
      const smuggled = portOver(store, {
        // Skipping an unreadable sibling rather than refusing would let a SECOND committed
        // import hide behind it: the scan would see one validated candidate and answer
        // confidently where the honest answer is that the evidence cannot be read.
        enumerateAggregateIdsByPrefix: () => [...real, "legacy-import:not-a-digest"],
      });

      const read = refused(readDurableImportGeneration(smuggled, {}));

      expect(read.code).toBe("IMPORT_GENERATION_EVIDENCE_UNREADABLE");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
      expect(read.code).not.toBe("IMPORT_GENERATION_AMBIGUOUS");
    });
  });

  it("refuses a horizon that moved after the candidate settled, not across two states", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      // Models the real race this reader's final horizon re-read exists to fence: an append
      // lands AFTER the candidate has been fully validated but BEFORE the read settles.
      //
      // The drift is triggered off getCommandReceipt rather than off a call counter because
      // getCommandReceipt is reached only by this reader, and only once the composed shadow
      // validator has already opened AND closed its own horizon window. That ordering is what
      // makes this reader's fence the only one that can answer. A fixture that moved the
      // horizon on every call would instead trip the shadow adapter's identical upstream
      // fence, and this arm would silently be testing that layer rather than this one.
      let appended = false;
      let receiptReads = 0;
      const racing = portOver(store, {
        getCommandReceipt: (commandId: string) => {
          receiptReads += 1;
          appended = true;
          return store.getCommandReceipt(commandId);
        },
        readEventHorizon: () => store.readEventHorizon() + (appended ? 1n : 0n),
      });

      const read = refused(readDurableImportGeneration(racing, {}));

      expect(read.code).toBe("IMPORT_GENERATION_HORIZON_DRIFT");
      expect(read.layer).toBe(IMPORT_GENERATION_READ_LAYER);
      expect(read.layer).not.toBe(IMPORT_SHADOW_READ_LAYER);
      // Proves the candidate really did validate before the drift was injected, so this is
      // the settle-time fence and not an early bail dressed up as one.
      expect(receiptReads).toBe(1);
    });
  });
});

describe("durable import generation - upstream diagnoses are forwarded, not restamped", () => {
  it("forwards the shadow adapter's code AND layer when provenance names another import", () => {
    withStore((store) => {
      // Production-encoded bytes whose persisted manifest provenance alone disagrees with the
      // aggregate carrying them. The composed shadow validator is the only fence that can
      // answer, because it runs before this reader reads events or receipts.
      const foreign = capturedCommit(OTHER_DIGEST, [recordOf()]);
      commitRaw(store, { ...foreign, aggregateId: aggregateOf(DIGEST) });

      const read = refused(readDurableImportGeneration(store, {}));

      expect(read.code).toBe("IMPORT_SHADOW_BINDING_MISMATCH");
      // The DELEGATE's layer. This reader's own layer here would mean it had swallowed the
      // finer upstream diagnosis and replaced it with a coarser local one.
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(read.layer).not.toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });

  it("forwards a malformed event sequence as the shadow adapter's own diagnosis", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [
        recordOf(),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const holed = portOver(store, {
        readEvents: (aggregateId: string) =>
          store
            .readEvents(aggregateId)
            .map((event: StoredEvent) => ({
              ...event,
              aggregateSequence: event.aggregateSequence + 1,
            })),
      });

      const read = refused(readDurableImportGeneration(holed, {}));

      expect(read.code).toBe("IMPORT_SHADOW_EVIDENCE_MALFORMED");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(read.layer).not.toBe(IMPORT_GENERATION_READ_LAYER);
    });
  });
});
