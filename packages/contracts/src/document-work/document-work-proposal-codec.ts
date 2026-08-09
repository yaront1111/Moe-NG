import { decodeBoundedJsonBytes } from "../bounded-json.js";
import {
  hasExactKeys, isHex64, isPlainRecord, isSafeArray, isSafeCount,
} from "../runtime/runtime-guards.js";
import {
  DOCUMENT_WORK_PROPOSAL_LIMITS,
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
} from "./document-work-proposal-contract.js";
import type {
  DocumentWorkCandidate,
  DocumentWorkProposal,
  DocumentWorkProposalContractRefused,
  DocumentWorkProposalResult,
  DocumentWorkSourceBinding,
} from "./document-work-proposal-contract.js";

const ROOT_KEYS = [
  "advisoryOnly", "authority", "candidates", "contextManifestDigest", "projectId",
  "repositoryBaseHash", "schemaVersion", "sources", "submissionState", "truthClass",
] as const;
const SOURCE_KEYS = ["byteLength", "contentSha256", "displayPath", "sourceRef"] as const;
const CANDIDATE_KEYS = ["candidateRef", "objective", "sourceRefs", "title"] as const;
const utf8 = new TextEncoder();

type Check = "OK" | "INVALID" | "LIMIT";
type RefusalCode = DocumentWorkProposalContractRefused["code"];
type RefusalLayer = DocumentWorkProposalContractRefused["layer"];

function canonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed()
    && value.normalize("NFC") === value && !value.includes("\u0000");
}

function boundedText(value: unknown, maximum: number, singleLine: boolean): Check {
  if (!canonicalText(value)) return "INVALID";
  if (singleLine && /[\u0000-\u001f\u007f]/u.test(value)) return "INVALID";
  return value.length <= maximum ? "OK" : "LIMIT";
}

function objective(value: unknown): Check {
  if (!canonicalText(value)) return "INVALID";
  return utf8.encode(value).byteLength <= DOCUMENT_WORK_PROPOSAL_LIMITS.maxObjectiveUtf8Bytes
    ? "OK" : "LIMIT";
}

function refuse(code: RefusalCode, layer: RefusalLayer): DocumentWorkProposalContractRefused {
  return Object.freeze({
    advisoryOnly: true, authority: "NONE", code, layer,
    ok: false as const, outcome: "REFUSED" as const,
  }) as DocumentWorkProposalContractRefused;
}

function resultFor(check: Check): DocumentWorkProposalContractRefused | null {
  if (check === "LIMIT") {
    return refuse("DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED", "LIMIT");
  }
  return check === "INVALID"
    ? refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") : null;
}

type Parsed<T> = { readonly value: T } | { readonly refusal: DocumentWorkProposalContractRefused };

function parseSources(value: unknown): Parsed<readonly DocumentWorkSourceBinding[]> {
  if (!isSafeArray(value) || value.length === 0) {
    return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
  }
  if (value.length > DOCUMENT_WORK_PROPOSAL_LIMITS.maxSources) {
    return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED", "LIMIT") };
  }
  const sources: DocumentWorkSourceBinding[] = [];
  const seen = new Set<string>();
  const identitiesByPath = new Map<string, { readonly byteLength: number; readonly hash: string }>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, SOURCE_KEYS, [])) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
    }
    const sourceRef = boundedText(
      entry["sourceRef"], DOCUMENT_WORK_PROPOSAL_LIMITS.maxRefCodeUnits, true,
    );
    const displayPath = boundedText(
      entry["displayPath"], DOCUMENT_WORK_PROPOSAL_LIMITS.maxDisplayPathCodeUnits, true,
    );
    const textRefusal = resultFor(sourceRef) ?? resultFor(displayPath);
    if (textRefusal !== null) return { refusal: textRefusal };
    if (!isHex64(entry["contentSha256"]) || !isSafeCount(entry["byteLength"])) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
    }
    const ref = entry["sourceRef"] as string;
    if (seen.has(ref)) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF", "IDENTITY") };
    }
    seen.add(ref);
    const displayPathValue = entry["displayPath"] as string;
    const pathIdentity = identitiesByPath.get(displayPathValue);
    if (pathIdentity !== undefined && (pathIdentity.hash !== entry["contentSha256"]
      || pathIdentity.byteLength !== entry["byteLength"])) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SOURCE_CONFLICT", "PROVENANCE") };
    }
    identitiesByPath.set(displayPathValue, {
      byteLength: entry["byteLength"], hash: entry["contentSha256"],
    });
    sources.push(Object.freeze({
      byteLength: entry["byteLength"], contentSha256: entry["contentSha256"],
      displayPath: displayPathValue, sourceRef: ref,
    }));
  }
  return { value: Object.freeze(sources.sort(compare("sourceRef"))) };
}

