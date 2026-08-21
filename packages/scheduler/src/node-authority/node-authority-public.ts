/**
 * Node-authority half of the package root: design 199/255's execution-contract
 * codec, the recursive authority derivation over a validated graph, and the
 * closed vocabularies a durable consumer needs to READ a refusal rather than
 * re-derive one.
 *
 * This module publishes nothing the six node-authority modules do not already
 * export, and withholds every internal half of admission. It exists so neither
 * it nor `index.ts` sits past the per-file size rule: the root was at 249 of its
 * 250 lines, so the ~40 specifiers below could never have been inlined there.
 * The root forwards this module wholesale, so the reviewed namespace is exactly
 * this set plus what the root already published.
 *
 * The curation lives in the export specifiers, never in the file boundary: each
 * family's rationale travels WITH its block, because that prose is the argument
 * for what the family publishes and what it deliberately does not.
 */
import type { NodeAuthorityLayer } from "./node-authority-contract.js";
import type { NodeAuthorityRecursionLayer } from "./node-authority-recursion.js";
/**
 * The codec boundary. `createNodeDefinition` and `admitNodeDefinition` are the
 * only routes to a `NodeDefinition`, and `encodeNodeDefinition` /
 * `decodeNodeDefinitionBytes` the only routes to and from its bytes.
 *
 * WITHHELD from this same module: `draftNodeAuthority`. It yields an
 * IDENTITY-LESS draft — the caller-stated half before any derived key exists —
 * which reads like a definition and is not one. A consumer holding it could
 * carry a shape past a seam that only ever validated the admitted form.
 */
export {
  admitNodeDefinition,
  createNodeDefinition,
  decodeNodeDefinitionBytes,
  encodeNodeDefinition,
} from "./node-authority-codec.js";
export type {
  NodeAuthorityBody,
  NodeAuthorityBytesResult,
  NodeAuthorityResult,
} from "./node-authority-codec.js";
/**
 * Recursive authority over a whole snapshot, plus its own refusal vocabulary.
 * A consumer that can derive the set but cannot name why a derivation refused
 * would have to string-match the message, so the codes travel with it.
 */
export {
  deriveNodeAuthoritySet,
  NODE_AUTHORITY_RECURSION_CODES,
} from "./node-authority-recursion.js";
export type {
  NodeAuthorityEntry,
  NodeAuthorityRecursionCode,
  NodeAuthorityRecursionIssue,
  NodeAuthorityRecursionLayer,
  NodeAuthorityRecursionResult,
} from "./node-authority-recursion.js";
/**
 * The stable contract vocabulary: schema identity, the closed rosters an
 * admission caller must satisfy, the key sets it may and may not state, the
 * refusal codes, and the limit table. All frozen, all inert — publishing them
 * lets a consumer validate its own input BEFORE calling, instead of copying the
 * rosters and drifting from them.
 *
 * WITHHELD from this same module: the preimage and canonical-text mechanics
 * (`canonicalText`, `nodeBodyDigest`, `canonicalEnvelopeJson`), because a
 * consumer holding them could mint a body digest for a definition the codec
 * never admitted — the exact bypass `encodeNodeDefinition` exists to make
 * impossible. `ok`, `refuse`, `passthrough`, `compareStrings` and `deepFreeze`
 * stay private for the same reason the binding module's refusal constructors do:
 * they manufacture a verdict from arbitrary strings.
 */
export {
  NODE_ADMISSION_GATE_POLICIES,
  NODE_ADMISSION_GATE_POLICY_WITNESS,
  NODE_ADMISSION_METERS,
  NODE_AUTHORITY_CODES,
  NODE_AUTHORITY_DIGEST_DOMAIN,
  NODE_AUTHORITY_DRAFT_KEYS,
  NODE_AUTHORITY_EXCLUDED_STATE_KEYS,
  NODE_AUTHORITY_FORBIDDEN_IDENTITY_KEYS,
  NODE_AUTHORITY_LIMITS,
  NODE_AUTHORITY_SCHEMA_TAG,
  NODE_AUTHORITY_SCHEMA_VERSION,
  NODE_DEFINITION_KEYS,
  NODE_JOIN_ROLES,
} from "./node-authority-contract.js";
export type {
  NodeAdmissionAmount,
  NodeAdmissionGatePolicy,
  NodeAdmissionMeter,
  NodeAuthorityCode,
  NodeAuthorityDraft,
  NodeAuthorityDraftResult,
  NodeAuthorityEdgeInput,
  NodeAuthorityIssue,
  NodeAuthorityLayer,
  NodeAuthorityRefusal,
  NodeCriterionBinding,
  NodeDefinition,
  NodeDefinitionKey,
  NodeDependencyEntry,
  NodeJoinRole,
} from "./node-authority-contract.js";
/**
 * Compile-pins a hand-carried roster to a module-private union in BOTH
 * directions, which is the only reason re-declaring these values is honest.
 *
 * A BOGUS member fails `Roster extends readonly [Union, ...Union[]]`. A DROPPED
 * member leaves `Exclude<Union, Roster[number]>` inhabited, which turns the rest
 * parameter into `[never]` and makes the one-argument call an arity error. The
 * two guards are independent: neither can answer for the other's condition, so
 * dropping either one leaves a real way for the roster to detach in silence.
 */
