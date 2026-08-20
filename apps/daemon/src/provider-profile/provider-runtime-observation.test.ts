/**
 * The observation ADMISSION seam: what `provider.probe` will accept as a runtime observation,
 * whose digest ends up on the durable row, and what the whole-history immutability rule does
 * once a section is on record.
 *
 * Every case drives the PRODUCTION pipeline — `project.register` then `provider.probe` through
 * `runBootstrapCommand` against a real `SqliteEventStore`. Refusal assertions pin the LITERAL
 * code and the LITERAL layer rather than an imported constant: a test that imports the constant
 * it asserts still passes after that constant is renamed out from under every consumer, and
 * three different layers can answer on this seam.
 */

import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { MAX_OBSERVATION_BYTES } from "./provider-runtime-observation-fields.js";
import { readCurrentRuntimeObservation } from "./provider-runtime-observation-reader.js";
import { encodeProviderRuntimeObservationBytes } from "./provider-runtime-observation.js";
import type { ProviderRuntimeObservation } from "./provider-runtime-observation.js";
import {
  CODEC_LAYER,
  READER_LAYER,
  REGISTRATION_LAYER,
  REVISION_ID,
  accepted,
  closeForeignStores,
  omit,
  plantProbe,
  probeFor,
  probedEventText,
  probedEvents,
  refused,
  registeredStore,
  runtimeSection,
  sizedRuntimeSection,
  validDraft,
} from "./provider-runtime-observation-test-fixtures.js";
import type { Json } from "./provider-runtime-observation-test-fixtures.js";

afterAll(() => {
  closeForeignStores();
  closeStores();
});

function observationOf(store: Parameters<typeof probedEvents>[0]): Json {
  const result = readCurrentRuntimeObservation(store, PROJECT_ID, REVISION_ID);
  if (!result.ok) throw new Error(`expected an observation, got ${result.code}`);
  return result.observation as unknown as Json;
}

