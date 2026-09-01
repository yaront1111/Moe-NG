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
  | "MODIFIED_KEY"
  | "SURFACE_LOCAL"
  | "NO_BINDING"
  | "CHORD_PENDING"
  | "CHORD_ABANDONED";

export type PendingChord = "g" | null;

export interface KeyboardBinding {
  readonly sequence: readonly string[];
  readonly action: KeyboardAction;
}

/**
 * The modifiers that decide whether a key is the browser's. Shift is deliberately not
 * here: `?` only exists as Shift+/ and must still route. Alt is carried only so that
 * Ctrl+Alt can be told from Ctrl, because AltGr layouts spell `[` and `]` as Ctrl+Alt.
 */
export interface KeyboardModifiers {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export interface KeyboardInput {
  readonly key: string;
  readonly modifiers: KeyboardModifiers;
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

/**
 * Cmd+anything and Ctrl+anything belong to the browser (select-all, history, find), so
 * the map never sees them. Ctrl+Alt is the AltGr spelling of a plain key and stays.
 */
function isBrowserChord(modifiers: KeyboardModifiers): boolean {
  return modifiers.metaKey || (modifiers.ctrlKey && !modifiers.altKey);
}

/** A select is text entry too: its type-ahead consumes the same letters the map binds. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  let candidate: Element | null = target;
  while (candidate !== null) {
    if (candidate.matches("input, textarea, select")) return true;
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
  if (isBrowserChord(input.modifiers)) return refusal("MODIFIED_KEY");
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
        modifiers: { altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
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
  readonly collapseInspector: () => void;
  readonly closeHelp: () => void;
  readonly focusMain: () => void;
  readonly helpOpen: boolean;
  readonly inspectorExpanded: boolean;
  readonly mainRef: RefObject<HTMLElement | null>;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly toggleInspector: () => void;
}

function focusWithin(root: ParentNode | null, selector: string): void {
  root?.querySelector<HTMLElement>(selector)?.focus();
}

export function useShellKeyboardController(
  onTab: (tab: ProjectionAction) => void,
  initialInspectorExpanded = true,
): ShellKeyboardController {
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const helpReturnFocus = useRef<HTMLElement | null>(null);
  const helpRestorePending = useRef(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inspectorExpanded, setInspectorExpanded] = useState(initialInspectorExpanded);
  const handleAction = useCallback((action: KeyboardAction): void => {
    // Searched from the document, not the shell root: approval reason dialogs portal to
    // document.body, and a modal the root cannot see is still a modal. The narrow
    // inspector sheet is the one modal that may open help from inside itself.
    const modals = (rootRef.current?.ownerDocument ?? document)
      .querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']");
    for (const modal of modals) {
      const inspectorMayOpenHelp = action === "help"
        && modal.getAttribute("data-testid") === "cr.shell.inspector";
      if (!inspectorMayOpenHelp) return;
    }
    switch (action) {
      case "board": case "graph": case "timeline": onTab(action); return;
      case "goals": case "approvals":
        focusWithin(rootRef.current, `[data-testid='cr.nav.${action}']`); return;
      case "search":
        focusWithin(rootRef.current, "[role='searchbox'], input[type='search']"); return;
      case "help":
        helpReturnFocus.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        helpRestorePending.current = false;
        setHelpOpen(true);
        return;
      case "collapse-inspector": setInspectorExpanded(false); return;
      case "expand-inspector": setInspectorExpanded(true); return;
    }
  }, [onTab]);
  const closeHelp = useCallback((): void => {
    helpRestorePending.current = true;
    setHelpOpen(false);
  }, []);
  useEffect(() => {
    if (helpOpen || !helpRestorePending.current) return;
    const target = helpReturnFocus.current;
    if (target?.isConnected === true && target.closest("[hidden]") === null) target.focus();
    else mainRef.current?.focus();
    helpReturnFocus.current = null;
    helpRestorePending.current = false;
  }, [helpOpen]);
  const collapseInspector = useCallback((): void => { setInspectorExpanded(false); }, []);
  const toggleInspector = useCallback((): void => {
    setInspectorExpanded((expanded) => !expanded);
  }, []);
  useKeyboardRouter(handleAction);
  return {
    collapseInspector,
    closeHelp,
    focusMain: () => mainRef.current?.focus(),
    helpOpen,
    inspectorExpanded,
    mainRef,
    rootRef,
    toggleInspector,
  };
}
