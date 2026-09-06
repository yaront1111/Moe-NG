/**
 * The exact external contract for the operator's `preview.decide` command.
 *
 * WHAT THIS MODULE IS. Vocabulary only. It starts no preview process, captures no screenshot,
 * writes no receipt and renders nothing: those belong to the preview RUNNER
 * (task-f5a74c23f8754665ab9d36cba386e1d0). This file reads nothing, writes nothing and mints no
 * authority — it says what an operator may present on the wire and which refusal answers when
 * they present something else. It mirrors `../planning/expansion-request-contracts.ts`, this
 * repo's worked example of a command contract with a closed code->layer map.
 *
 * WHAT A CALLER MAY SAY, and why the arity is VARIANT. A decision is one of two shapes, and the
 * shape is what carries the meaning:
 *   APPROVE — exactly `decision` and `previewRef`. An approval that also carried findings would
 *             be a contradiction the daemon had to resolve by guessing, so the decoder refuses
 *             it structurally rather than dropping the member.
 *   REJECT  — exactly `decision`, `findings` and `previewRef`, with at least one finding, each
 *             naming the node to rework. A rejection with nothing to rework tells the graph
 *             nothing, so an empty roster is refused rather than recorded as a silent no-op.
 * `PREVIEW_DECIDE_PAYLOAD_KEYS` is the UNION of the two shapes because the HTTP seam's
 * `checkPayload` is an allow-list (`http/http-command-ingress.ts:118`) — it refuses a key OUTSIDE
 * the roster and never demands one inside it. The seam therefore fences the outer boundary and
 * `decodePreviewDecidePayload` fences the exact shape below it; neither can be widened alone.
 *
 * WHY THE DECODER REFUSES AN UNKNOWN KEY RATHER THAN IGNORING IT. Silently dropping an
 * unexpected member would let an operator believe they had supplied something load-bearing —
 * a `severity`, a `retry`, a `goalRef` — and let a reviewer believe the field was read. An
 * exact-arity record refuses, so the wire meaning of a decision cannot drift under either
 * reading.
 *
 * WHY THE LAYER IS DERIVED FROM THE CODE. `previewRefusal` takes NO layer argument: the closed
 * `PREVIEW_CODE_LAYERS` map is the single source, so a call site cannot mint a refusal whose
 * code and layer disagree, and `PREVIEW_CODES` cannot drift from the layer map because it IS
 * that map's key set.
 *
 * WHERE EACH CODE IS EXERCISED. `PREVIEW_DECISION_INVALID` is raised HERE, by the decoder below,
 * and every one of its conditions is asserted in `preview-contracts.test.ts`. The other three
 * describe conditions this row does not own and cannot reach without inventing a fake one:
 * `PREVIEW_COMMAND_MISSING`, `PREVIEW_START_TIMEOUT` and `PREVIEW_GOAL_NOT_LANDED` are raised by
 * the runner in task-f5a74c23f8754665ab9d36cba386e1d0 and are exercised there. They are declared
 * here so the runner cannot mint a fifth spelling of a refusal the vocabulary already names.
 */

export const PREVIEW_DECIDE_COMMAND_KIND = "preview.decide" as const;
export const PREVIEW_START_COMMAND_KIND = "preview.start" as const;

/**
 * START'S EXACT ARITY - AND `workspace` IS DELIBERATELY NOT ON IT.
 *
 * `PreviewRunRequest` (preview-runner.ts) carries `{goalId, sha, workspace}`, but
 * `workspaceScripts` (preview-runner.ts) READS `<workspace>/package.json` and the runner then
 * SPAWNS a script out of it. A caller-supplied workspace is therefore arbitrary command
 * execution on the daemon host for anyone who can reach the command plane. The handler resolves
 * the workspace from the daemon's OWN bound configuration instead (`preview-start-command.ts`),
 * and an unconfigured daemon refuses rather than guessing.
 *
 * DO NOT "helpfully" ADD THE THIRD KEY. The decoder below enforces exact arity, so a payload
 * carrying `workspace` is REFUSED, and `preview-start-command.test.ts` asserts that refusal by
 * code and layer precisely so this decision cannot be undone quietly.
 */