function parseCandidates(
  value: unknown,
  sourceRefs: ReadonlySet<string>,
): Parsed<readonly DocumentWorkCandidate[]> {
  if (!isSafeArray(value) || value.length === 0) {
    return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
  }
  if (value.length > DOCUMENT_WORK_PROPOSAL_LIMITS.maxCandidates) {
    return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED", "LIMIT") };
  }
  const candidates: DocumentWorkCandidate[] = [];
  const seenCandidates = new Set<string>();
  let citations = 0;
  for (const entry of value) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, CANDIDATE_KEYS, [])) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
    }
    const refCheck = boundedText(
      entry["candidateRef"], DOCUMENT_WORK_PROPOSAL_LIMITS.maxRefCodeUnits, true,
    );
    const titleCheck = boundedText(
      entry["title"], DOCUMENT_WORK_PROPOSAL_LIMITS.maxTitleCodeUnits, true,
    );
    const textRefusal = resultFor(refCheck) ?? resultFor(titleCheck)
      ?? resultFor(objective(entry["objective"]));
    if (textRefusal !== null) return { refusal: textRefusal };
    const refs = entry["sourceRefs"];
    if (!isSafeArray(refs) || refs.length === 0) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE") };
    }
    citations += refs.length;
    if (citations > DOCUMENT_WORK_PROPOSAL_LIMITS.maxCitations) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED", "LIMIT") };
    }
    const copiedRefs: string[] = [];
    const seenRefs = new Set<string>();
    for (const ref of refs) {
      const check = resultFor(boundedText(
        ref, DOCUMENT_WORK_PROPOSAL_LIMITS.maxRefCodeUnits, true,
      ));
      if (check !== null) return { refusal: check };
      const sourceRef = ref as string;
      if (seenRefs.has(sourceRef)) {
        return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF", "IDENTITY") };
      }
      seenRefs.add(sourceRef);
      copiedRefs.push(sourceRef);
    }
    const candidateRef = entry["candidateRef"] as string;
    if (seenCandidates.has(candidateRef)) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF", "IDENTITY") };
    }
    seenCandidates.add(candidateRef);
    candidates.push(Object.freeze({
      candidateRef, objective: entry["objective"] as string,
      sourceRefs: Object.freeze(copiedRefs.sort()), title: entry["title"] as string,
    }));
  }
  for (const entry of candidates) {
    if (entry.sourceRefs.some((sourceRef) => !sourceRefs.has(sourceRef))) {
      return { refusal: refuse("DOCUMENT_WORK_PROPOSAL_SOURCE_UNBOUND", "PROVENANCE") };
    }
  }
  return { value: Object.freeze(candidates.sort(compare("candidateRef"))) };
}

function compare<T extends string>(key: T): (left: Record<T, string>, right: Record<T, string>) => number {
  return (left, right) => left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0;
}

function parseProposal(value: unknown): DocumentWorkProposalResult {
  if (!isPlainRecord(value) || !hasExactKeys(value, ROOT_KEYS, [])) {
    return refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE");
  }
  if (value["schemaVersion"] !== DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION) {
    return refuse("DOCUMENT_WORK_PROPOSAL_SCHEMA_UNSUPPORTED", "SCHEMA");
  }
  const projectCheck = resultFor(boundedText(
    value["projectId"], DOCUMENT_WORK_PROPOSAL_LIMITS.maxRefCodeUnits, true,
  ));
  if (projectCheck !== null) return projectCheck;
  if (value["advisoryOnly"] !== true || value["authority"] !== "NONE"
    || value["submissionState"] !== "NOT_SUBMITTED" || value["truthClass"] !== "AGENT_REPORTED"
    || !isHex64(value["contextManifestDigest"]) || !isHex64(value["repositoryBaseHash"])) {
    return refuse("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID", "SHAPE");
  }
  const sources = parseSources(value["sources"]);
  if ("refusal" in sources) return sources.refusal;
  const candidates = parseCandidates(
    value["candidates"], new Set(sources.value.map((entry) => entry.sourceRef)),
  );
  if ("refusal" in candidates) return candidates.refusal;
  const proposal: DocumentWorkProposal = Object.freeze({
    advisoryOnly: true, authority: "NONE", candidates: candidates.value,
    contextManifestDigest: value["contextManifestDigest"], projectId: value["projectId"] as string,
    repositoryBaseHash: value["repositoryBaseHash"],
    schemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION, sources: sources.value,
    submissionState: "NOT_SUBMITTED", truthClass: "AGENT_REPORTED",
  });
  return Object.freeze({
    advisoryOnly: true, authority: "NONE", ok: true, outcome: "PROPOSED", proposal,
  });
}

/** Bounded byte ingress for an agent-reported proposal. It grants no submission authority. */
export function decodeDocumentWorkProposalBytes(input: unknown): DocumentWorkProposalResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) {
    return Object.freeze({
      advisoryOnly: true, authority: "NONE",
      code: "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED", decodeError: decoded,
      layer: "BOUNDED_JSON", ok: false, outcome: "REFUSED",
    });
  }
  return parseProposal(decoded.value);
}
