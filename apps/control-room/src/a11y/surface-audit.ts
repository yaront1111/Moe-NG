import type { NextAllowedCommand } from "@moe/contracts";
import { describeTruthClass } from "@moe/control-room-model";
import type { TruthClass, TruthPresentationDescriptor } from "@moe/control-room-model";

export type AuditViolationCode =
  | "FACT_WITHOUT_CHIP"
  | "ACTION_WITHOUT_COMMAND"
  | "ACTION_UNREACHABLE"
  | "BANNER_WITHOUT_LIVE_REGION"
  | "ACTION_MISSING_AT_NARROW";

export interface AuditViolation {
  readonly code: AuditViolationCode;
  readonly testId: string;
}

export interface AuditResult {
  readonly checked: number;
  readonly violations: readonly AuditViolation[];
}

export type MonochromeViolationCode =
  | "TRUTH_CLASS_COUNT_MISMATCH"
  | "TRUTH_CLASS_MONOCHROME_COLLISION";

export interface MonochromeViolation {
  readonly code: MonochromeViolationCode;
  readonly truthClasses: readonly TruthClass[];
}

export interface MonochromeAuditResult {
  readonly checked: number;
  readonly violations: readonly MonochromeViolation[];
}

const FACT_SELECTOR = "[data-testid^='cr.fact.']";
const CHIP_SELECTOR =
  "[data-testid^='cr.chip.']:not([data-testid='cr.chip.policy-approved'])";
const ACTION_SELECTOR = "[data-testid^='cr.action.']";
const BANNER_SELECTOR = "[data-testid^='cr.banner.']";
const TRUTH_CLASSES: readonly TruthClass[] = Object.freeze([
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
]);

function elements(root: ParentNode, selector: string): readonly Element[] {
  return [...root.querySelectorAll(selector)];
}

function testId(element: Element): string {
  return element.getAttribute("data-testid") ?? "";
}

function violation(element: Element, code: AuditViolationCode): AuditViolation {
  return Object.freeze({ code, testId: testId(element) });
}

function result(checked: number, violations: readonly AuditViolation[]): AuditResult {
  return Object.freeze({ checked, violations: Object.freeze([...violations]) });
}

export function auditFactChips(root: ParentNode): AuditResult {
  const facts = elements(root, FACT_SELECTOR);
  const violations = facts
    .filter((fact) => fact.querySelector(CHIP_SELECTOR) === null)
    .map((fact) => violation(fact, "FACT_WITHOUT_CHIP"));
  return result(facts.length, violations);
}

function actionDisabled(action: Element): boolean {
  if (action.hasAttribute("disabled") || action.getAttribute("aria-disabled") === "true") return true;
  if (action instanceof HTMLButtonElement || action instanceof HTMLInputElement) return false;
  if (action instanceof HTMLSelectElement || action instanceof HTMLTextAreaElement) return false;
  if (action instanceof HTMLAnchorElement && action.hasAttribute("href")) return false;
  return action.getAttribute("role") !== "button" && !action.hasAttribute("tabindex");
}

export function auditActionLegality(
  root: ParentNode,
  nextAllowedCommands: readonly NextAllowedCommand[],
): AuditResult {
  const actions = elements(root, ACTION_SELECTOR);
  const commandIds = new Set(nextAllowedCommands.map((command) => command.commandId));
  const violations = actions
    .filter((action) => !actionDisabled(action))
    .filter((action) => !commandIds.has(action.getAttribute("data-command-id") ?? ""))
    .map((action) => violation(action, "ACTION_WITHOUT_COMMAND"));
  return result(actions.length, violations);
}

