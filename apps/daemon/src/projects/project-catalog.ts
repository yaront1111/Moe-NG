import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, normalize, posix, win32 } from "node:path";

export const PROJECT_CATALOG_SCHEMA_VERSION = "moe-project-catalog/1" as const;
export const PROJECT_CATALOG_LAYER = "PROJECT_CATALOG" as const;
export const PROJECT_CATALOG_UNREADABLE = "PROJECT_CATALOG_UNREADABLE" as const;
export const PROJECT_CATALOG_MALFORMED = "PROJECT_CATALOG_MALFORMED" as const;
export const PROJECT_CATALOG_PATH_UNRESOLVED = "PROJECT_CATALOG_PATH_UNRESOLVED" as const;
export const PROJECT_CATALOG_UUID_INVALID = "PROJECT_CATALOG_UUID_INVALID" as const;
export const PROJECT_CATALOG_INSTANCE_ID_CONFLICT = "PROJECT_CATALOG_INSTANCE_ID_CONFLICT" as const;
export const PROJECT_CATALOG_ROOT_CONFLICT = "PROJECT_CATALOG_ROOT_CONFLICT" as const;
export const PROJECT_CATALOG_CONFIG_CONFLICT = "PROJECT_CATALOG_CONFIG_CONFLICT" as const;
export const PROJECT_CATALOG_STORE_CONFLICT = "PROJECT_CATALOG_STORE_CONFLICT" as const;
export const PROJECT_CATALOG_OVERSIZED = "PROJECT_CATALOG_OVERSIZED" as const;
export const PROJECT_CATALOG_WRITE_FAILED = "PROJECT_CATALOG_WRITE_FAILED" as const;
export interface ProjectCatalogEntry {
  readonly instanceId: string; readonly title: string; readonly root: string;
  readonly configPath: string; readonly projectId: string; readonly storePath: string;
}
export interface ProjectCatalog {
  readonly schemaVersion: typeof PROJECT_CATALOG_SCHEMA_VERSION; readonly entries: readonly ProjectCatalogEntry[];
}
export type RegisterCatalogProjectInput = Omit<ProjectCatalogEntry, "instanceId">;
export interface ProjectCatalogWriteHandle {
  readonly write: (text: string) => Promise<void>; readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}
export interface ProjectCatalogFsPort {
  readonly caseSensitive: boolean; readonly readText: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly openExclusiveWrite: (path: string) => Promise<ProjectCatalogWriteHandle>;
  readonly rename: (from: string, to: string) => Promise<void>; readonly remove: (path: string) => Promise<void>;
}
export interface ProjectCatalogPorts {
  readonly fs: ProjectCatalogFsPort; readonly mintUuid: () => string;
}

export type ProjectCatalogCode =
  | typeof PROJECT_CATALOG_UNREADABLE | typeof PROJECT_CATALOG_MALFORMED
  | typeof PROJECT_CATALOG_PATH_UNRESOLVED | typeof PROJECT_CATALOG_UUID_INVALID
  | typeof PROJECT_CATALOG_INSTANCE_ID_CONFLICT | typeof PROJECT_CATALOG_ROOT_CONFLICT
  | typeof PROJECT_CATALOG_CONFIG_CONFLICT | typeof PROJECT_CATALOG_STORE_CONFLICT
  | typeof PROJECT_CATALOG_OVERSIZED | typeof PROJECT_CATALOG_WRITE_FAILED;
export interface ProjectCatalogRefused {
  readonly code: ProjectCatalogCode; readonly layer: typeof PROJECT_CATALOG_LAYER; readonly ok: false;
}
export type LoadProjectCatalogResult =
  | { readonly catalog: ProjectCatalog; readonly ok: true } | ProjectCatalogRefused;
export type RegisterCatalogProjectResult =
  | { readonly catalog: ProjectCatalog; readonly entry: ProjectCatalogEntry; readonly ok: true }
  | ProjectCatalogRefused;
