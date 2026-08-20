/**
 * The strict runtime-observation reader, graded against durable records only.
 *
 * Every accepted case drives the PRODUCTION `project.register` -> `provider.probe` path; every
 * corrupt case is planted through the STORE's own commit API rather than by editing a row the
 * production writer would never have produced in that shape. The refusal assertions pin the
 * literal code and the literal layer, and the UNREADABLE arms pin the UPSTREAM code as well —
 * a reader that swallowed the codec's answer would still look like it refused.
 */

import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, decisionCount, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentRuntimeObservation } from "./provider-runtime-observation-reader.js";
import type {
  ProviderRuntimeObservationRecord,
  ProviderRuntimeObservationUnknown,
} from "./provider-runtime-observation-reader.js";
import {
  CODEC_LAYER,
  READER_LAYER,
  REVISION_ID,
  accepted,
  closeForeignStores,
  plantProbe,
  probeFor,
  probedEvents,
  registeredStore,
  runtimeSection,
  unknownTruthSection,
  validDraft,
} from "./provider-runtime-observation-test-fixtures.js";
import type { Json } from "./provider-runtime-observation-test-fixtures.js";

type Store = Parameters<typeof probedEvents>[0];

afterAll(() => {
  closeForeignStores();
  closeStores();
});

function readRecord(
  store: Store,
  projectId = PROJECT_ID,
  revisionId = REVISION_ID,
): ProviderRuntimeObservationRecord {
  const result = readCurrentRuntimeObservation(store, projectId, revisionId);
  if (!result.ok) throw new Error(`expected an observation, got ${result.code}`);
  return result;
}

function readRefusal(
  store: Store,
  projectId = PROJECT_ID,
  revisionId = REVISION_ID,
): ProviderRuntimeObservationUnknown {
  const result = readCurrentRuntimeObservation(store, projectId, revisionId);
  if (result.ok) throw new Error("expected the reader to refuse, got an observation");
  return result;
}

/** The legacy sections of the probe on record, so a plant only replaces the runtime half. */
function legacySections(store: Store): Json {
  const [event] = probedEvents(store);
  if (event === undefined) throw new Error("fixture expected a probe on record");
  return {
    profile: event.profile,
    profileDigest: event.profileDigest,
    providerMinimumProfileRef: event.providerMinimumProfileRef,
    truthClass: event.truthClass,
  };
}

