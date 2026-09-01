/**
 * The seven derivations expansion admission runs over one receipt.
 *
 * SCOPE. Deriving facts, and the order the derivations run in. The receipt
 * shape, the closed refusal vocabulary and the readers live in
 * `expansion-receipt.ts`; the composer that sequences budget, resource,
 * fairness and graph lives in `expansion-admission.ts`.
 *
 * Dependency-free by design, so every derivation is reachable from a plain
 * object in a test rather than only through a composed surface.
 *
 * ORDER IS PART OF THE CONTRACT. Containment is answered before disjointness: a
 * key outside the parent scope is not the parent's to hand out at all, so asking
 * whether two children collide over it would answer a question that cannot
 * arise. A refusal is therefore deterministic for a given receipt.
 */

import {
  ELIGIBLE_ORACLES, HEX_64, MAX_ITEMS, CHILD_KEYS, INPUT_KEYS, RECEIPT_KEYS,
  checkKeys, issue, malformed, own, readInteger, readKeyList, refuse, unknown,
} from "./expansion-receipt.js";
import type {
  ExpansionChildFacts, ExpansionEvidenceRefusal, ExpansionEvidenceResult, ExpansionInputFact,
} from "./expansion-receipt.js";
import { isPlainArray, isPlainRecord } from "../runtime-shape.js";

/**
 * Derives every admission fact from one receipt, or refuses.
 *
 * The receipt is `unknown` on purpose: a caller chooses every byte of it, so it
 * is parsed rather than trusted, and no declared length or count is used to
 * size anything before it is bounded.
 */
export function deriveExpansionEvidence(value: unknown): ExpansionEvidenceResult {
  if (!isPlainRecord(value)) return malformed("the receipt is not a plain record");
  const shapeIssue = checkKeys(value, RECEIPT_KEYS, "");
  if (shapeIssue !== null) return shapeIssue;

  const proposalId = own(value, "proposalId");
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return malformed("proposalId must be a non-empty string");
  }
  const revision = readInteger(value, "revision");
  const goalVersion = readInteger(value, "goalVersion");
  const graphEpoch = readInteger(value, "graphEpoch");
  const observedAtSequence = readInteger(value, "observedAtSequence");
  const horizonSequence = readInteger(value, "horizonSequence");
  if (revision === null || goalVersion === null || graphEpoch === null) {
    return malformed("revision, goalVersion and graphEpoch must be non-negative safe integers");
  }
  if (observedAtSequence === null || horizonSequence === null) {
    return malformed("observedAtSequence and horizonSequence must be non-negative safe integers");
  }

  // FRESHNESS. A receipt observed before its own horizon describes a world that
  // has since moved; it is stale rather than merely old.
  if (observedAtSequence < horizonSequence) {
    return refuse(issue(
      "EXPANSION_RECEIPT_STALE", "FRESHNESS",
      "the receipt was observed before its freshness horizon", null, [proposalId],
    ));
  }

  const parentScope = readKeyList(value, "parentScope");
  if (parentScope === null) return malformed("parentScope must be a bounded list of keys");
  const sourceDigests = readKeyList(value, "sourceDigests");
  if (sourceDigests === null || !sourceDigests.every((digest) => HEX_64.test(digest))) {
    return malformed("sourceDigests must be a bounded list of 64-character lowercase hex");
  }

  const children = own(value, "childScopes");
  if (!isPlainArray(children) || children.length === 0 || children.length > MAX_ITEMS) {
    return malformed("childScopes must be a bounded non-empty list");
  }
  return deriveChildren(children, {
    proposalId, revision, goalVersion, graphEpoch, observedAtSequence,
    parentScope: new Set(parentScope), sourceDigests,
  });
}

interface ReceiptHeader {
  readonly proposalId: string;
  readonly revision: number;
  readonly goalVersion: number;
  readonly graphEpoch: number;
  readonly observedAtSequence: number;
  readonly parentScope: ReadonlySet<string>;
  readonly sourceDigests: readonly string[];
}

