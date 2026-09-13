export interface ProjectManagerSession {
  read(): string | undefined;
  write(credential: string): void;
  clear(): void;
}

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "moe.project-manager.session.v1:";
/** A credential must fit an HTTP header before it can reach storage or transport. */
export function validProjectManagerCredential(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256
    && /^[\u0020-\u007e]+$/u.test(value);
}

function exactManagerOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = parsed.port === "" ? 80 : Number(parsed.port);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.2" && parsed.origin === value
      && Number.isInteger(port) && port >= 1 && port <= 65_535;
  } catch { return false; }
}

/** Only the manager entry constructs this adapter. Browser tab storage supplies the
 * lifetime; the origin and format version also isolate the one owned key. Storage
 * failures leave this document's credential in its closure so pairing still works. */
export function createProjectManagerSession(
  origin: string,
  getStorage: () => SessionStorage | undefined,
): ProjectManagerSession {
  if (!exactManagerOrigin(origin)) {
    return Object.freeze({ read: () => undefined, write: (_credential: string) => undefined, clear: () => undefined });
  }
  let storage: SessionStorage | undefined;
  try { storage = getStorage(); } catch { /* Browser storage may be disabled. */ }
  const key = PREFIX + origin;
  let credential: string | undefined;
  let loaded = false;
  const clear = (): void => {
    loaded = true;
    credential = undefined;
    try { storage?.removeItem(key); } catch { storage = undefined; }
  };
  return Object.freeze({
    read: (): string | undefined => {
      if (!loaded) {
        loaded = true;
        try {
          const stored: unknown = storage?.getItem(key);
          if (validProjectManagerCredential(stored)) credential = stored;
          else if (stored !== null && stored !== undefined) {
            clear();
          }
        } catch { storage = undefined; }
      }
      return credential;
    },
    write: (value: string): void => {
      if (!validProjectManagerCredential(value)) { clear(); return; }
      loaded = true;
      credential = value;
      try { storage?.setItem(key, value); } catch { storage = undefined; }
    },
    clear,
  });
}