describe("provider.probe — runtime observation admission", () => {
  it("persists the admitted observation beside the profile, as a fifth section", () => {
    const store = registeredStore();
    const sent = runtimeSection();
    const result = accepted(send(store, probeFor()));

    expect(result.runtime).toEqual(sent);
    const events = probedEvents(store);
    expect(events.length).toBe(1);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      "profile", "profileDigest", "providerMinimumProfileRef", "runtime", "truthClass",
    ]);
    expect(events[0]?.runtime).toEqual(sent);

    const observation = observationOf(store);
    expect(observation.observationVersion).toBe("moe-claude-runtime-observation/1");
    expect(observation.providerId).toBe("claude");
    expect(observation.reportedVersion).toBe("2.0.14");
    expect(observation.adapterCapabilitySchemaDigest).toBe("a1".repeat(32));
    expect(observation.pinningMethod).toBe("CONTENT_ADDRESSED_COPY");
    expect(observation.platformIdentity).toEqual({
      arch: "x64", os: "win32", osVersion: "10.0.26200",
    });
    expect(observation.freshness).toEqual({ observedAt: "2026-08-20T00:00:00.000Z" });
    expect(observation.resolvedRuntimeClosure).toEqual([
      { kind: "EXECUTABLE", path: "/opt/claude/bin/claude", sha256: "b2".repeat(32) },
    ]);
  });

  it("stamps the SERVER's digest over the admitted body, never the caller's word for it", () => {
    const store = registeredStore();
    const sent = runtimeSection();
    // Acceptance alone cannot show whose digest landed, because a correct caller digest and a
    // recomputed one are the same string. What separates them is that a WRONG caller digest
    // refuses (next case) while the persisted value still equals the recomputation here.
    const persisted = (accepted(send(store, probeFor())).runtime as Json).observationDigest;
    expect(persisted).toBe(sent.observationDigest);
    expect(String(persisted)).toMatch(/^[0-9a-f]{64}$/u);
    expect(observationOf(store).observationDigest).toBe(persisted);
  });

  it("refuses a caller-supplied observationDigest that does not recompute, at the codec", () => {
    const store = registeredStore();
    const forged = { ...runtimeSection(), observationDigest: "f0".repeat(32) };
    expect(refused(send(store, probeFor({ runtime: forged })))).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_DIGEST_MISMATCH",
      refusedBy: CODEC_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
  });

  it("refuses an unsupported observationVersion at the codec, under its own code", () => {
    const store = registeredStore();
    const stale = { ...runtimeSection(), observationVersion: "moe-claude-runtime-observation/0" };
    expect(refused(send(store, probeFor({ runtime: stale })))).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_VERSION_UNSUPPORTED",
      refusedBy: CODEC_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
  });

  const HOSTILE_SECTIONS: readonly { readonly label: string; readonly value: unknown }[] =
    Object.freeze([
      { label: "unknown extra key", value: { ...runtimeSection(), attacker: "yes" } },
      { label: "missing platformIdentity", value: omit(runtimeSection(), "platformIdentity") },
      { label: "missing observationDigest", value: omit(runtimeSection(), "observationDigest") },
      { label: "wrong providerId", value: { ...runtimeSection(), providerId: "codex" } },
      { label: "unknown pinningMethod", value: { ...runtimeSection(), pinningMethod: "MAGIC" } },
      { label: "unknown truthClass", value: { ...runtimeSection(), truthClass: "MOSTLY" } },
      { label: "closure not an array", value: { ...runtimeSection(), resolvedRuntimeClosure: {} } },
      {
        label: "closure entry with a non-hex sha256",
        value: {
          ...runtimeSection(),
          resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "/a", sha256: "nope" }],
        },
      },
      {
        label: "closure entry with an unknown kind",
        value: {
          ...runtimeSection(),
          resolvedRuntimeClosure: [{ kind: "ORACLE", path: "/a", sha256: "b2".repeat(32) }],
        },
      },
      {
        label: "closure paths out of canonical order",
        value: {
          ...runtimeSection(),
          resolvedRuntimeClosure: [
            { kind: "EXECUTABLE", path: "/b", sha256: "b2".repeat(32) },
            { kind: "EXECUTABLE", path: "/a", sha256: "b2".repeat(32) },
          ],
        },
      },
      {
        label: "duplicate closure path",
        value: {
          ...runtimeSection(),
          resolvedRuntimeClosure: [
            { kind: "EXECUTABLE", path: "/a", sha256: "b2".repeat(32) },
            { kind: "PACKAGE", path: "/a", sha256: "c3".repeat(32) },
          ],
        },
      },
      {
        label: "non-instant freshness",
        value: { ...runtimeSection(), freshness: { observedAt: "yesterday" } },
      },
      {
        label: "reportedVersion wrapped in a record",
        value: { ...runtimeSection(), reportedVersion: { text: "2.0.14" } },
      },
      { label: "section is an array", value: [] },
      { label: "section is a string", value: "runtime" },
      { label: "section is null", value: undefined },
    ]);

  it("sweeps a non-empty hostile section table", () => {
    // A generated table that silently produced zero rows would pass while testing nothing.
    expect(HOSTILE_SECTIONS.length).toBeGreaterThan(12);
  });

  it.each(HOSTILE_SECTIONS)("refuses $label at the codec", ({ label, value }) => {
    const store = registeredStore();
    // `section is null` sends a literal JSON null, which the envelope keeps as a present key.
    const runtime = (label === "section is null" ? null : value) as Json;
    const probe = probeFor(label === "section is null" ? {} : { runtime });
    if (label === "section is null") {
      (probe.payload.observation as Json).runtime = null;
    }
    expect(refused(send(store, probe))).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_INPUT_INVALID",
      refusedBy: CODEC_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
  });

  it("re-probing identical content is byte-stable, observation included", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({ commandId: "probe-1" })));
    accepted(send(store, probeFor({ commandId: "probe-2", expectedVersion: 1 })));
    const text = probedEventText(store);
    expect(text.length).toBe(2);
    expect(text[1]).toBe(text[0]);
  });

  it("refuses the same profileRevisionId carrying a DIFFERENT observation, at registration", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({ commandId: "probe-1" })));
    const drifted = runtimeSection({ closureSha: "c3".repeat(32) });
    expect(
      refused(
        send(store, probeFor({ commandId: "probe-2", expectedVersion: 1, runtime: drifted })),
      ),
    ).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(1);
  });

  it("refuses an observation rebound after an INTERVENING probe, at registration", () => {
    // Immutability is a claim about the whole durable history. Comparing only the previous
    // probe lets one interleaved probe under a different identity launder a rebind: identity 1
    // leaves the comparison window and comes back carrying a different observation.
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
    expect(
      refused(
        send(
          store,
          probeFor({
            commandId: "probe-3",
            expectedVersion: 2,
            runtime: runtimeSection({ closureSha: "e5".repeat(32) }),
          }),
        ),
      ),
    ).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    // A length check alone cannot tell a refused rebind from one committed over the top of the
    // earlier event, so the whole history's identity -> observation pairs are read back.
    expect(
      probedEvents(store).map((event) => {
        const profile = event.profile as Json;
        const closure = (event.runtime as Json).resolvedRuntimeClosure as { sha256: string }[];
        return `${String(profile.profileRevisionId)}:${closure[0]?.sha256 ?? ""}`;
      }),
    ).toEqual([
      `${REVISION_ID}:${"b2".repeat(32)}`,
      `profile-revision-2:${"d4".repeat(32)}`,
    ]);
  });

  it("refuses an identity that gains an observation it did not previously carry", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({ commandId: "probe-1", runtime: null })));
    expect(refused(send(store, probeFor({ commandId: "probe-2", expectedVersion: 1 })))).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(1);
  });

  it("keeps a legacy probe legal and adds no key when no section is sent", () => {
    const store = registeredStore();
    const result = accepted(send(store, probeFor({ runtime: null })));
    expect(Object.keys(result).sort()).toEqual([
      "profile", "profileDigest", "providerMinimumProfileRef", "truthClass",
    ]);
    expect(Object.keys(probedEvents(store)[0] ?? {}).sort()).toEqual([
      "profile", "profileDigest", "providerMinimumProfileRef", "truthClass",
    ]);
  });
});