export const PREVIEW_START_PAYLOAD_KEYS = Object.freeze(["goalId", "sha"] as const);

/** The two decisions, and nothing else. Sorted; compared by identity, never by truthiness. */
export const PREVIEW_DECISIONS = Object.freeze(["APPROVE", "REJECT"] as const);

export type PreviewDecision = (typeof PREVIEW_DECISIONS)[number];

/** APPROVE's EXACT arity. A `findings` member here is an unknown key, not an empty roster. */
export const PREVIEW_APPROVE_PAYLOAD_KEYS = Object.freeze(["decision", "previewRef"] as const);

/** REJECT's EXACT arity, sorted. `findings` is required, and required to be non-empty. */
export const PREVIEW_REJECT_PAYLOAD_KEYS = Object.freeze([
  "decision", "findings", "previewRef",
] as const);

/**
 * The UNION of both shapes — the allow-list the HTTP seam advertises. ALIASED to the REJECT
 * roster rather than retyped, because REJECT is APPROVE plus `findings` and a second hand-written
 * copy is how an advertised roster and an enforced one come to disagree while both look right.
 * The vocabulary imports THIS; widening a variant above therefore widens the advertisement in
 * the same edit. `preview-contracts.test.ts` pins the superset relation both ways so a future
 * APPROVE-only member cannot be added to a variant and left off the advertisement.
 */
export const PREVIEW_DECIDE_PAYLOAD_KEYS = PREVIEW_REJECT_PAYLOAD_KEYS;

/** One finding's EXACT arity: which node to rework, and what to rework about it. */
export const PREVIEW_FINDING_KEYS = Object.freeze(["detail", "nodeRef"] as const);

/** Which surface answered a refusal. Closed: a refusal outside this roster is a bug. */
export const PREVIEW_LAYERS = Object.freeze([
  "GOAL_AUTHORITY", "REQUEST", "RUNNER",
] as const);

export type PreviewLayer = (typeof PREVIEW_LAYERS)[number];

/**
 * Every refusal the preview path can mint, mapped to the layer that mints it. `PREVIEW_CODES`
 * below is DERIVED from these keys, so the two can never disagree.
 */
export const PREVIEW_CODE_LAYERS = Object.freeze({
  /** RUNNER: the configured preview command is not present on the host. */
  PREVIEW_COMMAND_MISSING: "RUNNER",
  /** REQUEST: the decoder below. The only code this row's own production surface raises. */
  PREVIEW_DECISION_INVALID: "REQUEST",
  /** GOAL_AUTHORITY: the goal behind the preview never reached a landed revision. */
  PREVIEW_GOAL_NOT_LANDED: "GOAL_AUTHORITY",
  /** REQUEST: `decodePreviewStartPayload` below. Its own code rather than the decide decoder's,
   *  so an operator screen can tell WHICH wire was malformed; both answer at REQUEST because
   *  both are the same layer. Added to THIS MAP rather than spelled at a call site, so
   *  `PREVIEW_CODES` picks it up with no second edit and no call site can pair it with a
   *  layer the vocabulary disagrees with. */
  PREVIEW_START_PAYLOAD_INVALID: "REQUEST",
  /** RUNNER: the preview process never became answerable inside its budget. */
  PREVIEW_START_TIMEOUT: "RUNNER",
} as const satisfies Readonly<Record<string, PreviewLayer>>);

export type PreviewCode = keyof typeof PREVIEW_CODE_LAYERS;

/** Derived, never restated: the roster IS the layer map's key set. */
export const PREVIEW_CODES: readonly PreviewCode[] = Object.freeze(
  (Object.keys(PREVIEW_CODE_LAYERS) as PreviewCode[]).sort(),
);

/** Core's own `MAX_TEXT`; a ref or detail longer than this could not reach the reducer. */
export const MAX_PREVIEW_TEXT = 256;

