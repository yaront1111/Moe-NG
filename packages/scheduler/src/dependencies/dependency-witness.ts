/**
 * Consumption-horizon ordering only. Cascades, blocker/frontier state, holds,
 * drains, slot release, and execution transitions remain outside this
 * zero-authority scheduler-local kernel.
 */
import { DEPENDENCY_GATES } from "./dependency-contract.js";

export function isWithinHorizon(gate: unknown, horizon: unknown): boolean {
  const gateRank = (DEPENDENCY_GATES as readonly unknown[]).indexOf(gate);
  const horizonRank = (DEPENDENCY_GATES as readonly unknown[]).indexOf(horizon);
  return gateRank >= 0 && horizonRank >= 0 && gateRank <= horizonRank;
}