describe("readCurrentRuntimeObservation", () => {
  it("returns the current observation bound to project and probe identity", () => {
    const store = registeredStore();
    const sent = accepted(send(store, probeFor())).runtime;
    const record = readRecord(store);
    expect(record.profileRevisionId).toBe(REVISION_ID);
    expect(record.probeTruthClass).toBe("DAEMON_VERIFIED");
    expect(record.observation as unknown as Json).toEqual(sent);
  });

  it("reads ABSENT for a legacy probe that carries no observation section", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({ runtime: null })));
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_ABSENT");
    expect(refusal.layer).toBe(READER_LAYER);
    expect(refusal.authority).toBe("NONE");
    expect(refusal.outcome).toBe("UNKNOWN");
    expect(refusal.upstream).toBeNull();
  });

  it("reads ABSENT when the project has no probe at all", () => {
    const store = registeredStore();
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_ABSENT");
    expect(refusal.layer).toBe(READER_LAYER);
  });

  it("reads UNREADABLE for a tampered digest, preserving the CODEC's upstream code", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    plantProbe(
      store,
      { ...legacySections(store), runtime: { ...runtimeSection(), observationDigest: "0a".repeat(32) } },
      "provider-probed-tampered",
    );
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE");
    expect(refusal.layer).toBe(READER_LAYER);
    expect(refusal.upstream).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_DIGEST_MISMATCH",
      layer: CODEC_LAYER,
    });
  });

  it("reads UNREADABLE for a tampered closure, whose digest no longer recomputes", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    const swapped = {
      ...runtimeSection(),
      resolvedRuntimeClosure: [
        { kind: "EXECUTABLE", path: "/opt/claude/bin/claude", sha256: "ff".repeat(32) },
      ],
    };
    plantProbe(store, { ...legacySections(store), runtime: swapped }, "provider-probed-closure");
    expect(readRefusal(store).upstream).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_DIGEST_MISMATCH",
      layer: CODEC_LAYER,
    });
  });

  it("reads UNREADABLE for a section stored in a NON-CANONICAL key order", () => {
    // The facts are untouched and every one of them decodes, so the codec's own canonicality
    // arm cannot see this: the reader re-canonicalises before decoding. What gives the row away
    // is that the production writer persists the encoder's own output, so a differently ordered
    // row was hand-written and must not acquire the standing of one the probe seam produced.
    const store = registeredStore();
    accepted(send(store, probeFor()));
    const section = runtimeSection();
    const shuffled: Json = {};
    for (const key of Object.keys(section).reverse()) shuffled[key] = section[key];
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(section));
    plantProbe(store, { ...legacySections(store), runtime: shuffled }, "provider-probed-order");

    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE");
    expect(refusal.layer).toBe(READER_LAYER);
    // The CODEC accepted it — this refusal is the reader's own, so `upstream` stays null.
    expect(refusal.upstream).toBeNull();
    expect(refusal.detail).toContain("canonical encoding");
  });

  it("reads UNREADABLE when the planted section is not a record at all", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    plantProbe(store, { ...legacySections(store), runtime: "not-a-record" }, "provider-probed-shape");
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE");
    expect(refusal.upstream).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });

  it("reads UNREADABLE when the planted probe lost its profile identity", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    plantProbe(
      store,
      { ...legacySections(store), profile: "gone", runtime: runtimeSection() },
      "provider-probed-identityless",
    );
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE");
    expect(refusal.detail).toContain("identity");
  });

  it("refuses IDENTITY_MISMATCH when the caller names a different probe identity", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    const refusal = readRefusal(store, PROJECT_ID, "profile-revision-9");
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH");
    expect(refusal.layer).toBe(READER_LAYER);
    expect(refusal.detail).toContain("profile-revision-9");
    expect(refusal.detail).toContain(REVISION_ID);
  });

  it("binds to project AND identity: another project's probe never answers for this one", () => {
    const own = registeredStore();
    accepted(send(own, probeFor()));
    const foreign = registeredStore("project-2");
    accepted(
      send(foreign, {
        ...probeFor({ profile: validDraft("profile-revision-2") }),
        projectId: "project-2",
      }),
    );

    // The foreign store DOES hold a probe, so an ABSENT answer would prove nothing here: the
    // reader has to refuse on the identity it was actually asked for.
    expect(probedEvents(foreign, "project-2-provider").length).toBe(1);
    expect(readRefusal(foreign, "project-2", REVISION_ID).code)
      .toBe("PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH");
    expect(readRecord(foreign, "project-2", "profile-revision-2").profileRevisionId)
      .toBe("profile-revision-2");
    // And a project this store never held is ABSENT, not somebody else's answer.
    expect(readRefusal(own, "project-2", REVISION_ID).code)
      .toBe("PROVIDER_RUNTIME_OBSERVATION_ABSENT");
  });

  it("carries BOTH truth classes verbatim and upgrades neither", () => {
    const store = registeredStore();
    accepted(
      send(store, probeFor({ runtime: unknownTruthSection(), truthClass: "AGENT_REPORTED" })),
    );
    const record = readRecord(store);
    expect(record.probeTruthClass).toBe("AGENT_REPORTED");
    expect(record.observation.truthClass).toBe("UNKNOWN");
    expect(record.observation.pinningMethod).toBe("UNSUPPORTED");
    // Weak truth reads back — it is evidence. Nothing here grants it launch authority, and the
    // resolver's strong-truth gate stays the only filter that does.
    expect(["DAEMON_VERIFIED", "HUMAN_APPROVED"]).not.toContain(record.probeTruthClass);
  });

  it("leaves the durable decision count and the event stream unchanged on every read", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    const before = decisionCount(store);
    readRecord(store);
    readRefusal(store, PROJECT_ID, "profile-revision-9");
    readCurrentRuntimeObservation(store, "project-absent", REVISION_ID);
    expect(decisionCount(store)).toBe(before);
    expect(probedEvents(store).length).toBe(1);
  });

  it("answers the LATEST probe, not the first one on the stream", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({ commandId: "probe-1" })));
    accepted(
      send(
        store,
        probeFor({
          commandId: "probe-2",
          expectedVersion: 1,
          profile: validDraft("profile-revision-2"),
          runtime: runtimeSection({ closureSha: "d4".repeat(32) }),
        }),
      ),
    );
    expect(readRefusal(store).code).toBe("PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH");
    const record = readRecord(store, PROJECT_ID, "profile-revision-2");
    expect(record.observation.resolvedRuntimeClosure[0]?.sha256).toBe("d4".repeat(32));
  });

  it("rejects an envelope-truth-less probe rather than answering with a blank class", () => {
    const store = registeredStore();
    accepted(send(store, probeFor()));
    plantProbe(
      store,
      { ...legacySections(store), runtime: runtimeSection(), truthClass: "" },
      "provider-probed-truthless",
    );
    const refusal = readRefusal(store);
    expect(refusal.code).toBe("PROVIDER_RUNTIME_OBSERVATION_UNREADABLE");
    expect(refusal.detail).toContain("envelope truth");
  });
});
