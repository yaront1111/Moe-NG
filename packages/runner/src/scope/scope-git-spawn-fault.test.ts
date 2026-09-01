import { afterEach, describe, expect, it, vi } from "vitest";

import { ScopeObserverError, type GitObserver } from "./scope-contract.js";
import {
  MAX_SCOPE_OBSERVATION_BYTES,
  createNodeGitObserver,
  hermeticGitEnvironment,
} from "./scope-git.js";

/**
 * runGit's OWN reading of a spawn fault, driven through a mocked execFileSync.
 *
 * The process boundary is not injectable — createNodeGitObserver closes over a
 * private runGit that calls execFileSync directly — so the classify module's
 * pattern (drive an extracted classifier) can only cover listRefs, the one
 * method with a scoped catch. The mapping runGit applies for the other five
 * methods is reachable in no other way: real git cannot be made to throw a
 * chosen errno on demand, and forcing a REAL ENOBUFS needs a checkout whose
 * listing exceeds 8MiB. Only the spawn is faked here; the code under test is
 * the production observer, byte for byte.
 *
 * The fault that matters is ENOBUFS: execFileSync reports a maxBuffer overflow
 * under that errno (ERR_CHILD_PROCESS_STDIO_MAXBUFFER is the async execFile
 * shape), and a truncated observation must refuse as the overflow it is —
 * RUNNER_SCOPE_OBSERVATION_OVERFLOW, never the generic FAILED that hides which
 * limit was hit.
 */

const spawnFault = vi.hoisted(() => ({ current: null as (Error & { code: string }) | null }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (): never => {
      if (spawnFault.current === null) {
        throw new Error("spawn-fault harness: no fault armed; this file never spawns for real");
      }
      throw spawnFault.current;
    },
  };
});

afterEach(() => {
  spawnFault.current = null;
});

/** The shape execFileSync attaches: a bare Error carrying the errno as `code`. */
const fault = (code: string): Error & { code: string } =>
  Object.assign(new Error(`spawnSync git ${code}`), { code });

const observer = (): GitObserver =>
  createNodeGitObserver("fixture-repository", hermeticGitEnvironment(process.env));

function refusalFrom(action: (subject: GitObserver) => unknown): unknown {
  try {
    action(observer());
  } catch (error) {
    return error;
  }
  throw new Error("the observer answered instead of refusing");
}

/** Every observer method: ALL six must report an overflow as an overflow. */
const METHODS: readonly (readonly [string, (subject: GitObserver) => unknown])[] = Object.freeze([
  ["headCommit", (subject) => subject.headCommit()],
  ["statusPorcelainV2", (subject) => subject.statusPorcelainV2()],
  ["lsFilesTracked", (subject) => subject.lsFilesTracked()],
  ["lsFilesIgnored", (subject) => subject.lsFilesIgnored()],
  ["submodulePaths", (subject) => subject.submodulePaths()],
  [
    "listRefs",
    (subject) => {
      if (subject.listRefs === undefined) throw new Error("listRefs is not implemented");
      return subject.listRefs();
    },
  ],
]);

describe("runGit spawn-fault classification", () => {
  it("covers every observer method exactly once", () => {
    // Guards the table itself: a sweep that silently shrank would pass while
    // leaving a method's mapping untested.
    expect(METHODS.length).toBe(6);
    expect(new Set(METHODS.map((entry) => entry[0])).size).toBe(METHODS.length);
  });

  it.each(METHODS)("codes an ENOBUFS overflow from %s as the overflow it is", (_label, invoke) => {
    spawnFault.current = fault("ENOBUFS");
    const thrown = refusalFrom(invoke);
    expect(thrown).toBeInstanceOf(ScopeObserverError);
    expect((thrown as ScopeObserverError).code).toBe("RUNNER_SCOPE_OBSERVATION_OVERFLOW");
  });

  it("names the byte ceiling and preserves the spawn fault behind the refusal", () => {
    spawnFault.current = fault("ENOBUFS");
    const thrown = refusalFrom((subject) => subject.lsFilesIgnored());
    expect(thrown).toBeInstanceOf(ScopeObserverError);
    const refusal = thrown as ScopeObserverError & { cause?: unknown };
    expect(refusal.code).toBe("RUNNER_SCOPE_OBSERVATION_OVERFLOW");
    expect(refusal.message).toBe(
      `git ls-files-ignored exceeded ${MAX_SCOPE_OBSERVATION_BYTES} bytes`,
    );
    expect(refusal.cause).toBe(spawnFault.current);
  });

  it("still codes the async maxBuffer shape as an overflow", () => {
    // The arm that existed first: execFile (async) reports the same truncation
    // as ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Recognising ENOBUFS is an addition,
    // not a replacement.
    spawnFault.current = fault("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const thrown = refusalFrom((subject) => subject.lsFilesIgnored());
    expect((thrown as ScopeObserverError).code).toBe("RUNNER_SCOPE_OBSERVATION_OVERFLOW");
  });

  it("keeps any other errno a generic observation failure", () => {
    // The negative control: without it the errno comparison could widen to
    // "any coded throw" and every case above would stay green.
    spawnFault.current = fault("ENOENT");
    const thrown = refusalFrom((subject) => subject.lsFilesTracked());
    expect(thrown).toBeInstanceOf(ScopeObserverError);
    expect((thrown as ScopeObserverError).code).toBe("RUNNER_SCOPE_OBSERVATION_FAILED");
  });
});
