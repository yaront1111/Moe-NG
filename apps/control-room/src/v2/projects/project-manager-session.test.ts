import { describe, expect, it, vi } from "vitest";

import { createProjectManagerSession } from "./project-manager-session.js";

const ORIGIN = "http://127.0.0.2:39122";
const CREDENTIAL = "fixture-manager-session";
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }) };
}

describe("manager tab session", () => {
  it("restores the manager credential after a new document adapter is constructed", () => {
    const backing = storage();
    const first = createProjectManagerSession(ORIGIN, () => backing);
    expect(first.read()).toBeUndefined();
    first.write(CREDENTIAL);
    expect(first.read()).toBe(CREDENTIAL);
    expect(createProjectManagerSession(ORIGIN, () => backing).read()).toBe(CREDENTIAL);
    expect(Object.keys(first).sort()).toEqual(["clear", "read", "write"]);
    expect(backing.values.size).toBe(1);
    expect([...backing.values.keys()][0]).toContain(ORIGIN);
    expect([...backing.values.keys()][0]).toContain("v1");
  });

  it("isolates credentials by the full origin including scheme and port", () => {
    const backing = storage();
    createProjectManagerSession(ORIGIN, () => backing).write(CREDENTIAL);
    for (const other of ["http://127.0.0.2:39123", "https://127.0.0.2:39122", "http://127.0.0.1:39122"]) {
      expect(createProjectManagerSession(other, () => backing).read()).toBeUndefined();
    }
  });

  it("clears only this origin's session and retains an empty state in the current adapter", () => {
    const backing = storage(), session = createProjectManagerSession(ORIGIN, () => backing);
    const other = createProjectManagerSession("http://127.0.0.2:39123", () => backing);
    backing.values.set("unrelated", "preserve");
    session.write(CREDENTIAL); other.write("other-fixture-session");
    session.clear();
    expect(session.read()).toBeUndefined();
    expect(createProjectManagerSession(ORIGIN, () => backing).read()).toBeUndefined();
    expect(other.read()).toBe("other-fixture-session");
    expect(backing.values.get("unrelated")).toBe("preserve");
  });

  it.each(["absent", "getter", "getItem", "setItem", "removeItem"] as const)(
    "falls back to a closure when storage is unavailable at %s", failure => {
      const backing = storage();
      if (failure === "getItem") backing.getItem.mockImplementation(() => { throw new Error("unavailable"); });
      if (failure === "setItem") backing.setItem.mockImplementation(() => { throw new Error("unavailable"); });
      if (failure === "removeItem") backing.removeItem.mockImplementation(() => { throw new Error("unavailable"); });
      const session = createProjectManagerSession(ORIGIN, () => {
        if (failure === "getter") throw new Error("unavailable");
        return failure === "absent" ? undefined : backing;
      });
      expect(session.read()).toBeUndefined();
      session.write(CREDENTIAL);
      expect(session.read()).toBe(CREDENTIAL);
      session.clear();
      expect(session.read()).toBeUndefined();
    });

  it.each(["", " ", "credential\n", "credential\u007f", "credential-é", "credential-🧪", "x".repeat(257), 42, {}])(
    "clears malformed stored credentials without preventing a valid session from being saved: %j", malformed => {
      const backing = storage();
      backing.getItem.mockReturnValueOnce(malformed as string);
      const session = createProjectManagerSession(ORIGIN, () => backing);
      expect(session.read()).toBeUndefined();
      expect(backing.removeItem).toHaveBeenCalledTimes(1);
      session.write(CREDENTIAL);
      expect(session.read()).toBe(CREDENTIAL);
      expect(backing.setItem).toHaveBeenCalledTimes(1);
      expect(createProjectManagerSession(ORIGIN, () => backing).read()).toBe(CREDENTIAL);
    });

  it("restores the newly paired session after clearing a corrupt entry", () => {
    const backing = storage();
    createProjectManagerSession(ORIGIN, () => backing).write("previous-fixture-session");
    const key = backing.setItem.mock.calls[0]![0];
    backing.values.set(key, "corrupt-🧪-session");
    const recovery = createProjectManagerSession(ORIGIN, () => backing);
    expect(recovery.read()).toBeUndefined();
    expect(backing.values.has(key)).toBe(false);
    recovery.write(CREDENTIAL);
    expect(createProjectManagerSession(ORIGIN, () => backing).read()).toBe(CREDENTIAL);
  });

  it("keeps replacement pairing in its closure when corrupt-entry removal throws", () => {
    const backing = storage();
    backing.getItem.mockReturnValueOnce("corrupt-🧪-session");
    backing.removeItem.mockImplementation(() => { throw new Error("storage unavailable"); });
    const recovery = createProjectManagerSession(ORIGIN, () => backing);
    expect(recovery.read()).toBeUndefined();
    recovery.write(CREDENTIAL);
    expect(recovery.read()).toBe(CREDENTIAL);
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it.each(["null", "http://127.0.0.2:39122/path", "http://user@127.0.0.2:39122", "http://127.0.0.2:39122#fragment",
    "https://127.0.0.2:39122", "http://127.0.0.1:39122", "http://localhost:39122", "http://example.invalid:39122",
    "http://127.0.0.2:0", "http://127.0.0.2:65536"])(
    "does not retain a session or access storage outside an exact manager origin: %s", origin => {
      const access = vi.fn(() => storage()), session = createProjectManagerSession(origin, access);
      session.write(CREDENTIAL);
      expect(session.read()).toBeUndefined();
      expect(access).not.toHaveBeenCalled();
    });

  it("does not save malformed credentials handed to write", () => {
    const backing = storage(), session = createProjectManagerSession(ORIGIN, () => backing);
    session.write(CREDENTIAL);
    session.write("bad\ncredential");
    expect(session.read()).toBeUndefined();
    expect(createProjectManagerSession(ORIGIN, () => backing).read()).toBeUndefined();
  });
});