export type SaveProjectCatalogResult = { readonly ok: true } | ProjectCatalogRefused;
const CATALOG_KEYS = ["schemaVersion", "entries"] as const;
const ENTRY_KEYS = ["instanceId", "title", "root", "configPath", "projectId", "storePath"] as const;
const REGISTER_KEYS = ["title", "root", "configPath", "projectId", "storePath"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const MAX_CATALOG_BYTES = 1_048_576;
const MAX_ENTRIES = 1_024, MAX_TEXT = 32_767;
function refuse(code: ProjectCatalogCode): ProjectCatalogRefused {
  return Object.freeze({ code, layer: PROJECT_CATALOG_LAYER, ok: false as const });
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}
function exactArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_ENTRIES
      || Reflect.ownKeys(value).length !== length + 1) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT
    && value.trim().length > 0 && !value.includes("\0");
}
function opaqueUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
function rawEntry(value: unknown): ProjectCatalogEntry | null {
  const record = exactRecord(value, ENTRY_KEYS);
  const instanceId = record === null ? null : opaqueUuid(record["instanceId"]);
  if (record === null || instanceId === null || !text(record["title"]) || !text(record["root"])
    || !text(record["configPath"]) || !text(record["projectId"]) || !text(record["storePath"])) return null;
  return { configPath: record["configPath"], instanceId, projectId: record["projectId"],
    root: record["root"], storePath: record["storePath"], title: record["title"] };
}
function storedPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}
function normalizeStoredPath(value: string): string {
  const api = value.startsWith("/") ? posix : win32;
  const normalized = api.normalize(value);
  return normalized.length > api.parse(normalized).root.length && /[\\/]$/u.test(normalized)
    ? normalized.slice(0, -1) : normalized;
}
function storedEntry(entry: ProjectCatalogEntry): ProjectCatalogEntry | ProjectCatalogRefused {
  if (!storedPath(entry.root) || !storedPath(entry.configPath) || !storedPath(entry.storePath)) {
    return refuse(PROJECT_CATALOG_MALFORMED);
  }
  return Object.freeze({
    ...entry,
    configPath: normalizeStoredPath(entry.configPath),
    root: normalizeStoredPath(entry.root),
    storePath: normalizeStoredPath(entry.storePath),
  });
}
async function canonicalEntry(
  entry: ProjectCatalogEntry, fs: ProjectCatalogFsPort,
): Promise<ProjectCatalogEntry | ProjectCatalogRefused> {
  const leaf = basename(entry.storePath);
  if (leaf === "" || leaf === "." || leaf === "..") return refuse(PROJECT_CATALOG_MALFORMED);
  try {
    const root = await fs.realpath(entry.root);
    const configPath = await fs.realpath(entry.configPath);
    const storePath = join(await fs.realpath(dirname(entry.storePath)), leaf);
    if (!text(root) || !text(configPath) || !text(storePath)) return refuse(PROJECT_CATALOG_PATH_UNRESOLVED);
    return Object.freeze({ configPath, instanceId: entry.instanceId, projectId: entry.projectId,
      root, storePath, title: entry.title });
  } catch { return refuse(PROJECT_CATALOG_PATH_UNRESOLVED); }
}
function pathKey(fs: ProjectCatalogFsPort, path: string): string {
  const key = normalize(path);
  return fs.caseSensitive ? key : key.toLowerCase();
}
function conflict(
  entries: readonly ProjectCatalogEntry[], entry: ProjectCatalogEntry, fs: ProjectCatalogFsPort,
): ProjectCatalogRefused | null {
  if (entries.some((other) => other.instanceId === entry.instanceId)) return refuse(PROJECT_CATALOG_INSTANCE_ID_CONFLICT);
  if (entries.some((other) => pathKey(fs, other.root) === pathKey(fs, entry.root))) return refuse(PROJECT_CATALOG_ROOT_CONFLICT);
  if (entries.some((other) => pathKey(fs, other.configPath) === pathKey(fs, entry.configPath))) return refuse(PROJECT_CATALOG_CONFIG_CONFLICT);
  if (entries.some((other) => pathKey(fs, other.storePath) === pathKey(fs, entry.storePath))) return refuse(PROJECT_CATALOG_STORE_CONFLICT);
  return null;
}
function freezeCatalog(entries: readonly ProjectCatalogEntry[]): ProjectCatalog {
  return Object.freeze({ entries: Object.freeze([...entries]), schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION });
}
async function canonicalCatalog(
  value: unknown,
  fs: ProjectCatalogFsPort,
  resolvePaths = false,
): Promise<LoadProjectCatalogResult> {
  const record = exactRecord(value, CATALOG_KEYS);
  const rawEntries = record === null ? null : exactArray(record["entries"]);
  if (record === null || record["schemaVersion"] !== PROJECT_CATALOG_SCHEMA_VERSION || rawEntries === null) {
    return refuse(PROJECT_CATALOG_MALFORMED);
  }
  const entries: ProjectCatalogEntry[] = [];
  for (const valueEntry of rawEntries) {
    const decoded = rawEntry(valueEntry);
    if (decoded === null) return refuse(PROJECT_CATALOG_MALFORMED);
    const entry = resolvePaths ? await canonicalEntry(decoded, fs) : storedEntry(decoded);
    if (!("instanceId" in entry)) return entry;
    const duplicate = conflict(entries, entry, fs);
    if (duplicate !== null) return duplicate;
    entries.push(entry);
  }
  return Object.freeze({ catalog: freezeCatalog(entries), ok: true as const });
}
function isMissing(error: unknown): boolean {
  try { return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT"; }
  catch { return false; }
}
export function createNodeProjectCatalogFs(): ProjectCatalogFsPort {
  return Object.freeze({
    caseSensitive: process.platform !== "win32",
    openExclusiveWrite: async (path: string): Promise<ProjectCatalogWriteHandle> => {
      const handle = await open(path, "wx", 0o600);
      return Object.freeze({
        close: async (): Promise<void> => { await handle.close(); },
        sync: async (): Promise<void> => { await handle.sync(); },
        write: async (value: string): Promise<void> => { await handle.writeFile(value, "utf8"); },
      });
    },
    readText: async (path: string): Promise<string> => await readFile(path, "utf8"),
    realpath: async (path: string): Promise<string> => await realpath(path),
    remove: async (path: string): Promise<void> => { await unlink(path); },
    rename: async (from: string, to: string): Promise<void> => { await rename(from, to); },
  });
}
export async function loadProjectCatalog(
  path: string, fs: ProjectCatalogFsPort = createNodeProjectCatalogFs(),
): Promise<LoadProjectCatalogResult> {
  let raw: string;
  try { raw = await fs.readText(path); }
  catch (error) {
    return isMissing(error)
      ? Object.freeze({ catalog: freezeCatalog([]), ok: true as const })
      : refuse(PROJECT_CATALOG_UNREADABLE);
  }
  if (raw.length > MAX_CATALOG_BYTES) return refuse(PROJECT_CATALOG_MALFORMED);
  try { return await canonicalCatalog(JSON.parse(raw) as unknown, fs); }
  catch { return refuse(PROJECT_CATALOG_MALFORMED); }
}

export async function registerCatalogProject(
  catalog: unknown, input: unknown, ports: ProjectCatalogPorts,
): Promise<RegisterCatalogProjectResult> {
  const current = await canonicalCatalog(catalog, ports.fs);
  if (!current.ok) return current;
  const record = exactRecord(input, REGISTER_KEYS);
  if (record === null || !REGISTER_KEYS.every((key) => text(record[key]))) return refuse(PROJECT_CATALOG_MALFORMED);
  let instanceId: string | null;
  try { instanceId = opaqueUuid(ports.mintUuid()); }
  catch { instanceId = null; }
  if (instanceId === null) return refuse(PROJECT_CATALOG_UUID_INVALID);
  const decoded = rawEntry({ ...record, instanceId });
  if (decoded === null) return refuse(PROJECT_CATALOG_MALFORMED);
  const entry = await canonicalEntry(decoded, ports.fs);
  if (!("instanceId" in entry)) return entry;
  const duplicate = conflict(current.catalog.entries, entry, ports.fs);
  if (duplicate !== null) return duplicate;
  return Object.freeze({ catalog: freezeCatalog([...current.catalog.entries, entry]), entry, ok: true as const });
}

export function serializeProjectCatalog(catalog: ProjectCatalog): string {
  return `${JSON.stringify({ schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
    entries: catalog.entries.map((entry) => ({ instanceId: entry.instanceId,
      title: entry.title, root: entry.root, configPath: entry.configPath,
      projectId: entry.projectId, storePath: entry.storePath })) }, null, 2)}\n`;
}

export async function saveProjectCatalogAtomic(
  path: string, catalog: unknown, ports: ProjectCatalogPorts,
): Promise<SaveProjectCatalogResult> {
  const validated = await canonicalCatalog(catalog, ports.fs);
  if (!validated.ok) return validated;
  const bytes = serializeProjectCatalog(validated.catalog);
  // Refuse before mint/open so no temp can exist for bytes the loader rejects.
  // Use code units, matching loadProjectCatalog's readText length fence above.
  if (bytes.length > MAX_CATALOG_BYTES) return refuse(PROJECT_CATALOG_OVERSIZED);
  let suffix: string | null;
  try { suffix = opaqueUuid(ports.mintUuid()); }
  catch { suffix = null; }
  if (suffix === null) return refuse(PROJECT_CATALOG_UUID_INVALID);
  const name = basename(path);
  if (!text(name) || name === "." || name === "..") return refuse(PROJECT_CATALOG_WRITE_FAILED);
  const temporary = join(dirname(path), `.${name}.${suffix}.tmp`);
  let handle: ProjectCatalogWriteHandle | null = null;
  let owned = false;
  let closed = false;
  try {
    handle = await ports.fs.openExclusiveWrite(temporary);
    owned = true;
    await handle.write(bytes);
    await handle.sync();
    try { await handle.close(); } finally { closed = true; }
    await ports.fs.rename(temporary, path);
    owned = false;
    return Object.freeze({ ok: true as const });
  } catch {
    if (handle !== null && !closed) try { await handle.close(); } catch { /* best effort */ }
    if (owned) try { await ports.fs.remove(temporary); } catch { /* best effort */ }
    return refuse(PROJECT_CATALOG_WRITE_FAILED);
  }
}

export function createNodeProjectCatalogPorts(): ProjectCatalogPorts {
  return Object.freeze({ fs: createNodeProjectCatalogFs(), mintUuid: randomUUID });
}