const publishedRoster = <Union extends string>() =>
  <Roster extends readonly [Union, ...Union[]]>(
    roster: Roster,
    ..._exhaustive: [Exclude<Union, Roster[number]>] extends [never] ? [] : [never]
  ): Readonly<Roster> => Object.freeze(roster);
/**
 * THE RUNTIME LAYER ROSTERS, published here and nowhere else (task-515d2f90).
 *
 * This cashes the deferral task-210efa47's branch-A amendment recorded in this
 * exact spot: minting a column-0 `export const *_LAYER(S)` is counted by the live
 * source scan in `tests/security/boundary-roster.security.ts`
 * (DECLARATION_PATTERN :366, SCAN_ROOTS covering `packages`), so the mint could
 * not land until one task owned both it and the security files. It does now: the
 * two roster rows, EXPECTED_ROSTER_SIZE 102->104, the `packages/scheduler`
 * distribution 8->10, the integrity axis pin 17->19 and six BEFORE/AFTER/RACE
 * arms land in the same commit. The axis is `integrity` by SUBJECT under the
 * human REPL ruling recorded as comment-2a7c5a33: these name the refusal layers
 * of the canonical node-body codec and of the recursion digest that feed
 * GraphRevisionContent v3, not an in-force scheduling decision.
 *
 * THE VALUES ARE RE-DECLARED, NOT RE-EXPORTED, and that is deliberate.
 * `LAYER_NAMES` is module-private in BOTH producing modules
 * (node-authority-contract.ts:101, node-authority-recursion.ts:27) and that
 * privacy is a documented security decision this module must not reverse. The
 * compile pins above are what stop a re-declared copy from drifting: it is
 * bound to the private union in both directions, so the copy cannot gain a
 * member the producer never named, and cannot lose one the producer added.
 */
export const NODE_AUTHORITY_LAYERS = publishedRoster<NodeAuthorityLayer>()([
  "NODE_AUTHORITY_ADMISSION",
  "NODE_AUTHORITY_BUDGET",
  "NODE_AUTHORITY_CODEC",
  "NODE_AUTHORITY_DEPENDENCIES",
  "NODE_AUTHORITY_IDENTITY",
  "NODE_AUTHORITY_LIMITS",
  "NODE_AUTHORITY_PROOFS",
  "NODE_AUTHORITY_SCHEMA",
  "NODE_AUTHORITY_SCOPES",
  "DEPENDENCY_CONTRACT",
  "PLANNING_SOURCE",
] as const) satisfies readonly NodeAuthorityLayer[];
/**
 * The recursion's own two, then the codec's eleven verbatim: a foreign verdict
 * travels out of `deriveNodeAuthoritySet` unchanged, so a consumer reading a
 * recursion refusal can meet any of the thirteen. Spread rather than retyped, so
 * the two rosters cannot disagree about the eleven they share.
 */
export const NODE_AUTHORITY_RECURSION_LAYERS =
  publishedRoster<NodeAuthorityRecursionLayer>()([
    "NODE_AUTHORITY_RECURSION",
    "GRAPH_SNAPSHOT",
    ...NODE_AUTHORITY_LAYERS,
  ] as const) satisfies readonly NodeAuthorityRecursionLayer[];
/**
 * `snapshotIdentityHash` is the graph's own structural identity, and publishing
 * it does NOT widen the content-identity surface. It accepts ONLY the
 * brand-protected `ValidatedGraph`, so it cannot hash a structure the kernel
 * never validated. It has to be reachable because a hard-edge dependency
 * contract must carry `graphBindingDigest === snapshotIdentityHash(graph)`
 * BEFORE any content encode can exist — `closeContracts` refuses
 * NODE_AUTHORITY_RECURSION_BINDING_MISMATCH otherwise
 * (node-authority-recursion.ts:164) — and the only other structural-identity
 * route, `GraphContent.snapshotIdentity`, exists only AFTER a successful encode.
 *
 * `encodeGraphContent` remains the sole route to a `graphContentHash`, so the
 * root's existing withholding comment stays true: the wire mechanics behind the
 * codec are still private.
 */
export { snapshotIdentityHash } from "../graph-content-format.js";
/**
 * The authenticated half of a v3 content record, index-aligned and ascending by
 * `nodeKey`. Published as the shape a consumer composes; the readers and
 * projectors that would let one mint it without an encode stay withheld.
 */
export type { NodeAuthoritySection } from "../graph-content.js";
/**
 * WITHHELD TYPES, deliberately never re-exported: `Read` (contract) is the
 * internal result wrapper every private reader returns; `DerivedIdentity`,
 * `AdmittedPlanning` and `ComposedEdges` (compose) are partial verdicts of a
 * half-finished admission, and a consumer that could name one could hold a
 * definition that passed three of five gates; `NodeAuthorityBudget` (budget)
 * belongs to the measurement seam, whose published authority is
 * `normalizeUsageMeasurement`, not this one. A runtime leak check cannot see a
 * type, so these are pinned by the negative NodeNext probes instead.
 */
