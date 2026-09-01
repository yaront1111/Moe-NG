import {
  LIVE_QUIESCE_EVIDENCE_LAYER,
  deriveLiveQuiesceEvidenceDigest,
} from "../../packages/core/src/cutover/cutover-quiesce-evidence.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { HostileCase } from "./integrity-hostile-cases.js";

const expected = {
  code: "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
  layer: LIVE_QUIESCE_EVIDENCE_LAYER,
} as const;

const refused = async (): Promise<unknown> => deriveLiveQuiesceEvidenceDigest(null);

export const RECENT_INTEGRITY_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  {
    arm: "BEFORE", constant: "LIVE_QUIESCE_EVIDENCE_LAYER", expect: expected,
    name: "absent evidence cannot acquire a canonical digest",
    run: async () => (await probeBefore(
      { label: "live-quiesce-before", timeoutMs: 2_000 }, refused, refused,
    )).probe,
  },
  {
    arm: "AFTER", constant: "LIVE_QUIESCE_EVIDENCE_LAYER", expect: expected,
    name: "absent evidence remains unhashable after a prior read",
    run: async () => (await probeAfter(
      { label: "live-quiesce-after", timeoutMs: 2_000 }, refused, refused,
    )).probe,
  },
  {
    arm: "RACE", constant: "LIVE_QUIESCE_EVIDENCE_LAYER",
    name: "two absent evidence records racing derive no digest",
    expectLeft: expected, expectRight: expected,
    run: async () => probeRacing(
      { label: "live-quiesce-race", timeoutMs: 2_000 }, refused, refused,
    ),
  },
]);