/**
 * The DURABLE SIZE BOUND, exercised end to end on the production seam.
 *
 * The defect this closes: admission never measured the canonical bytes, while the read path did,
 * so `provider.probe` could accept and commit a genuine `@moe/runner` product that the strict
 * reader then refused as UNREADABLE. Evidence that cannot be read back is not evidence.
 *
 * The boundary is SEARCHED with the production encoder rather than hard-coded, so the pair is
 * "largest that fits" and "exactly one entry more" BY CONSTRUCTION, and a change to the record
 * shape moves both cases instead of silently turning one of them into a duplicate of the other.
 */
describe("provider runtime observation durable size bound", () => {
  /** The runner's own text ceiling. Not importable: it is not published from that package root. */
  const PATH_CHARS = 400;
  /** The runner's own closure ceiling; asking for more makes its builder refuse and throw. */
  const RUNNER_MAX_ENTRIES = 64;

  const bytesOf = (section: Json): number =>
    encodeProviderRuntimeObservationBytes(section as unknown as ProviderRuntimeObservation)
      .byteLength;

  function boundary(): { readonly fits: Json; readonly over: Json } {
    for (let entries = 1; entries < RUNNER_MAX_ENTRIES; entries += 1) {
      const over = sizedRuntimeSection(entries + 1, PATH_CHARS);
      if (bytesOf(over) > MAX_OBSERVATION_BYTES) {
        return { fits: sizedRuntimeSection(entries, PATH_CHARS), over };
      }
    }
    throw new Error("no canonical-byte boundary exists below the runner closure ceiling");
  }

  it("generates a real boundary pair that straddles the bound", () => {
    const { fits, over } = boundary();
    expect(bytesOf(fits)).toBeLessThanOrEqual(MAX_OBSERVATION_BYTES);
    expect(bytesOf(over)).toBeGreaterThan(MAX_OBSERVATION_BYTES);
    expect(bytesOf(over)).toBeGreaterThan(bytesOf(fits));
  });

  it("accepts the largest runner product that fits and reads it back byte-identical", () => {
    const store = registeredStore();
    const { fits } = boundary();
    accepted(send(store, probeFor({ runtime: fits })));
    const read = readCurrentRuntimeObservation(store, PROJECT_ID, REVISION_ID);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`the at-limit control was refused: ${read.code}`);
    expect(JSON.parse(JSON.stringify(read.observation))).toEqual(fits);
    expect(probedEvents(store).length).toBe(1);
  });

  it("refuses one entry more at the codec, before anything is committed", () => {
    const store = registeredStore();
    expect(refused(send(store, probeFor({ runtime: boundary().over })))).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_TOO_LARGE",
      refusedBy: CODEC_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
  });

  it("answers a planted oversized row with the same code, upstream of the reader", () => {
    const store = registeredStore();
    accepted(send(store, probeFor({})));
    const planted = probedEvents(store)[0] ?? {};
    plantProbe(store, { ...planted, runtime: boundary().over }, "event-oversized");
    const read = readCurrentRuntimeObservation(store, PROJECT_ID, REVISION_ID);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("a planted oversized row was read as evidence");
    expect({ code: read.code, layer: read.layer, upstream: read.upstream }).toEqual({
      code: "PROVIDER_RUNTIME_OBSERVATION_UNREADABLE",
      layer: READER_LAYER,
      upstream: { code: "PROVIDER_RUNTIME_OBSERVATION_TOO_LARGE", layer: CODEC_LAYER },
    });
  });
});
