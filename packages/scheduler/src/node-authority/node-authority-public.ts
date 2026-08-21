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
 * NO RUNTIME LAYER ROSTER IS PUBLISHED HERE, and this is not an oversight.
 *
 * `LAYER_NAMES` is module-private in BOTH producing modules
 * (node-authority-contract.ts:23, node-authority-recursion.ts:12) and both say
 * in prose why: the security lane rosters every column-0
 * `export const *_LAYER(S)` declaration against a pinned size. Minting
 * `NODE_AUTHORITY_LAYERS` / `NODE_AUTHORITY_RECURSION_LAYERS` here would be
 * counted by that live source scan (tests/security/boundary-roster.security.ts,
 * DECLARATION_PATTERN at :366, SCAN_ROOTS covering `packages`) and would red a
 * file this task does not own — reversing a written security decision as a side
 * effect of a forwarding change.
 *
 * The runtime rosters are DEFERRED to task-515d2f90, which owns the security
 * files and lands the roster entries, the EXPECTED_ROSTER_SIZE and distribution
 * bumps, and the hostile arms together, the way this suite's own header records
 * every prior boundary landing. The layer VOCABULARY is still reachable from the
 * root at type level: `NodeAuthorityLayer` above and `NodeAuthorityRecursionLayer`
 * beside it, so a consumer can still name which layer refused, exhaustively.
 */
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
