import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import { readProjectRemote } from "./publish-ledger.js";
import { REMOTE_BOUND_EVENT_TYPE, REPOSITORY_PUBLISH_COMMAND_KIND, remoteAggregateId } from "./publish-receipt-contracts.js";
import { readRemoteDefaultBranch, recordRemoteDefaultBranch } from "./remote-default-branch.js";

afterEach(closeStores);

const A = "https://github.com/o/a.git";
const B = "git@github.com:o/b.git";
const T1 = "2026-09-18T12:00:00.000Z"; const T2 = "2026-09-18T12:05:00.000Z"; const T3 = "2026-09-18T12:10:00.000Z";
/** The durable event name, hand-mirrored: renaming it would orphan every measurement already stored. */
const MEASURED = "RepositoryRemoteDefaultMeasured";
/** A binding of TODAY's exact shape: these three keys and nothing else. */
const TODAY_BINDING = { boundAt: "2026-09-18T11:00:00.000Z", boundBy: "operator-local", remoteUrl: A };
const encoder = new TextEncoder();
const measure = (store: SqliteEventStore, remoteUrl: string, defaultBranch: string | null, measuredAt = T1) =>
  recordRemoteDefaultBranch(store, { projectId: PROJECT_ID, remoteUrl, defaultBranch, measuredAt });
const eventTypes = (store: SqliteEventStore) => store.readEvents(remoteAggregateId(PROJECT_ID)).map((event) => event.eventType);