/** The six per-child derivations, in a fixed order so a refusal is deterministic. */
function deriveChildren(children: readonly unknown[], header: ReceiptHeader): ExpansionEvidenceResult {
  const childKeys: string[] = [];
  const childFacts: ExpansionChildFacts[] = [];
  const seenChildKeys = new Set<string>();
  const claimed = new Set<string>();
  const digests = new Set(header.sourceDigests);

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const at = `childScopes[${index}].`;
    if (!isPlainRecord(child)) return malformed(`${at.slice(0, -1)} is not a plain record`);
    const shapeIssue = checkKeys(child, CHILD_KEYS, at);
    if (shapeIssue !== null) return shapeIssue;

    const childKey = own(child, "childKey");
    if (typeof childKey !== "string" || childKey.length === 0) {
      return malformed(`${at}childKey must be a non-empty string`);
    }
    // The child IDENTITY is de-duplicated like every claimed scope key below: a
    // repeated key would flow a duplicated list into everything bound to it.
    if (seenChildKeys.has(childKey)) {
      return malformed(`${at}childKey ${childKey} duplicates an earlier child`);
    }
    seenChildKeys.add(childKey);
    const scope = readKeyList(child, "scope");
    if (scope === null || scope.length === 0) {
      return malformed(`${at}scope must be a bounded non-empty list`);
    }

    // CONTAINMENT before disjointness: a key outside the parent is not the
    // parent's to hand out at all, so it is answered before asking whether two
    // children collide over it.
    for (const key of scope) {
      if (!header.parentScope.has(key)) {
        return refuse(issue(
          "EXPANSION_CONTAINMENT_VIOLATED", "CONTAINMENT",
          "a child scope key is outside the parent scope", null, [childKey, key],
        ));
      }
    }
    for (const key of scope) {
      if (claimed.has(key)) {
        return refuse(issue(
          "EXPANSION_SCOPE_OVERLAP", "SCOPE",
          "two children claim the same scope key", null, [childKey, key],
        ));
      }
      claimed.add(key);
    }

    const oracleKind = own(child, "oracleKind");
    if (typeof oracleKind !== "string") return malformed(`${at}oracleKind must be a string`);
    if (oracleKind === "UNKNOWN") return unknown(`${at}oracleKind`);
    if (!(ELIGIBLE_ORACLES as readonly string[]).includes(oracleKind)) {
      return refuse(issue(
        "EXPANSION_ORACLE_INELIGIBLE", "ORACLE",
        "the child has no eligible oracle", null, [childKey, oracleKind],
      ));
    }

    const completion = own(child, "completion");
    if (typeof completion !== "string") return malformed(`${at}completion must be a string`);
    if (completion === "UNKNOWN") return unknown(`${at}completion`);
    if (completion !== "CLOSED") {
      return refuse(issue(
        "EXPANSION_COMPLETION_NOT_CLOSED", "CONTAINMENT",
        "the child's completion is not closed", null, [childKey, completion],
      ));
    }

    const inputs: ExpansionInputFact[] = [];
    const inputIssue = deriveInputs(child, at, childKey, digests, inputs);
    if (inputIssue !== null) return inputIssue;
    childKeys.push(childKey);
    childFacts.push(Object.freeze({
      scope: Object.freeze([...scope]), oracleKind, completion, inputs: Object.freeze(inputs),
    }));
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      proposalId: header.proposalId,
      revision: header.revision,
      goalVersion: header.goalVersion,
      graphEpoch: header.graphEpoch,
      observedAtSequence: header.observedAtSequence,
      childKeys: Object.freeze([...childKeys]),
      childWidth: childKeys.length,
      sourceDigests: Object.freeze([...header.sourceDigests]),
      childFacts: Object.freeze([...childFacts]),
    }),
  });
}

/** Materializability and the source-digest binding for one child's inputs. */
function deriveInputs(
  child: Record<string, unknown>,
  at: string,
  childKey: string,
  digests: ReadonlySet<string>,
  into: ExpansionInputFact[],
): ExpansionEvidenceRefusal | null {
  const inputs = own(child, "inputs");
  if (!isPlainArray(inputs) || inputs.length === 0 || inputs.length > MAX_ITEMS) {
    return malformed(`${at}inputs must be a bounded non-empty list`);
  }
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const path = `${at}inputs[${index}].`;
    if (!isPlainRecord(input)) return malformed(`${path.slice(0, -1)} is not a plain record`);
    const shapeIssue = checkKeys(input, INPUT_KEYS, path);
    if (shapeIssue !== null) return shapeIssue;

    const materialization = own(input, "materialization");
    if (typeof materialization !== "string") return malformed(`${path}materialization must be a string`);
    if (materialization === "UNKNOWN") return unknown(`${path}materialization`);
    if (materialization !== "MATERIALIZED") {
      return refuse(issue(
        "EXPANSION_INPUT_NOT_MATERIALIZABLE", "INPUT",
        "the input is not materializable", null, [childKey, materialization],
      ));
    }

    // A MATERIALIZED input without a digest present in the receipt's own source
    // set is unbound: nothing ties the bytes it names to the facts this
    // admission is about.
    const digest = own(input, "digest");
    if (typeof digest !== "string" || !HEX_64.test(digest)) {
      return malformed(`${path}digest must be 64-character lowercase hex when materialized`);
    }
    if (!digests.has(digest)) {
      return refuse(issue(
        "EXPANSION_SOURCE_DIGEST_MISMATCH", "SOURCE",
        "the input digest is absent from the receipt's source digests", null, [childKey],
      ));
    }
    const inputKey = own(input, "inputKey");
    if (typeof inputKey !== "string" || inputKey.length === 0) {
      return malformed(`${path}inputKey must be a non-empty string`);
    }
    into.push(Object.freeze({ inputKey, digest }));
  }
  return null;
}

