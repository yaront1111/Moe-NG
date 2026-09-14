import { admitGoalBrief, admitGoalSource, buildNextAllowedCommands, decodeBoundedJsonBytes } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import type { GoalDraft } from "../goals/goal-model.js";
import { briefOfDraft } from "../goals/live-goal-create.js";

export interface ReplanIntent {
  readonly version: "moe-replan-intent/1";
  readonly projectId: string; readonly origin: string;
  readonly phase: "DECISION_UNCERTAIN" | "CREATE_PENDING";
  readonly predecessorGoalId: string; readonly nodeRef: string; readonly reviewVersion: number;
  readonly planningRunRef: string; readonly nodeKey: string; readonly title: string;
  readonly escalationOffer: NextAllowedCommand; readonly createOffer: NextAllowedCommand;
  readonly draft: GoalDraft;
}
export type ReplanJournalRead = { readonly status: "ABSENT" }
  | { readonly status: "PRESENT"; readonly intents: readonly ReplanIntent[] }
  | { readonly status: "INVALID"; readonly code: string }
  | { readonly status: "UNAVAILABLE"; readonly code: string };
export type ReplanJournalResult = { readonly ok: true } | { readonly ok: false; readonly code: string };
export interface ReplanJournal {
  read(): ReplanJournalRead;
  put(intent: ReplanIntent): ReplanJournalResult;
  remove(key: string): ReplanJournalResult;
}
export function replanIntentKey(intent: Pick<ReplanIntent, "predecessorGoalId" | "nodeRef" | "reviewVersion">): string {
  return JSON.stringify([intent.predecessorGoalId, intent.nodeRef, intent.reviewVersion]);
}
const VERSION = "moe-replan-intent/1" as const;
const MAX_BYTES = 1_048_576, MAX_INTENTS = 8;
const utf8 = new TextEncoder();
const failed = (code: string): ReplanJournalResult => Object.freeze({ ok: false, code });
const success: ReplanJournalResult = Object.freeze({ ok: true });
const invalid = (): ReplanJournalRead => Object.freeze({ status: "INVALID", code: "REPLAN_JOURNAL_INVALID" });
const unavailable = (): ReplanJournalRead => Object.freeze({ status: "UNAVAILABLE", code: "REPLAN_JOURNAL_UNAVAILABLE" });

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === "string"
    && (required.includes(key) || optional.includes(key)) && "value" in descriptors[key]!)
    && required.every((key) => Object.hasOwn(descriptors, key));
}
function text(value: unknown, maximum: number, nonblank = true): value is string {
  return typeof value === "string" && value.length <= maximum && value.isWellFormed()
    && (!nonblank || value.trim() !== "") && utf8.encode(value).byteLength <= maximum;
}
function identity(value: unknown): value is string {
  return text(value, 4096) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function origin(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}
function offer(value: unknown, kind: "escalation.decide" | "goal.create_with_source"): NextAllowedCommand | null {
  if (!record(value, ["commandEnvelopeVersion", "commandId", "commandKind", "expectedVersion",
    "inputSchemaVersion", "targetAggregateId"]) || !identity(value["commandId"])
    || !identity(value["inputSchemaVersion"]) || !identity(value["targetAggregateId"])) return null;
  const parsed = buildNextAllowedCommands({ aggregate: "GOAL", state: "EXECUTION_ENABLED" }, [value])[0];
  return parsed?.commandKind === kind ? parsed : null;
}
function draft(value: unknown): GoalDraft | null {
  if (!record(value, ["outcome", "title", "acceptanceCriteria", "budgetEnvelope", "prd"], ["riskClass"])
    || !text(value["outcome"], 32768) || !text(value["title"], 1024)
    || !text(value["budgetEnvelope"], 32768, false)) return null;
  const criteria = value["acceptanceCriteria"], prd = value["prd"], risk = value["riskClass"];
  if (!Array.isArray(criteria) || criteria.length > 1024 || Object.keys(criteria).length !== criteria.length
    || !criteria.every((entry: unknown) => text(entry, 32768))
    || !record(prd, ["localSha256", "mediaType", "name", "size", "text"])
    || !text(prd["localSha256"], 64) || !/^[a-f0-9]{64}$/u.test(prd["localSha256"])
    || !identity(prd["name"]) || !text(prd["text"], 131072)
    || prd["size"] !== utf8.encode(prd["text"]).byteLength
    || (Object.hasOwn(value, "riskClass") && risk !== "STANDARD" && risk !== "ELEVATED" && risk !== "RESTRICTED")) return null;
  const source = admitGoalSource({ displayPath: prd["name"], mediaType: prd["mediaType"], text: prd["text"] });
  if (!source.ok) return null;
  const result: GoalDraft = Object.freeze({ outcome: value["outcome"], title: value["title"],
    acceptanceCriteria: Object.freeze([...criteria] as string[]), budgetEnvelope: value["budgetEnvelope"],
    ...(risk === "STANDARD" || risk === "ELEVATED" || risk === "RESTRICTED" ? { riskClass: risk } : {}),
    prd: Object.freeze({ localSha256: prd["localSha256"], mediaType: source.source.mediaType,
      name: prd["name"], size: prd["size"] as number, text: prd["text"] }) });
  return admitGoalBrief(briefOfDraft(result)).ok ? result : null;
}
function parseIntent(value: unknown, projectId: string, expectedOrigin: string): ReplanIntent | null {
  if (!record(value, ["version", "projectId", "origin", "phase", "predecessorGoalId", "nodeRef", "reviewVersion",
    "planningRunRef", "nodeKey", "title", "escalationOffer", "createOffer", "draft"])
    || value["version"] !== VERSION || value["projectId"] !== projectId || value["origin"] !== expectedOrigin
    || (value["phase"] !== "DECISION_UNCERTAIN" && value["phase"] !== "CREATE_PENDING")
    || !identity(value["predecessorGoalId"]) || !identity(value["nodeRef"]) || !identity(value["planningRunRef"])
    || !identity(value["nodeKey"]) || !text(value["title"], 1024)
    || !Number.isSafeInteger(value["reviewVersion"]) || (value["reviewVersion"] as number) < 0) return null;
  const escalationOffer = offer(value["escalationOffer"], "escalation.decide");
  const createOffer = offer(value["createOffer"], "goal.create_with_source"), parsedDraft = draft(value["draft"]);
  if (escalationOffer === null || createOffer === null || parsedDraft === null
    || escalationOffer.targetAggregateId !== value["nodeRef"] || escalationOffer.expectedVersion !== value["reviewVersion"]
    || createOffer.commandId === escalationOffer.commandId) return null;
  return Object.freeze({ version: VERSION, projectId, origin: expectedOrigin, phase: value["phase"],
    predecessorGoalId: value["predecessorGoalId"], nodeRef: value["nodeRef"], reviewVersion: value["reviewVersion"] as number,
    planningRunRef: value["planningRunRef"], nodeKey: value["nodeKey"], title: value["title"],
    escalationOffer, createOffer, draft: parsedDraft });
}

/** A tab-local retry journal, never evidence that a command committed. Fresh daemon joins
 * and explicit operator action remain mandatory before sending either captured offer.
 * Only public command identity and exact draft/source text are retained; no session headers.
 */
export function createReplanSuccessorJournal(options: { readonly origin: string; readonly projectId: string;
  readonly getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined }): ReplanJournal {
  const { origin: expectedOrigin, projectId, getStorage } = options;
  const key = `${VERSION}:${JSON.stringify([expectedOrigin, projectId])}`;
  const read = (): ReplanJournalRead => {
    try {
      if (!origin(expectedOrigin) || !identity(projectId)) return invalid();
      const storage = getStorage();
      if (storage === undefined) return unavailable();
      const raw = storage.getItem(key);
      if (raw === null) return Object.freeze({ status: "ABSENT" });
      if (raw.length > MAX_BYTES || !raw.isWellFormed()) return invalid();
      const decoded = decodeBoundedJsonBytes(utf8.encode(raw));
      if (!decoded.ok || !Array.isArray(decoded.value) || decoded.value.length === 0
        || decoded.value.length > MAX_INTENTS) return invalid();
      const intents: ReplanIntent[] = [], seen = new Set<string>();
      for (const value of decoded.value) {
        const parsed = parseIntent(value, projectId, expectedOrigin);
        if (parsed === null || seen.has(replanIntentKey(parsed))) return invalid();
        seen.add(replanIntentKey(parsed)); intents.push(parsed);
      }
      return Object.freeze({ status: "PRESENT", intents: Object.freeze(intents) });
    } catch { return unavailable(); }
  };
  const write = (intents: readonly ReplanIntent[]): ReplanJournalResult => {
    try {
      const storage = getStorage();
      if (storage === undefined) return failed("REPLAN_JOURNAL_UNAVAILABLE");
      if (intents.length === 0) { storage.removeItem(key); return success; }
      const raw = JSON.stringify(intents), bytes = utf8.encode(raw);
      if (intents.length > MAX_INTENTS || bytes.byteLength > MAX_BYTES) return failed("REPLAN_JOURNAL_LIMIT");
      if (!decodeBoundedJsonBytes(bytes).ok) return failed("REPLAN_JOURNAL_INVALID");
      storage.setItem(key, raw); return success;
    } catch { return failed("REPLAN_JOURNAL_UNAVAILABLE"); }
  };
  return Object.freeze({ read,
    put: (input: ReplanIntent): ReplanJournalResult => {
      let parsed: ReplanIntent | null;
      try { parsed = parseIntent(input, projectId, expectedOrigin); } catch { parsed = null; }
      if (parsed === null) return failed("REPLAN_JOURNAL_INVALID");
      const existing = read();
      if (existing.status === "INVALID" || existing.status === "UNAVAILABLE") return failed(existing.code);
      const intents = existing.status === "PRESENT" ? [...existing.intents] : [];
      const index = intents.findIndex((entry) => replanIntentKey(entry) === replanIntentKey(parsed));
      const previous = intents[index];
      if (previous !== undefined) {
        if (JSON.stringify({ ...previous, phase: parsed.phase }) !== JSON.stringify(parsed)
          || (previous.phase === "CREATE_PENDING" && parsed.phase !== previous.phase)) return failed("REPLAN_JOURNAL_CONFLICT");
        if (previous.phase === parsed.phase) return success;
        intents[index] = parsed;
      } else intents.push(parsed);
      return write(intents);
    },
    remove: (intentKey: string): ReplanJournalResult => {
      const existing = read();
      if (existing.status === "INVALID" || existing.status === "UNAVAILABLE") return failed(existing.code);
      if (existing.status === "ABSENT") return success;
      const retained = existing.intents.filter((entry) => replanIntentKey(entry) !== intentKey);
      return retained.length === existing.intents.length ? success : write(retained);
    },
  });
}
