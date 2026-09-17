import { describe, expect, it } from "vitest";

import { describeThrown } from "./diagnostic-error.js";
import { MAX_DIAGNOSTIC_CAUSES, MAX_DIAGNOSTIC_MESSAGE_CHARS, MAX_DIAGNOSTIC_STACK_LINES }
  from "./diagnostic-record.js";

describe("describeThrown", () => {
  it("keeps the name, message and stack head of an ordinary Error", () => {
    const facts = describeThrown(new TypeError("boom"));

    expect(facts.name).toBe("TypeError");
    expect(facts.message).toBe("boom");
    expect(facts.code).toBeNull();
    expect(facts.stack).toContain("boom");
    expect(facts.causes).toEqual([]);
  });

  it("keeps the errno code that tells ENOENT from EBUSY", () => {
    const error = Object.assign(new Error("open failed"), { code: "EBUSY" });

    expect(describeThrown(error).code).toBe("EBUSY");
  });

  it("keeps a sqlite code, which is the whole point of binding a store read", () => {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

    expect(describeThrown(error).code).toBe("SQLITE_BUSY");
  });

  it("describes a thrown string without pretending it was an Error", () => {
    const facts = describeThrown("just a string");

    expect(facts.name).toBe("String");
    expect(facts.message).toBe("just a string");
    expect(facts.stack).toBeNull();
  });

  it("describes a thrown null", () => {
    const facts = describeThrown(null);

    expect(facts.name).toBe("Null");
    expect(facts.message).toBe("null");
  });

  it("survives a hostile object whose every accessor throws", () => {
    const hostile = new Proxy({}, {
      get() { throw new Error("trap"); },
      getOwnPropertyDescriptor() { throw new Error("trap"); },
      ownKeys() { throw new Error("trap"); },
    });

    const facts = describeThrown(hostile);

    expect(facts.name).toBe("Unknown");
    expect(facts.message).toBe("");
    expect(facts.code).toBeNull();
  });

  it("bounds a message no matter how long the getter makes it", () => {
    const facts = describeThrown(new Error("x".repeat(MAX_DIAGNOSTIC_MESSAGE_CHARS * 3)));

    expect(facts.message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });

  it("bounds the stack to its head, where the throw site is", () => {
    const error = new Error("deep");
    error.stack = ["Error: deep", ...Array.from({ length: 80 }, (_, at) => `    at frame${String(at)}`)]
      .join("\n");

    const lines = (describeThrown(error).stack ?? "").split("\n");

    expect(lines.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_STACK_LINES);
    expect(lines[0]).toBe("Error: deep");
  });

  it("follows a cause chain and stops at the bound", () => {
    let error = new Error("root");
    for (let depth = 0; depth < MAX_DIAGNOSTIC_CAUSES + 6; depth += 1) {
      error = new Error(`layer${String(depth)}`, { cause: error });
    }

    expect(describeThrown(error).causes.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CAUSES);
  });

  it("terminates on a cause cycle instead of spinning", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { configurable: true, value: second });

    const facts = describeThrown(second);

    expect(facts.causes.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CAUSES);
  });

  it("flattens an AggregateError's members, which is how containment failures arrive", () => {
    const aggregate = new AggregateError(
      [new Error("seat one"), new Error("seat two")],
      "AGENT_PROCESS_CONTAINMENT_FAILED",
    );

    const facts = describeThrown(aggregate);

    expect(facts.name).toBe("AggregateError");
    expect(facts.causes).toContain("Error: seat one");
    expect(facts.causes).toContain("Error: seat two");
  });
});