/** A bound, not a policy: an unbounded roster is how one decision becomes a denial of service. */
export const MAX_PREVIEW_FINDINGS = 64;

export interface PreviewFinding {
  readonly detail: string;
  readonly nodeRef: string;
}

export interface PreviewApproveDecision {
  readonly decision: "APPROVE";
  readonly previewRef: string;
}

export interface PreviewRejectDecision {
  readonly decision: "REJECT";
  readonly findings: readonly PreviewFinding[];
  readonly previewRef: string;
}

export type PreviewDecidePayload = PreviewApproveDecision | PreviewRejectDecision;

/** What `preview.start` names: WHICH goal and WHICH landed revision. Never where to run it. */
export interface PreviewStartPayload {
  readonly goalId: string;
  readonly sha: string;
}

export interface PreviewRefusal {
  readonly code: PreviewCode;
  readonly layer: PreviewLayer;
  readonly ok: false;
  /** The delegated surface's own code, copied verbatim; null when this slice refused alone. */
  readonly sourceCode: string | null;
  /** The delegated surface's own layer, copied verbatim; null when this slice refused alone. */
  readonly sourceLayer: string | null;
}

export type PreviewDecidePayloadResult =
  | { readonly ok: true; readonly payload: PreviewDecidePayload }
  | PreviewRefusal;

export type PreviewStartPayloadResult =
  | { readonly ok: true; readonly payload: PreviewStartPayload }
  | PreviewRefusal;

/**
 * The ONLY way to mint a preview refusal. It takes no layer: `PREVIEW_CODE_LAYERS` decides,
 * so a call site cannot pair a code with a layer that contradicts it.
 */
export function previewRefusal(
  code: PreviewCode,
  sourceCode: string | null = null,
  sourceLayer: string | null = null,
): PreviewRefusal {
  return Object.freeze({
    code,
    layer: PREVIEW_CODE_LAYERS[code],
    ok: false as const,
    sourceCode,
    sourceLayer,
  });
}

export function isPreviewRefusal(value: unknown): value is PreviewRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** Bounded, NUL-free, non-empty text. A NUL byte reaches the store as a malformed id. */
export function boundedPreviewText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_PREVIEW_TEXT && !value.includes("\u0000");
}

/** Exact arity over own enumerable string keys, with no inherited member admitted. */
export function exactPreviewRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string")) return null;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !property.enumerable || !("value" in property)) return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Read `decision` without admitting the record: the arity to demand depends on its value. */
function decisionOf(value: unknown): PreviewDecision | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const property = Object.getOwnPropertyDescriptor(value, "decision");
  if (property === undefined || !property.enumerable || !("value" in property)) return null;
  const decision = property.value as unknown;
  return PREVIEW_DECISIONS.find((candidate) => candidate === decision) ?? null;
}

/** One finding, copied into a fresh frozen record. Null is the caller's refusal signal. */
function findingOf(value: unknown): PreviewFinding | null {
  const item = exactPreviewRecord(value, PREVIEW_FINDING_KEYS);
  if (item === null) return null;
  if (!PREVIEW_FINDING_KEYS.every((key) => boundedPreviewText(item[key]))) return null;
  return Object.freeze({
    detail: item["detail"] as string,
    nodeRef: item["nodeRef"] as string,
  });
}

/** A non-empty, bounded roster of findings, each naming the node it reworks. */
function findingsOf(value: unknown): readonly PreviewFinding[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > MAX_PREVIEW_FINDINGS) return null;
  const findings: PreviewFinding[] = [];
  for (const entry of value as readonly unknown[]) {
    const finding = findingOf(entry);
    if (finding === null) return null;
    findings.push(finding);
  }
  return Object.freeze(findings);
}

/**
 * The ONE decode of operator bytes in this slice. It copies every accepted member into a fresh
 * frozen record, so a caller retaining a reference to the input cannot mutate what the daemon
 * went on to persist. Every refusal is PREVIEW_DECISION_INVALID at REQUEST: the decoder is one
 * layer and it answers with one code, so a reader cannot tell a malformed decision from an
 * unknown key by the code alone — which is the point. The wire is refused either way, and the
 * three runner codes stay reserved for conditions a payload cannot create.
 */
