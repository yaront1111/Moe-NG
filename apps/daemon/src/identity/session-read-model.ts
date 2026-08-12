import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  SESSION_COMMAND_KINDS,
  isCredentialSha256,
  isIsoInstant,
  isPlainJsonObject,
} from "./session-contracts.js";
import { isRecoveryAuthenticationRef } from "./recovery-authentication-binding.js";

/**
 * The read half of the session composition: every committed session decision for one project,
 * folded into current per-session state. Mirrors `review/review-read-model.ts` and pages the
 * decision log the same way `bootstrap-ledger.ts`'s `readDurableLedger` does.
 *
 * WHY THIS FOLD KEEPS ITS OWN RECORD RATHER THAN `@moe/core`'s `Session`: the kernel's
 * `createSession` demands `profileRevisionId`, `clientKeyId`, `transportIds` and `generation` —
 * identity facts the session wire payload deliberately does not carry yet (there is no client
 * PKI) — and `readExact` refuses any other key set, so building a kernel `Session` here would
 * mean inventing filler facts and laundering them through a validator built to refuse exactly
 * that. Its expiry is also epoch-ms while this ledger stores the ISO instant the caller declared.
 * What IS reused is the kernel's SEMANTICS: expiry is exclusive — a session is unusable at
 * exactly `expiresAt`, matching `isSessionUsableAt`'s `now < expiresAt` — and the authenticator
 * pins that boundary by test.
 */

export interface SessionRecord {
  readonly capabilities: readonly string[];
  readonly credentialSha256: string;
  readonly expiresAt: string;
  readonly keyEpochRef: string;
  readonly principalId: string;
  readonly recoveryIncarnationRef: string;
  readonly sessionId: string;
  readonly status: "OPEN" | "CLOSED";
  readonly version: number;
}

export interface SessionLedger {
  /** Committed decisions seen for this project, EFFECTS_COMMITTED or not — auditability. */
  readonly decisionCount: number;
  readonly sessions: ReadonlyMap<string, SessionRecord>;
  /**
   * True when any committed session decision's stored result did not parse back as session
   * facts. The gate and the authenticator both fail CLOSED on it: treating corrupt bytes as
   * "no session" would allow the id to be silently re-opened or the credential re-bound.
   */
  readonly unreadable: boolean;
}

const LEDGER_PAGE_SIZE = 200;
const KIND_SET: ReadonlySet<string> = new Set<string>(SESSION_COMMAND_KINDS);

function decodeResult(bytes: Uint8Array): JsonValue {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? decoded.value : null;
}

function isRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCapabilities(value: JsonValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry): entry is string => isRef(entry))) return undefined;
  return Object.freeze([...value]);
}

interface OpenedFacts {
  readonly capabilities: readonly string[];
  readonly credentialSha256: string;
  readonly expiresAt: string;
  readonly keyEpochRef: string;
  readonly principalId: string;
  readonly recoveryIncarnationRef: string;
  readonly sessionId: string;
}

/**
 * Structural validation only, returning undefined rather than a partial record on failure so the
 * caller must fail closed. The hash and instant shapes are re-checked on READ even though the
 * handler enforced them on write, because the store accepts arbitrary bytes and this fold is the
 * last gate before those bytes become an authentication authority.
 */
function parseOpened(value: JsonValue): OpenedFacts | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const capabilities = parseCapabilities(value["capabilities"]);
  if (capabilities === undefined) return undefined;
  if (!isCredentialSha256(value["credentialSha256"])) return undefined;
  if (!isIsoInstant(value["expiresAt"])) return undefined;
  if (!isRecoveryAuthenticationRef(value["keyEpochRef"])) return undefined;
  if (!isRecoveryAuthenticationRef(value["recoveryIncarnationRef"])) return undefined;
  if (!isRef(value["principalId"]) || !isRef(value["sessionId"])) return undefined;
  return {
    capabilities,
    credentialSha256: value["credentialSha256"],
    expiresAt: value["expiresAt"],
    keyEpochRef: value["keyEpochRef"],
    principalId: value["principalId"],
    recoveryIncarnationRef: value["recoveryIncarnationRef"],
    sessionId: value["sessionId"],
  };
}

/**
 * Folds every committed session decision for this project into per-session state.
 *
 * Only `EFFECTS_COMMITTED` decisions fold: the store's `NO_BUSINESS_EFFECT` audit rows record
 * that a command was REFUSED, and treating one as prior state would let a refused close kill a
 * live session. A close or renew whose stored facts name no folded session marks the ledger
 * unreadable rather than being dropped — the handlers refuse those before commit, so their
 * presence in the log means the bytes cannot be trusted.
 */
export function readSessionLedger(store: SqliteEventStore, projectId: string): SessionLedger {
  const sessions = new Map<string, SessionRecord>();
  let decisionCount = 0;
  let unreadable = false;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (!KIND_SET.has(decision.commandKind)) continue;
      decisionCount += 1;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      const result = decodeResult(decision.resultBytes);
      if (decision.commandKind === "session.open") {
        const opened = parseOpened(result);
        if (opened === undefined) {
          unreadable = true;
          continue;
        }
        sessions.set(opened.sessionId, {
          ...opened,
          status: "OPEN",
          version: decision.currentVersion,
        });
        continue;
      }
      const sessionId = isPlainJsonObject(result) && isRef(result["sessionId"])
        ? result["sessionId"]
        : null;
      const existing = sessionId === null ? undefined : sessions.get(sessionId);
      if (existing === undefined) {
        unreadable = true;
        continue;
      }
      if (decision.commandKind === "session.close") {
        sessions.set(existing.sessionId, {
          ...existing,
          status: "CLOSED",
          version: decision.currentVersion,
        });
        continue;
      }
      const expiresAt = isPlainJsonObject(result) && isIsoInstant(result["expiresAt"])
        ? result["expiresAt"]
        : null;
      if (expiresAt === null) {
        unreadable = true;
        continue;
      }
      sessions.set(existing.sessionId, {
        ...existing,
        expiresAt,
        version: decision.currentVersion,
      });
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return Object.freeze({ decisionCount, sessions, unreadable });
}
