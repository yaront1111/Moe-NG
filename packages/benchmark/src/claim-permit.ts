import { CLAIM_LADDER, PERMANENTLY_FORBIDDEN } from "./claim-ladder-contract.js";
import type {
  ClaimLadderEntry,
  ClaimLadderLayer,
  ReachedRung,
} from "./claim-ladder-contract.js";

const LAYER: ClaimLadderLayer = "BENCHMARK_CLAIM_LADDER";

export type ClaimPermitCode =
  | "CLAIM_NOT_PERMITTED_AT_RUNG"
  | "CLAIM_PERMANENTLY_FORBIDDEN"
  | "CLAIM_SCOPE_INCOMPLETE";

export interface ClaimPermitted {
  readonly ok: true;
}

export interface ClaimRefused {
  readonly code: ClaimPermitCode;
  readonly layer: ClaimLadderLayer;
  readonly ok: false;
}

export type ClaimPermitResult = ClaimPermitted | ClaimRefused;

function refuse(code: ClaimPermitCode): ClaimRefused {
  return Object.freeze({ code, layer: LAYER, ok: false });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function templatePattern(template: string, allowEmpty: boolean): RegExp {
  const pieces = template.split(/(\{[^}]+\})/g);
  const source = pieces.map((piece) => {
    if (/^\{[^}]+\}$/.test(piece)) return allowEmpty ? "(.*?)" : "(.+?)";
    return escapeRegex(piece);
  }).join("");
  return new RegExp("^" + source + "$", "u");
}

function filledMatch(entry: ClaimLadderEntry, sentence: string): boolean {
  const matched = templatePattern(entry.template, false).exec(sentence);
  if (matched === null) return false;
  return matched.slice(1).every((value) => value.trim().length > 0 && !/[{}]/.test(value));
}

function structurallyMatches(entry: ClaimLadderEntry, sentence: string): boolean {
  return templatePattern(entry.template, true).test(sentence);
}

function containsPermanentlyForbidden(sentence: string): boolean {
  const normalized = sentence.toLocaleLowerCase("en-US");
  return PERMANENTLY_FORBIDDEN.some(
    (member) => normalized.includes(member.toLocaleLowerCase("en-US")),
  );
}

/**
 * Exact permit-list matching: the reached rung licenses one sentence shape and nothing
 * else. Permanent prohibitions answer before the rung check so L5 cannot override them.
 */
export function permitClaim(sentence: string, reachedRung: ReachedRung): ClaimPermitResult {
  if (containsPermanentlyForbidden(sentence)) {
    return refuse("CLAIM_PERMANENTLY_FORBIDDEN");
  }
  const entry = CLAIM_LADDER.find(({ rungId }) => rungId === reachedRung);
  if (entry === undefined) return refuse("CLAIM_NOT_PERMITTED_AT_RUNG");
  if (filledMatch(entry, sentence)) return Object.freeze({ ok: true });
  if (structurallyMatches(entry, sentence)) return refuse("CLAIM_SCOPE_INCOMPLETE");
  return refuse("CLAIM_NOT_PERMITTED_AT_RUNG");
}
