import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type KeyboardAction =
  | "goals"
  | "board"
  | "graph"
  | "timeline"
  | "approvals"
  | "search"
  | "help"
  | "collapse-inspector"
  | "expand-inspector";

export type KeyboardRefusalReason =
  | "TEXT_ENTRY_FOCUSED"
  | "SURFACE_LOCAL"
  | "NO_BINDING"
  | "CHORD_PENDING"
  | "CHORD_ABANDONED";

export type PendingChord = "g" | null;

export interface KeyboardBinding {
  readonly sequence: readonly string[];
  readonly action: KeyboardAction;
}

export interface KeyboardInput {
  readonly key: string;
  readonly pendingChord: PendingChord;
  readonly target: EventTarget | null;
}

export type KeyboardResolution =
  | Readonly<{ matched: true; action: KeyboardAction; pendingChord: null }>
  | Readonly<{
    matched: false;
    reason: KeyboardRefusalReason;
    pendingChord: PendingChord;
  }>;

function binding(sequence: readonly string[], action: KeyboardAction): KeyboardBinding {
  return Object.freeze({ action, sequence: Object.freeze([...sequence]) });
}

export const CONTROL_ROOM_KEYBOARD_MAP: readonly KeyboardBinding[] = Object.freeze([
  binding(["g", "g"], "goals"),
  binding(["g", "b"], "board"),
  binding(["g", "r"], "graph"),
  binding(["g", "t"], "timeline"),
  binding(["a"], "approvals"),
  binding(["/"], "search"),
  binding(["?"], "help"),
  binding(["["], "collapse-inspector"),
  binding(["]"], "expand-inspector"),
]);

function frozenReadonlySet<T>(values: readonly T[]): ReadonlySet<T> {
  const backing = new Set(values);
  let facade: ReadonlySet<T>;
  facade = {
    get size() { return backing.size; },
    has: (value) => backing.has(value),
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    values: () => backing.values(),
    [Symbol.iterator]: () => backing[Symbol.iterator](),
    forEach: (callback, thisArg) => {
      backing.forEach((value) => callback.call(thisArg, value, value, facade));
    },
  };
  return Object.freeze(facade);
}

export const SURFACE_LOCAL_KEYS: ReadonlySet<string> = frozenReadonlySet([
  "j", "k", "h", "l", "ArrowLeft", "ArrowRight", "Enter", "p", "Escape",
]);

function refusal(
  reason: KeyboardRefusalReason,
  pendingChord: PendingChord = null,
): KeyboardResolution {
  return Object.freeze({ matched: false, pendingChord, reason });
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  let candidate: Element | null = target;
  while (candidate !== null) {
    if (candidate.matches("input, textarea")) return true;
    const editable = candidate.getAttribute("contenteditable");
    if (editable !== null) return editable !== "false";
    if (candidate instanceof HTMLElement && candidate.contentEditable === "true") return true;
    candidate = candidate.parentElement;
  }
  return false;
}

function findBinding(sequence: readonly string[]): KeyboardBinding | undefined {
  return CONTROL_ROOM_KEYBOARD_MAP.find((candidate) =>
    candidate.sequence.length === sequence.length
    && candidate.sequence.every((key, index) => key === sequence[index]),
  );
}

export function resolveKeyboardInput(input: KeyboardInput): KeyboardResolution {
  if (isTextEntry(input.target)) return refusal("TEXT_ENTRY_FOCUSED");
  if (SURFACE_LOCAL_KEYS.has(input.key)) return refusal("SURFACE_LOCAL");
  if (input.pendingChord !== null) {
    const match = findBinding([input.pendingChord, input.key]);
    return match === undefined
      ? refusal("CHORD_ABANDONED")
      : Object.freeze({ action: match.action, matched: true, pendingChord: null });
  }
  if (input.key === "g") return refusal("CHORD_PENDING", "g");
  const match = findBinding([input.key]);
  return match === undefined
    ? refusal("NO_BINDING")
    : Object.freeze({ action: match.action, matched: true, pendingChord: null });
}

export function useKeyboardRouter(onAction: (action: KeyboardAction) => void): void {
  const pendingChord = useRef<PendingChord>(null);
  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent): void => {
      const result = resolveKeyboardInput({
        key: event.key,
        pendingChord: pendingChord.current,
        target: event.target,
      });
      pendingChord.current = result.pendingChord;
      if (!result.matched) return;
      event.preventDefault();
      onAction(result.action);
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      pendingChord.current = null;
      document.removeEventListener("keydown", handleKey);
    };
  }, [onAction]);
}

type ProjectionAction = Extract<KeyboardAction, "board" | "graph" | "timeline">;

export interface ShellKeyboardController {
  readonly closeHelp: () => void;
  readonly focusMain: () => void;
  readonly helpOpen: boolean;
  readonly inspectorExpanded: boolean;
  readonly mainRef: RefObject<HTMLElement | null>;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}

function focusWithin(root: ParentNode | null, selector: string): void {
  root?.querySelector<HTMLElement>(selector)?.focus();
}

export function useShellKeyboardController(
  onTab: (tab: ProjectionAction) => void,
): ShellKeyboardController {
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inspectorExpanded, setInspectorExpanded] = useState(true);
  const handleAction = useCallback((action: KeyboardAction): void => {
    switch (action) {
      case "board": case "graph": case "timeline": onTab(action); return;
      case "goals": case "approvals":
        focusWithin(rootRef.current, `[data-testid='cr.nav.${action}']`); return;
      case "search":
        focusWithin(rootRef.current, "[role='searchbox'], input[type='search']"); return;
      case "help": setHelpOpen(true); return;
      case "collapse-inspector": setInspectorExpanded(false); return;
      case "expand-inspector": setInspectorExpanded(true); return;
    }
  }, [onTab]);
  useKeyboardRouter(handleAction);
  return {
    closeHelp: () => setHelpOpen(false),
    focusMain: () => mainRef.current?.focus(),
    helpOpen,
    inspectorExpanded,
    mainRef,
    rootRef,
  };
}
