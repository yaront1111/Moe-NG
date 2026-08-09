import type { NextAllowedCommand } from "@moe/contracts";

export type SurfaceAuditCode =
  | "FACT_WITHOUT_CHIP"
  | "ACTION_WITHOUT_COMMAND"
  | "ACTION_UNREACHABLE"
  | "BANNER_WITHOUT_LIVE_REGION"
  | "ACTION_MISSING_AT_NARROW";

export interface SurfaceAuditViolation {
  readonly code: SurfaceAuditCode;
  readonly testId: string;
}

export interface SurfaceAuditResult {
  readonly checked: number;
  readonly violations: readonly SurfaceAuditViolation[];
}

const ACTION_SELECTOR = "[data-testid^='cr.action.']";
const FACT_SELECTOR = "[data-testid^='cr.fact.']";
const TRUTH_CHIP_SELECTOR =
  "[data-testid^='cr.chip.']:not([data-testid='cr.chip.policy-approved'])";
const BANNER_SELECTOR = "[data-testid^='cr.banner.']";

function testId(element: Element): string {
  return element.getAttribute("data-testid") ?? "";
}

function violation(code: SurfaceAuditCode, element: Element): SurfaceAuditViolation {
  return Object.freeze({ code, testId: testId(element) });
}

function result(
  checked: number,
  violations: readonly SurfaceAuditViolation[],
): SurfaceAuditResult {
  return Object.freeze({ checked, violations: Object.freeze([...violations]) });
}

function elements(root: Element, selector: string): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

function isDisabled(element: HTMLElement): boolean {
  return element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
}

export function auditFactChips(root: Element): SurfaceAuditResult {
  const facts = elements(root, FACT_SELECTOR);
  const violations = facts
    .filter((fact) => fact.querySelector(TRUTH_CHIP_SELECTOR) === null)
    .map((fact) => violation("FACT_WITHOUT_CHIP", fact));
  return result(facts.length, violations);
}

export function auditActionLegality(
  root: Element,
  nextAllowedCommands: readonly NextAllowedCommand[],
): SurfaceAuditResult {
  const actions = elements(root, ACTION_SELECTOR);
  const commandIds = new Set(nextAllowedCommands.map(({ commandId }) => commandId));
  const violations = actions
    .filter((action) =>
      !isDisabled(action) && !commandIds.has(action.dataset.commandId ?? ""),
    )
    .map((action) => violation("ACTION_WITHOUT_COMMAND", action));
  return result(actions.length, violations);
}

function isUnreachable(action: HTMLElement): boolean {
  if (isDisabled(action)) return false;
  if (action.tabIndex < 0) return true;
  return action.closest("[hidden], [aria-hidden='true']") !== null;
}

function visualOrder(action: HTMLElement): number {
  const parsed = Number(action.style.order);
  return action.style.order === "" || !Number.isFinite(parsed) ? 0 : parsed;
}

function orderMismatch(actions: readonly HTMLElement[]): ReadonlySet<HTMLElement> {
  const interactive = actions.filter((action) => !isDisabled(action));
  const visuallySorted = [...interactive].sort((left, right) =>
    visualOrder(left) - visualOrder(right),
  );
  return new Set(
    interactive.filter((action, index) => action !== visuallySorted[index]),
  );
}

export function auditKeyboardReachability(root: Element): SurfaceAuditResult {
  const actions = elements(root, ACTION_SELECTOR);
  const mismatched = orderMismatch(actions);
  const violations = actions
    .filter((action) => isUnreachable(action) || mismatched.has(action))
    .map((action) => violation("ACTION_UNREACHABLE", action));
  return result(actions.length, violations);
}

export function auditLiveRegions(root: Element): SurfaceAuditResult {
  const banners = elements(root, BANNER_SELECTOR);
  const violations = banners
    .filter((banner) => {
      const role = banner.getAttribute("role");
      const ariaLive = banner.getAttribute("aria-live");
      return role !== "status"
        && role !== "alert"
        && (ariaLive === null || ariaLive === "off");
    })
    .map((banner) => violation("BANNER_WITHOUT_LIVE_REGION", banner));
  return result(banners.length, violations);
}

export function auditActionParity(wide: Element, narrow: Element): SurfaceAuditResult {
  const wideActions = elements(wide, ACTION_SELECTOR);
  const narrowIds = new Set(elements(narrow, ACTION_SELECTOR).map(testId));
  const violations = wideActions
    .filter((action) => !narrowIds.has(testId(action)))
    .map((action) => violation("ACTION_MISSING_AT_NARROW", action));
  return result(wideActions.length, violations);
}