/** An event on the remote aggregate through the store's own API, so the reads fold bytes they did not author. */
function append(store: SqliteEventStore, commandId: string, eventType: string, payload: unknown): void {
  const aggregateId = remoteAggregateId(PROJECT_ID); const bytes = encoder.encode(JSON.stringify(payload));
  const response = store.commitExpectedVersionDecision({ commandKind: REPOSITORY_PUBLISH_COMMAND_KIND, committedResultBytes: bytes,
    correlationId: "test-remote", decidedAt: TODAY_BINDING.boundAt, events: [{ eventId: `${commandId}-${eventType}`, eventType, payload: bytes }],
    expectedVersion: store.getAggregateVersion(aggregateId), key: { commandId, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: bytes, targetAggregateId: aggregateId });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error(`${commandId} was not committed`);
}

describe("a remote's default branch is its own additive event, never a widened RepositoryRemoteBound", () => {
  it("leaves a binding of today's exact three-key shape decoding through readProjectRemote while a measurement is the latest event", () => {
    const store = openStore();
    append(store, "cmd-bind-a", REMOTE_BOUND_EVENT_TYPE, TODAY_BINDING);
    expect(measure(store, A, "master")).toBe(true);
    expect(eventTypes(store)).toEqual([REMOTE_BOUND_EVENT_TYPE, MEASURED]);
    expect(readProjectRemote(store, PROJECT_ID)).toEqual(TODAY_BINDING);
    // A rebind after a measurement commits on the same store-version fence bindingLeg uses, and wins the read.
    append(store, "cmd-bind-b", REMOTE_BOUND_EVENT_TYPE, { ...TODAY_BINDING, remoteUrl: B });
    expect(readProjectRemote(store, PROJECT_ID)).toEqual({ ...TODAY_BINDING, remoteUrl: B });
  });

  it("answers the measured branch for the matching remote, and null while unmeasured or once the remote advertises no default", () => {
    const store = openStore();
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBeNull();
    append(store, "cmd-bind-a", REMOTE_BOUND_EVENT_TYPE, TODAY_BINDING);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBeNull();
    expect(measure(store, A, "master")).toBe(true);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBe("master");
    expect(readRemoteDefaultBranch(store, "project-other", A)).toBeNull();
    expect(measure(store, A, null, T2)).toBe(true);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBeNull();
    expect(eventTypes(store)).toEqual([REMOTE_BOUND_EVENT_TYPE, MEASURED, MEASURED]);
  });

  it("never answers one remote with another's default: the LATEST measurement must name the asked remote, even after a rebind back", () => {
    const store = openStore();
    expect(measure(store, A, "master", T1)).toBe(true);
    expect(measure(store, B, "trunk", T2)).toBe(true);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, B)).toBe("trunk");
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBeNull();
    expect(measure(store, A, "main", T3)).toBe(true);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBe("main");
    expect(readRemoteDefaultBranch(store, PROJECT_ID, B)).toBeNull();
  });

  it("reads a malformed latest measurement as absent, and refuses to write one over a good measurement", () => {
    const junk = openStore();
    expect(measure(junk, A, "master")).toBe(true);
    append(junk, "cmd-junk", MEASURED, { defaultBranch: "master", extra: "x", measuredAt: T2, remoteUrl: A });
    expect(readRemoteDefaultBranch(junk, PROJECT_ID, A)).toBeNull();
    const store = openStore();
    expect(measure(store, A, "master")).toBe(true);
    expect(measure(store, A, "..", T2)).toBe(false);
    expect(measure(store, "", "main", T2)).toBe(false);
    expect(measure(store, A, "main", "")).toBe(false);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBe("master");
    expect(eventTypes(store)).toEqual([MEASURED]);
  });

  it("records an unchanged answer once: the remote aggregate grows only when the latest default changes", () => {
    const store = openStore();
    append(store, "cmd-bind-a", REMOTE_BOUND_EVENT_TYPE, TODAY_BINDING);
    expect(measure(store, A, "master", T1)).toBe(true);
    expect(measure(store, A, "master", T2)).toBe(true);
    expect(eventTypes(store)).toEqual([REMOTE_BOUND_EVENT_TYPE, MEASURED]);
    // Another remote in between makes the same answer news again, so it is written.
    expect(measure(store, B, "trunk", T2)).toBe(true);
    expect(measure(store, A, "master", T3)).toBe(true);
    expect(eventTypes(store)).toEqual([REMOTE_BOUND_EVENT_TYPE, MEASURED, MEASURED, MEASURED]);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBe("master");
    // At ONE timestamp the same answer at a later position is still a new write, never a replay of the first one.
    const frozen = openStore();
    for (const [url, branch] of [[A, "master"], [B, "trunk"], [A, "master"]] as const) expect(measure(frozen, url, branch, T1)).toBe(true);
    expect(readRemoteDefaultBranch(frozen, PROJECT_ID, A)).toBe("master"); expect(readRemoteDefaultBranch(frozen, PROJECT_ID, B)).toBeNull();
    expect(eventTypes(frozen)).toEqual([MEASURED, MEASURED, MEASURED]);
  });

  it("is never measured by the synchronous publish command or the polled remote read: neither module can reach the port", () => {
    // By construction, pinned here: a module that names neither the port nor a measurement can never make the network call.
    const modules = [["./publish-services.ts", "export function createPublishRepository("],
      ["../http/repository-remote-read.ts", "export function createRepositoryRemoteReadPort("]] as const;
    for (const [path, anchor] of modules) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).toContain(anchor);
      expect(source).not.toMatch(/measureDefaultBranch|measureRemoteDefaultBranch|PublicationGitPort|git-publication-port|node-publisher/u);
    }
    expect(modules).toHaveLength(2);
  });

  it("drops a measurement that loses its fence to a concurrent rebind instead of writing past it or retrying", () => {
    const store = openStore();
    // The rebind lands ONCE, between the writer's version read and its commit, as a second process's would;
    // a retry would read the fresh version and commit, so this arm goes red on any retry.
    let raced = false;
    const racing = new Proxy(store, { get(target, key) {
      if (key === "getAggregateVersion") return (aggregateId: string) => {
        const version = target.getAggregateVersion(aggregateId);
        if (!raced) { raced = true; append(target, "cmd-bind-race", REMOTE_BOUND_EVENT_TYPE, { ...TODAY_BINDING, remoteUrl: B }); }
        return version;
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    expect(measure(racing, A, "master")).toBe(false);
    expect(raced).toBe(true); expect(eventTypes(store)).toEqual([REMOTE_BOUND_EVENT_TYPE]);
    expect(readRemoteDefaultBranch(store, PROJECT_ID, A)).toBeNull();
    expect(readProjectRemote(store, PROJECT_ID)).toEqual({ ...TODAY_BINDING, remoteUrl: B });
  });
});
