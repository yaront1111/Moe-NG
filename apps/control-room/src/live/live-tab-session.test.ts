import { describe, expect, it, vi } from "vitest";

import { createProjectManagerSession } from "../v2/projects/project-manager-session.js";
import { createLiveTabSession } from "./live-tab-session.js";
import type { LiveTabSessionRecord } from "./live-tab-session.js";

const ORIGIN = "http://127.0.0.1:39123";
const PROJECT = "fixture-project";
const CREDENTIAL = "fixture-project-session";
const BINDING = { sessionId: "fixture-session-id", credentialId: "fixture-credential-id", clientKeyId: "ab".repeat(32), generation: 1 };
const SESSION = { credential: CREDENTIAL, binding: BINDING };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }) };
}

describe("project tab session", () => {
  it("restores a credential only with its exact project binding", () => {
    const backing = storage(), first = createLiveTabSession(ORIGIN, () => backing);
    expect(first.read(PROJECT)).toBeUndefined();
    first.write(PROJECT, SESSION);
    expect(createLiveTabSession(ORIGIN, () => backing).read(PROJECT)).toEqual(SESSION);
    expect(Object.keys(first).sort()).toEqual(["clear", "read", "write"]);
    expect(backing.values.size).toBe(1);
    const [key, value] = [...backing.values][0]!;
    expect(key).toContain(ORIGIN);
    expect(key).toContain("v1");
    expect(JSON.parse(value)).toEqual({ projectId: PROJECT, ...SESSION });
  });

  it("clears an old project's candidate when the same origin serves another project", () => {
    const backing = storage(), first = createLiveTabSession(ORIGIN, () => backing);
    first.write(PROJECT, SESSION);
    const reopened = createLiveTabSession(ORIGIN, () => backing);
    expect(reopened.read("different-project")).toBeUndefined();
    expect(backing.values.size).toBe(0);
    expect(reopened.read(PROJECT)).toBeUndefined();
    const replacement = { ...SESSION, credential: "replacement-session" };
    reopened.write("different-project", replacement);
    expect(createLiveTabSession(ORIGIN, () => backing).read("different-project")).toEqual(replacement);
  });

  it("keeps other ports and manager sessions separate when a project session is cleared", () => {
    const backing = storage(), project = createLiveTabSession(ORIGIN, () => backing);
    const other = createLiveTabSession("http://127.0.0.1:39124", () => backing);
    const manager = createProjectManagerSession("http://127.0.0.2:39122", () => backing);
    project.write(PROJECT, SESSION);
    expect(other.read(PROJECT)).toBeUndefined();
    const otherSession = { ...SESSION, credential: "other-project-session" };
    other.write(PROJECT, otherSession); manager.write("manager-session");
    project.clear();
    expect(project.read(PROJECT)).toBeUndefined();
    expect(createLiveTabSession(ORIGIN, () => backing).read(PROJECT)).toBeUndefined();
    expect(other.read(PROJECT)).toEqual(otherSession);
    expect(manager.read()).toBe("manager-session");
    expect(backing.values.size).toBe(2);
  });

  it.each(["absent", "getter", "getItem", "setItem", "removeItem"] as const)(
    "keeps current pairing usable when storage fails at %s", failure => {
      const backing = storage();
      if (failure === "getItem") backing.getItem.mockImplementation(() => { throw new Error("blocked"); });
      if (failure === "setItem") backing.setItem.mockImplementation(() => { throw new Error("blocked"); });
      if (failure === "removeItem") backing.removeItem.mockImplementation(() => { throw new Error("blocked"); });
      const session = createLiveTabSession(ORIGIN, () => {
        if (failure === "getter") throw new Error("blocked");
        return failure === "absent" ? undefined : backing;
      });
      expect(session.read(PROJECT)).toBeUndefined();
      session.write(PROJECT, SESSION);
      expect(session.read(PROJECT)).toEqual(SESSION);
      session.clear();
      expect(session.read(PROJECT)).toBeUndefined();
    });

  it.each(["{", "null", "[]", '"raw-credential"', JSON.stringify({ projectId: PROJECT }),
    JSON.stringify({ projectId: PROJECT, ...SESSION, csrfToken: "not-authority" }),
    JSON.stringify({ projectId: PROJECT, ...SESSION, credential: "fixture-🧪" }),
    JSON.stringify({ projectId: "", ...SESSION }), "x".repeat(8193)])(
    "clears malformed storage and persists the next successfully paired session %#", malformed => {
      const backing = storage();
      backing.getItem.mockReturnValueOnce(malformed);
      const restored = createLiveTabSession(ORIGIN, () => backing);
      expect(restored.read(PROJECT)).toBeUndefined();
      expect(backing.removeItem).toHaveBeenCalledOnce();
      restored.write(PROJECT, SESSION);
      expect(createLiveTabSession(ORIGIN, () => backing).read(PROJECT)).toEqual(SESSION);
    });

  it("falls back to current-document pairing when clearing corrupt storage fails", () => {
    const backing = storage();
    backing.getItem.mockReturnValueOnce("corrupt");
    backing.removeItem.mockImplementation(() => { throw new Error("blocked"); });
    const session = createLiveTabSession(ORIGIN, () => backing);
    expect(session.read(PROJECT)).toBeUndefined();
    session.write(PROJECT, SESSION);
    expect(session.read(PROJECT)).toEqual(SESSION);
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it.each([
    { ...BINDING, clientKeyId: "fixture-key-id" },
    { ...BINDING, clientKeyId: "AB".repeat(32) },
    { ...BINDING, clientKeyId: "a".repeat(63) },
    { ...BINDING, sessionId: "é".repeat(129) },
    { ...BINDING, credentialId: "🧪".repeat(65) },
  ])("clears a stored binding rejected by the server wire format and allows repair %#", binding => {
    const backing = storage();
    backing.getItem.mockReturnValueOnce(JSON.stringify({ projectId: PROJECT, ...SESSION, binding }));
    const session = createLiveTabSession(ORIGIN, () => backing);
    expect(session.read(PROJECT)).toBeUndefined();
    expect(backing.removeItem).toHaveBeenCalledOnce();
    session.write(PROJECT, { ...SESSION, binding });
    expect(backing.setItem).not.toHaveBeenCalled();
    session.write(PROJECT, SESSION);
    expect(createLiveTabSession(ORIGIN, () => backing).read(PROJECT)).toEqual(SESSION);
  });

  it("retains session identifiers at the server's 256-byte UTF-8 boundary", () => {
    const backing = storage(), session = createLiveTabSession(ORIGIN, () => backing);
    const candidate = { ...SESSION, binding: { ...BINDING, sessionId: "é".repeat(128), credentialId: "🧪".repeat(64) } };
    session.write(PROJECT, candidate);
    expect(createLiveTabSession(ORIGIN, () => backing).read(PROJECT)).toEqual(candidate);
  });

  it.each(["null", "http://127.0.0.2:39122", "http://localhost:39123", "https://127.0.0.1:39123",
    "http://127.0.0.1:39123/path", "http://user@127.0.0.1:39123", "http://127.0.0.1:39123#fragment",
    "http://127.0.0.1:0", "http://127.0.0.1:65536"])("does not access storage for invalid project origin %s", origin => {
      const access = vi.fn(() => storage()), session = createLiveTabSession(origin, access);
      session.write(PROJECT, SESSION); session.clear();
      expect(session.read(PROJECT)).toBeUndefined();
      expect(access).not.toHaveBeenCalled();
    });

  it.each(["", " ", "credential\n", "credential\u007f", "credential-é", "credential-🧪", "x".repeat(257)])(
    "does not retain an invalid header credential: %j", credential => {
      const backing = storage(), session = createLiveTabSession(ORIGIN, () => backing);
      session.write(PROJECT, { ...SESSION, credential });
      expect(session.read(PROJECT)).toBeUndefined();
      expect(backing.values.size).toBe(0);
    });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects invalid session generation %j", generation => {
    const backing = storage(), session = createLiveTabSession(ORIGIN, () => backing);
    const record = { ...SESSION, binding: { ...BINDING, generation } } as LiveTabSessionRecord;
    backing.getItem.mockReturnValueOnce(JSON.stringify({ projectId: PROJECT, ...record }));
    expect(session.read(PROJECT)).toBeUndefined();
    session.write(PROJECT, record);
    expect(session.read(PROJECT)).toBeUndefined();
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it.each(["sessionId", "credentialId", "clientKeyId"] as const)("requires a bounded nonblank %s", field => {
    for (const value of ["", " ", "id\n", "x".repeat(257)]) {
      const session = createLiveTabSession(ORIGIN, () => storage());
      session.write(PROJECT, { ...SESSION, binding: { ...BINDING, [field]: value } });
      expect(session.read(PROJECT)).toBeUndefined();
    }
  });

  it("refuses extra or missing binding keys instead of retaining authority metadata", () => {
    for (const binding of [{ ...BINDING, authority: "HUMAN" }, { sessionId: BINDING.sessionId }, []]) {
      const session = createLiveTabSession(ORIGIN, () => storage());
      session.write(PROJECT, { ...SESSION, binding } as LiveTabSessionRecord);
      expect(session.read(PROJECT)).toBeUndefined();
    }
  });

  it("copies and freezes session binding metadata before retaining it", () => {
    const session = createLiveTabSession(ORIGIN, () => storage());
    const candidate = { ...SESSION, binding: { ...BINDING } };
    session.write(PROJECT, candidate);
    candidate.credential = "changed"; candidate.binding.sessionId = "changed";
    const stored = session.read(PROJECT);
    expect(stored).toEqual(SESSION);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.binding)).toBe(true);
  });

  it.each(["", " ", "project\n", "x".repeat(1025)])("refuses an invalid fresh project identity %#", projectId => {
    const backing = storage(), session = createLiveTabSession(ORIGIN, () => backing);
    session.write(PROJECT, SESSION);
    expect(session.read(projectId)).toBeUndefined();
    expect(backing.values.size).toBe(0);
    session.write(projectId, SESSION);
    expect(session.read(PROJECT)).toBeUndefined();
    expect(backing.values.size).toBe(0);
  });
});
