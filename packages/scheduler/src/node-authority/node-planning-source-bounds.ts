import { types } from "node:util";

import {
  hasExactDenseArrayShape,
  isPlainArray,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";
import { NODE_AUTHORITY_LIMITS } from "./node-authority-contract.js";

export type NodePlanningDependencyBound = "EXCEEDED" | "UNKNOWN" | "WITHIN";

interface Budget {
  remainingBytes: number;
  visitedNodes: number;
}

function spendText(budget: Budget, value: string): boolean {
  budget.remainingBytes -= Buffer.byteLength(value, "utf8");
  return budget.remainingBytes >= 0;
}

/**
 * Descriptor-safe lower-bound measurement. EXCEEDED is conclusive because canonical JSON cannot
 * contain fewer UTF-8 bytes than its own keys and scalar strings; WITHIN remains subject to the
 * exact post-admission wire ceiling. UNKNOWN deliberately falls through to the owning validators.
 */
export function measureNodePlanningDependencyContent(
  directHardDependencies: unknown,
  predicateRegistry: unknown,
): NodePlanningDependencyBound {
  const root = Object.freeze({ directHardDependencies, predicateRegistry });
  const stack: unknown[] = [root];
  const seen = new WeakSet<object>();
  const budget: Budget = {
    remainingBytes: NODE_AUTHORITY_LIMITS.maxBytes,
    visitedNodes: 0,
  };
  try {
    while (stack.length > 0) {
      const value = stack.pop();
      budget.visitedNodes += 1;
      if (budget.visitedNodes > NODE_AUTHORITY_LIMITS.maxBytes) return "UNKNOWN";
      if (typeof value === "string") {
        if (!spendText(budget, value)) return "EXCEEDED";
        continue;
      }
      if (value === null || typeof value === "boolean"
        || (typeof value === "number" && Number.isSafeInteger(value))) continue;
      if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) return "UNKNOWN";
      seen.add(value);
      if (isPlainArray(value)) {
        const length = readPlainArrayLength(value);
        if (length === null || !hasExactDenseArrayShape(value, length)) return "UNKNOWN";
        for (let index = 0; index < length; index += 1) {
          const read = readOwnArrayElement(value, index);
          if (!read.ok || !read.present) return "UNKNOWN";
          stack.push(read.value);
        }
        continue;
      }
      if (!isPlainRecord(value)) return "UNKNOWN";
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key !== "string" || !spendText(budget, key)) {
          return typeof key === "string" ? "EXCEEDED" : "UNKNOWN";
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const read = readOwnDataProperty(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
          || !read.ok || !read.present) return "UNKNOWN";
        stack.push(read.value);
      }
    }
    return "WITHIN";
  } catch {
    return "UNKNOWN";
  }
}