export function decodePreviewDecidePayload(value: unknown): PreviewDecidePayloadResult {
  const decision = decisionOf(value);
  if (decision === null) return previewRefusal("PREVIEW_DECISION_INVALID");
  const keys = decision === "APPROVE"
    ? PREVIEW_APPROVE_PAYLOAD_KEYS
    : PREVIEW_REJECT_PAYLOAD_KEYS;
  const item = exactPreviewRecord(value, keys);
  if (item === null) return previewRefusal("PREVIEW_DECISION_INVALID");
  if (!boundedPreviewText(item["previewRef"])) {
    return previewRefusal("PREVIEW_DECISION_INVALID");
  }
  const previewRef = item["previewRef"] as string;
  if (decision === "APPROVE") {
    return Object.freeze({
      ok: true as const,
      payload: Object.freeze({ decision, previewRef }),
    });
  }
  const findings = findingsOf(item["findings"]);
  if (findings === null) return previewRefusal("PREVIEW_DECISION_INVALID");
  return Object.freeze({
    ok: true as const,
    payload: Object.freeze({ decision, findings, previewRef }),
  });
}

/**
 * A `goalId` or `sha` that would escape `.moe-next/previews/<goalId>/<sha>/` if it were joined.
 *
 * BOTH VALUES ARE PATH SEGMENTS AND AN AGGREGATE KEY. `previewReceiptId` hashes them
 * (preview-receipt-contracts.ts) and `previewCaptureDirectory` JOINS them, so a separator or a
 * `..` here would put one goal's captures inside another's directory - or outside the project
 * entirely - while the receipt advertised them as this run's.
 *
 * NFC IS PART OF THE RULE, not decoration. Two spellings of the same visible id hash to two
 * DIFFERENT receipt ids, so a non-NFC form would defeat the deduplication `preview-supervisor`
 * relies on to stop a second server binding a port the first already took.
 *
 * `preview-runner.ts containedSegment` applies the same rule one layer down. That is a SECOND
 * gate, deliberately, and not a reason to skip this one: this decoder is the only thing standing
 * between operator bytes and the receipt id, and a payload refused here never reaches a spawn.
 */
const UNSAFE_PREVIEW_SEGMENT = /[\u0000-\u001f\s/\\<>:"|?*]/u;

export function containedPreviewSegment(value: unknown): value is string {
  return boundedPreviewText(value) && !value.includes("..")
    && !UNSAFE_PREVIEW_SEGMENT.test(value)
    && value !== "." && value.normalize("NFC") === value;
}

/**
 * The ONE decode of `preview.start`'s operator bytes. EXACT ARITY over own enumerable keys:
 * a missing key and an unknown key refuse identically, which is what keeps `workspace` off the
 * wire (see `PREVIEW_START_PAYLOAD_KEYS` above - that is the security decision of this command,
 * not a shape preference). Every refusal is `PREVIEW_START_PAYLOAD_INVALID` at REQUEST, minted
 * through `previewRefusal`, which takes no layer: `PREVIEW_CODE_LAYERS` decides.
 *
 * Accepted members are copied into a fresh frozen record, so a caller retaining a reference to
 * the input cannot mutate what the daemon then hashes into a receipt id.
 */
export function decodePreviewStartPayload(value: unknown): PreviewStartPayloadResult {
  const item = exactPreviewRecord(value, PREVIEW_START_PAYLOAD_KEYS);
  if (item === null) return previewRefusal("PREVIEW_START_PAYLOAD_INVALID");
  if (!PREVIEW_START_PAYLOAD_KEYS.every((key) => containedPreviewSegment(item[key]))) {
    return previewRefusal("PREVIEW_START_PAYLOAD_INVALID");
  }
  return Object.freeze({
    ok: true as const,
    payload: Object.freeze({ goalId: item["goalId"] as string, sha: item["sha"] as string }),
  });
}
