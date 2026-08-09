import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CONTROL_ROOM_KEYBOARD_MAP,
  SURFACE_LOCAL_KEYS,
  resolveKeyboardInput,
  useKeyboardRouter,
} from "./keyboard-map.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const EXPECTED_BINDINGS = [
  { sequence: ["g", "g"], action: "goals" },
  { sequence: ["g", "b"], action: "board" },
  { sequence: ["g", "r"], action: "graph" },
  { sequence: ["g", "t"], action: "timeline" },
  { sequence: ["a"], action: "approvals" },
  { sequence: ["/"], action: "search" },
  { sequence: ["?"], action: "help" },
  { sequence: ["["], action: "collapse-inspector" },
  { sequence: ["]"], action: "expand-inspector" },
] as const;

const LOCAL_KEYS = [
  "j",
  "k",
  "h",
  "l",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "p",
  "Escape",
] as const;

function element(tagName: "div" | "input" | "textarea"): HTMLElement {
  return document.createElement(tagName);
}

describe("the global control-room keyboard map", () => {
  it("resolves every declared binding exactly once", () => {
    expect(EXPECTED_BINDINGS.length).toBeGreaterThan(0);
    expect(CONTROL_ROOM_KEYBOARD_MAP).toEqual(EXPECTED_BINDINGS);
    expect(Object.isFrozen(CONTROL_ROOM_KEYBOARD_MAP)).toBe(true);

    const exercised = new Map<string, number>();
    for (const binding of EXPECTED_BINDINGS) {
      let pendingChord: "g" | null = null;
      for (const [index, key] of binding.sequence.entries()) {
        const result = resolveKeyboardInput({ key, pendingChord, target: null });
        const finalKey = index === binding.sequence.length - 1;
        if (!finalKey) {
          expect(result).toEqual({
            matched: false,
            pendingChord: "g",
            reason: "CHORD_PENDING",
          });
          pendingChord = result.pendingChord;
          continue;
        }
        expect(result).toEqual({
          action: binding.action,
          matched: true,
          pendingChord: null,
        });
      }
      const id = binding.sequence.join(" ");
      exercised.set(id, (exercised.get(id) ?? 0) + 1);
    }

    expect([...exercised.entries()]).toEqual(
      EXPECTED_BINDINGS.map(({ sequence }) => [sequence.join(" "), 1]),
    );
  });

  it.each([
    ["input", element("input")],
    ["textarea", element("textarea")],
    ["contenteditable", Object.assign(element("div"), { contentEditable: "true" })],
  ] as const)("refuses navigation while focus is in %s", (_name, target) => {
    expect(resolveKeyboardInput({ key: "a", pendingChord: null, target })).toEqual({
      matched: false,
      pendingChord: null,
      reason: "TEXT_ENTRY_FOCUSED",
    });
  });

  it("defers every surface-local key with the specific reason", () => {
    expect(LOCAL_KEYS.length).toBeGreaterThan(0);
    expect(new Set(SURFACE_LOCAL_KEYS)).toEqual(new Set(LOCAL_KEYS));

    const reasons = LOCAL_KEYS.map((key) =>
      resolveKeyboardInput({ key, pendingChord: null, target: null }),
    );
    expect(reasons).toHaveLength(LOCAL_KEYS.length);
    for (const result of reasons) {
      expect(result).toEqual({
        matched: false,
        pendingChord: null,
        reason: "SURFACE_LOCAL",
      });
    }
  });

  it("returns NO_BINDING for an unbound key", () => {
    expect(resolveKeyboardInput({ key: "x", pendingChord: null, target: null })).toEqual({
      matched: false,
      pendingChord: null,
      reason: "NO_BINDING",
    });
  });

  it("returns CHORD_PENDING for the g prefix", () => {
    expect(resolveKeyboardInput({ key: "g", pendingChord: null, target: null })).toEqual({
      matched: false,
      pendingChord: "g",
      reason: "CHORD_PENDING",
    });
  });

  it("abandons an invalid chord and leaves no prefix armed", () => {
    const abandoned = resolveKeyboardInput({ key: "x", pendingChord: "g", target: null });
    expect(abandoned).toEqual({
      matched: false,
      pendingChord: null,
      reason: "CHORD_ABANDONED",
    });
    expect(
      resolveKeyboardInput({ key: "b", pendingChord: abandoned.pendingChord, target: null }),
    ).toEqual({
      matched: false,
      pendingChord: null,
      reason: "NO_BINDING",
    });
  });
});

describe("useKeyboardRouter", () => {
  it("handles a matched binding once and prevents its browser default", () => {
    const actions: string[] = [];
    renderHook(() => {
      useKeyboardRouter((action) => actions.push(action));
    });

    const event = new KeyboardEvent("keydown", { cancelable: true, key: "a" });
    document.dispatchEvent(event);

    expect(actions).toEqual(["approvals"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("holds chord state without preventing the unmatched prefix", () => {
    const actions: string[] = [];
    renderHook(() => {
      useKeyboardRouter((action) => actions.push(action));
    });

    const prefix = new KeyboardEvent("keydown", { cancelable: true, key: "g" });
    const suffix = new KeyboardEvent("keydown", { cancelable: true, key: "b" });
    document.dispatchEvent(prefix);
    document.dispatchEvent(suffix);

    expect(actions).toEqual(["board"]);
    expect(prefix.defaultPrevented).toBe(false);
    expect(suffix.defaultPrevented).toBe(true);
  });

  it("does not handle or prevent text-entry and surface-local keys", () => {
    const actions: string[] = [];
    renderHook(() => {
      useKeyboardRouter((action) => actions.push(action));
    });
    const input = element("input");
    document.body.append(input);

    const typed = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" });
    const local = new KeyboardEvent("keydown", { cancelable: true, key: "j" });
    input.dispatchEvent(typed);
    document.dispatchEvent(local);

    expect(actions).toEqual([]);
    expect(typed.defaultPrevented).toBe(false);
    expect(local.defaultPrevented).toBe(false);
    input.remove();
  });

  it("removes its document listener on unmount before a remount", () => {
    const actions: string[] = [];
    const first = renderHook(() => {
      useKeyboardRouter((action) => actions.push(action));
    });
    first.unmount();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    const second = renderHook(() => {
      useKeyboardRouter((action) => actions.push(action));
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));

    expect(actions).toEqual(["search"]);
    second.unmount();
  });
});
