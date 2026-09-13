export interface LiveTabSessionBinding {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly clientKeyId: string;
  readonly generation: number;
}
export interface LiveTabSessionRecord {
  readonly credential: string;
  readonly binding: LiveTabSessionBinding;
}
export interface LiveTabSession {
  read(projectId: string): LiveTabSessionRecord | undefined;
  write(projectId: string, session: LiveTabSessionRecord): void;
  clear(): void;
}

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "moe.project.session.v1:";
// The daemon's SESSION_AUTHORITY_MAX_ID_BYTES is a UTF-8 wire limit.
const SESSION_ID_MAX_BYTES = 256;
const encoder = new TextEncoder();
const validId = (value: unknown, maximum = 256): value is string => typeof value === "string"
  && value.trim() !== "" && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const validSessionId = (value: unknown): value is string => validId(value)
  && encoder.encode(value).byteLength <= SESSION_ID_MAX_BYTES;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object"
  && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validLiveTabCredential(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256
    && /^[\u0020-\u007e]+$/u.test(value);
}

/** Stored binding metadata selects the signed-open record; only the daemon can validate it. */
export function validLiveTabSessionRecord(value: unknown): value is LiveTabSessionRecord {
  if (!record(value) || !exact(value, ["credential", "binding"]) || !validLiveTabCredential(value["credential"])) return false;
  const binding = value["binding"];
  return record(binding) && exact(binding, ["sessionId", "credentialId", "clientKeyId", "generation"])
    && validSessionId(binding["sessionId"]) && validSessionId(binding["credentialId"])
    && typeof binding["clientKeyId"] === "string" && /^[0-9a-f]{64}$/u.test(binding["clientKeyId"])
    && typeof binding["generation"] === "number" && Number.isSafeInteger(binding["generation"]) && binding["generation"] > 0;
}

function exactProjectOrigin(value: string): boolean {
  try {
    const parsed = new URL(value), port = parsed.port === "" ? 80 : Number(parsed.port);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.origin === value
      && Number.isInteger(port) && port >= 1 && port <= 65_535;
  } catch { return false; }
}

const copy = (session: LiveTabSessionRecord): LiveTabSessionRecord => Object.freeze({
  credential: session.credential, binding: Object.freeze({ ...session.binding }),
});

/** One tab, exact origin, and fresh bootstrap project identity. No cached metadata
 * establishes authority; every restored candidate requires daemon validation. */
export function createLiveTabSession(
  origin: string,
  getStorage: () => TabStorage | undefined,
): LiveTabSession {
  if (!exactProjectOrigin(origin)) {
    return Object.freeze({ read: (_projectId: string) => undefined,
      write: (_projectId: string, _session: LiveTabSessionRecord) => undefined, clear: () => undefined });
  }
  let storage: TabStorage | undefined;
  try { storage = getStorage(); } catch { /* Current-document pairing still works. */ }
  const key = PREFIX + origin;
  let loaded = false;
  let saved: { readonly projectId: string; readonly session: LiveTabSessionRecord } | undefined;
  const clear = (): void => {
    loaded = true; saved = undefined;
    try { storage?.removeItem(key); } catch { storage = undefined; }
  };
  return Object.freeze({
    read: (projectId: string): LiveTabSessionRecord | undefined => {
      if (!validId(projectId, 1024)) { clear(); return undefined; }
      if (!loaded) {
        loaded = true;
        let raw: unknown;
        try { raw = storage?.getItem(key); } catch { storage = undefined; }
        if (raw !== null && raw !== undefined) {
          let parsed: unknown;
          try { parsed = typeof raw === "string" && raw.length <= 8192 ? JSON.parse(raw) : undefined; } catch { /* Rejected below. */ }
          if (record(parsed) && exact(parsed, ["projectId", "credential", "binding"]) && validId(parsed["projectId"], 1024)) {
            const session = { credential: parsed["credential"], binding: parsed["binding"] };
            if (validLiveTabSessionRecord(session)) saved = { projectId: parsed["projectId"], session: copy(session) };
          }
          if (saved === undefined) clear();
        }
      }
      if (saved !== undefined && saved.projectId !== projectId) clear();
      return saved?.session;
    },
    write: (projectId: string, session: LiveTabSessionRecord): void => {
      if (!validId(projectId, 1024) || !validLiveTabSessionRecord(session)) { clear(); return; }
      loaded = true; saved = { projectId, session: copy(session) };
      try { storage?.setItem(key, JSON.stringify({ projectId, ...saved.session })); } catch { storage = undefined; }
    },
    clear,
  });
}