function isNativelyInteractive(element: Element): boolean {
  if (element instanceof HTMLButtonElement) return true;
  if (element instanceof HTMLInputElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLAnchorElement && element.hasAttribute("href");
}

function isUnreachable(action: Element): boolean {
  if (actionDisabled(action)) return false;
  if (action.closest("[hidden], [aria-hidden='true']") !== null) return true;
  const tabIndex = action.getAttribute("tabindex");
  if (tabIndex !== null && Number(tabIndex) < 0) return true;
  if (isNativelyInteractive(action)) return false;
  return !(action instanceof HTMLElement) || action.tabIndex < 0;
}

function visualOrder(action: Element): number {
  if (!(action instanceof HTMLElement) || action.style.order === "") return 0;
  const order = Number(action.style.order);
  return Number.isFinite(order) ? order : 0;
}

function visualOrderMismatches(actions: readonly Element[]): ReadonlySet<Element> {
  const interactive = actions.filter((action) => !actionDisabled(action));
  const sorted = [...interactive].sort((left, right) => visualOrder(left) - visualOrder(right));
  return new Set(interactive.filter((action, index) => sorted[index] !== action));
}

export function auditKeyboardReachability(root: ParentNode): AuditResult {
  const actions = elements(root, ACTION_SELECTOR);
  const orderMismatches = visualOrderMismatches(actions);
  const violations = actions
    .filter((action) => isUnreachable(action) || orderMismatches.has(action))
    .map((action) => violation(action, "ACTION_UNREACHABLE"));
  return result(actions.length, violations);
}

export function auditLiveRegions(root: ParentNode): AuditResult {
  const banners = elements(root, BANNER_SELECTOR);
  const violations = banners
    .filter((banner) => {
      const role = banner.getAttribute("role");
      const live = banner.getAttribute("aria-live");
      return role !== "status" && role !== "alert" && live !== "polite" && live !== "assertive";
    })
    .map((banner) => violation(banner, "BANNER_WITHOUT_LIVE_REGION"));
  return result(banners.length, violations);
}

export function auditActionParity(wide: ParentNode, narrow: ParentNode): AuditResult {
  const wideActions = elements(wide, ACTION_SELECTOR);
  const narrowIds = new Set(elements(narrow, ACTION_SELECTOR).map(testId));
  const violations = wideActions
    .filter((action) => !narrowIds.has(testId(action)))
    .map((action) => violation(action, "ACTION_MISSING_AT_NARROW"));
  return result(wideActions.length, violations);
}

function productionTruthDescriptors(): readonly TruthPresentationDescriptor[] {
  return TRUTH_CLASSES.flatMap((truthClass) => {
    const described = describeTruthClass(truthClass);
    return described.ok ? [described.descriptor] : [];
  });
}

function monochromeViolation(
  code: MonochromeViolationCode,
  truthClasses: readonly TruthClass[],
): MonochromeViolation {
  return Object.freeze({ code, truthClasses: Object.freeze([...truthClasses]) });
}

function monochromeTuple(descriptor: TruthPresentationDescriptor): string {
  // Border alone is insufficient: four classes are solid. The whole tuple carries meaning.
  return JSON.stringify([descriptor.glyph, descriptor.shortLabel, descriptor.borderStyle]);
}

function findMonochromeCollisions(
  descriptors: readonly TruthPresentationDescriptor[],
): readonly MonochromeViolation[] {
  const violations: MonochromeViolation[] = [];
  for (let left = 0; left < descriptors.length; left += 1) {
    for (let right = left + 1; right < descriptors.length; right += 1) {
      const first = descriptors[left];
      const second = descriptors[right];
      if (first === undefined || second === undefined) continue;
      if (monochromeTuple(first) !== monochromeTuple(second)) continue;
      violations.push(monochromeViolation(
        "TRUTH_CLASS_MONOCHROME_COLLISION",
        [first.truthClass, second.truthClass],
      ));
    }
  }
  return violations;
}

export function auditTruthClassMonochrome(
  supplied?: readonly TruthPresentationDescriptor[],
): MonochromeAuditResult {
  const descriptors = supplied ?? productionTruthDescriptors();
  const violations = [...findMonochromeCollisions(descriptors)];
  if (descriptors.length !== TRUTH_CLASSES.length) {
    violations.unshift(monochromeViolation("TRUTH_CLASS_COUNT_MISMATCH", []));
  }
  return Object.freeze({
    checked: descriptors.length,
    violations: Object.freeze(violations),
  });
}
