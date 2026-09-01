export const PROJECT_MANAGER_SCHEMA_VERSION = "moe-project-manager/1" as const;
export const PROJECT_MANAGER_LOCAL_LAYER = "CONTROL_ROOM_PROJECT_MANAGER" as const;
const LOCAL_CODE = Object.freeze({
  bootstrapMalformed: "PROJECT_MANAGER_BOOTSTRAP_MALFORMED",
  bootstrapUnavailable: "PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE",
  idInvalid: "PROJECT_MANAGER_INSTANCE_ID_INVALID",
  inputInvalid: "PROJECT_MANAGER_PROJECT_INPUT_INVALID",
  pairingRefused: "PROJECT_MANAGER_PAIRING_REFUSED",
  projectOriginInvalid: "PROJECT_MANAGER_PROJECT_ORIGIN_INVALID",
  popupBlocked: "PROJECT_MANAGER_POPUP_BLOCKED",
  projectsMalformed: "PROJECT_MANAGER_PROJECTS_MALFORMED",
  projectsUnavailable: "PROJECT_MANAGER_PROJECTS_UNAVAILABLE",
  protocolMismatch: "PROJECT_MANAGER_PROTOCOL_MISMATCH",
  requestFailed: "PROJECT_MANAGER_REQUEST_FAILED",
  responseMalformed: "PROJECT_MANAGER_RESPONSE_MALFORMED",
} as const);
const STABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const REQUEST_ID = /^[0-9a-f]{64}$/u;
const LIFECYCLES = new Set(["STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED", "UNKNOWN"]);
export const PROJECT_MANAGER_REQUEST_DEADLINE_MS = 15_000;
export type ProjectManagerFetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface ProjectManagerProject {
  readonly instanceId: string;
  readonly lifecycle: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED" | "UNKNOWN";
  readonly projectId: string;
  readonly root: string;
  readonly title: string;
}
export interface ProjectManagerResult {
  readonly code: string;
  readonly layer: string;
  readonly ok: boolean;
}
export interface ProjectManagerProjectListSuccess {
  readonly ok: true;
  readonly projects: readonly ProjectManagerProject[];
}
export type ProjectManagerProjectListResult = ProjectManagerProjectListSuccess | ProjectManagerRefusal;
export interface ProjectManagerOpenedWindow {
  close(): void;
  readonly location: { href: string };
  opener: unknown;
}
export type ProjectManagerOpenWindow = () => ProjectManagerOpenedWindow | null;
export interface ProjectManagerClient {
  createProject(input: { readonly root: string; readonly title: string }): Promise<ProjectManagerResult>;
  listProjects(): Promise<ProjectManagerProjectListResult>;
  openProject(instanceId: string, openWindow: ProjectManagerOpenWindow): Promise<ProjectManagerResult>;
  registerProject(input: { readonly root: string; readonly title: string }): Promise<ProjectManagerResult>;
  startProject(instanceId: string): Promise<ProjectManagerResult>;
  stopProject(instanceId: string): Promise<ProjectManagerResult>;
}
export interface ProjectManagerReady {
  readonly client: ProjectManagerClient;
  readonly ok: true;
  readonly projects: readonly ProjectManagerProject[];
}
export interface ProjectManagerRefusal {
  readonly code: string;
  readonly layer: typeof PROJECT_MANAGER_LOCAL_LAYER;
  readonly ok: false;
}
export interface ProjectManagerPairingPending {
  claim(): Promise<ProjectManagerConnection>;
  readonly confirmationLabel: string;
  readonly status: "AWAITING_OPERATOR";
}
export type ProjectManagerConnection =
  | ProjectManagerReady | ProjectManagerRefusal | ProjectManagerPairingPending;
function refusal(code: string): ProjectManagerRefusal {
  return { code, layer: PROJECT_MANAGER_LOCAL_LAYER, ok: false };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function text(value: unknown, maximum = 32_768): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function body(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}
interface BoundedResponse {
  readonly response: Response;
  readonly value: unknown;
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, PROJECT_MANAGER_REQUEST_DEADLINE_MS);
  });
  const attempted = Promise.resolve().then(async () => await operation(controller.signal))
    .then((value) => value, () => undefined);
  try { return await Promise.race([attempted, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function request(fetchImpl: ProjectManagerFetch, input: string, init: RequestInit,
  readFailureBody: boolean): Promise<BoundedResponse | undefined> {
  return await bounded(async (signal) => {
    const response = await fetchImpl(input, { ...init, signal });
    const value = response.ok || readFailureBody ? await body(response) : undefined;
    return { response, value };
  });
}
function decodeResult(value: unknown): ProjectManagerResult | undefined {
  if (!record(value) || !exact(value, ["code", "layer", "ok"])) return undefined;
  if (typeof value["ok"] !== "boolean" || typeof value["code"] !== "string"
    || typeof value["layer"] !== "string" || !STABLE_NAME.test(value["code"])
    || !STABLE_NAME.test(value["layer"])) return undefined;
  return { code: value["code"], layer: value["layer"], ok: value["ok"] };
}
function decodeProjects(value: unknown): readonly ProjectManagerProject[] | undefined {
  if (!record(value) || !exact(value, ["projects", "schemaVersion"])
    || value["schemaVersion"] !== PROJECT_MANAGER_SCHEMA_VERSION || !Array.isArray(value["projects"])) return undefined;
  const decoded: ProjectManagerProject[] = [], identities = new Set<string>();
  for (const entry of value["projects"]) {
    if (!record(entry) || !exact(entry, ["instanceId", "lifecycle", "projectId", "root", "title"])
      || typeof entry["instanceId"] !== "string" || !UUID.test(entry["instanceId"]) || identities.has(entry["instanceId"])
      || typeof entry["lifecycle"] !== "string" || !LIFECYCLES.has(entry["lifecycle"])
      || !text(entry["projectId"], 256) || !text(entry["root"]) || !text(entry["title"], 512)) return undefined;
    identities.add(entry["instanceId"]); decoded.push({
      instanceId: entry["instanceId"], lifecycle: entry["lifecycle"] as ProjectManagerProject["lifecycle"],
      projectId: entry["projectId"], root: entry["root"], title: entry["title"],
    });
  }
  return Object.freeze(decoded);
}
/**
 * The manager credential travels on THIS header and nowhere else. It is not a cookie:
 * RFC 6265 has no port attribute, so a cookie minted by the manager listener is replayed
 * by the browser to every other 127.0.0.2 port, where any same-user process can collect
 * it. The name mirrors the daemon's PROJECT_MANAGER_CREDENTIAL_HEADER; it is spelled out
 * here rather than imported so a rename on either side reds a test instead of silently
 * following. The value lives only in the closure below - never in React state, storage,
 * a URL or a log line.
 */
const CREDENTIAL_HEADER = "x-moe-manager-session-credential";
function credentialHeader(credential: string): Readonly<Record<string, string>> {
  return credential === "" ? {} : { [CREDENTIAL_HEADER]: credential };
}
function headers(csrfToken: string, credential: string): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    ...credentialHeader(credential),
    "x-moe-manager-csrf": csrfToken,
    "x-moe-manager-protocol-version": PROJECT_MANAGER_SCHEMA_VERSION,
  };
}
async function post(fetchImpl: ProjectManagerFetch, csrfToken: string, credential: string,
  path: string, payload?: unknown): Promise<ProjectManagerResult> {
  const answer = await request(fetchImpl, path, {
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: headers(csrfToken, credential), method: "POST",
  }, true);
  if (answer === undefined) return refusal(LOCAL_CODE.requestFailed);
  const decoded = decodeResult(answer.value);
  return decoded === undefined || (!answer.response.ok && decoded.ok)
    ? refusal(LOCAL_CODE.responseMalformed) : decoded;
}
function projectInput(value: unknown): value is { readonly root: string; readonly title: string } {
  return record(value) && exact(value, ["root", "title"])
    && text(value["root"]) && text(value["title"], 512);
}
export function validProjectOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const port = Number(url.port);
  return url.protocol === "http:" && url.hostname === "127.0.0.1"
    && url.username === "" && url.password === "" && url.pathname === "/"
    && url.search === "" && url.hash === "" && url.origin === value
    && url.port === String(port) && Number.isInteger(port)
    && port >= 1 && port <= 65_535;
}
function createClient(
  fetchImpl: ProjectManagerFetch, csrfToken: string, credentialOf: () => string,
): ProjectManagerClient {
  const mutate = async (path: string, payload?: unknown): Promise<ProjectManagerResult> =>
    post(fetchImpl, csrfToken, credentialOf(), path, payload);
  const byId = (instanceId: string, action: "start" | "stop"): Promise<ProjectManagerResult> =>
    UUID.test(instanceId) ? mutate(`/manager/projects/${instanceId}/${action}`) :
      Promise.resolve(refusal(LOCAL_CODE.idInvalid));
  const client: ProjectManagerClient = {
    createProject: (input) => projectInput(input) ? mutate("/manager/projects/create", input)
      : Promise.resolve(refusal(LOCAL_CODE.inputInvalid)),
    listProjects: async (): Promise<ProjectManagerProjectListResult> => {
      const answer = await request(fetchImpl, "/manager/projects", {
        headers: credentialHeader(credentialOf()), method: "GET",
      }, false);
      if (answer === undefined || !answer.response.ok) return refusal(LOCAL_CODE.projectsUnavailable);
      const projects = decodeProjects(answer.value);
      return projects === undefined ? refusal(LOCAL_CODE.projectsMalformed) : { ok: true, projects };
    },
    openProject: async (instanceId, openWindow): Promise<ProjectManagerResult> => {
      if (!UUID.test(instanceId)) return refusal(LOCAL_CODE.idInvalid);
      let opened: ProjectManagerOpenedWindow | null;
      try { opened = openWindow(); } catch { opened = null; }
      if (opened === null) return refusal(LOCAL_CODE.popupBlocked);
      try { opened.opener = null; } catch { opened.close(); return refusal(LOCAL_CODE.popupBlocked); }
      const answer = await request(fetchImpl, `/manager/projects/${instanceId}/open`, {
        headers: headers(csrfToken, credentialOf()), method: "POST",
      }, true);
      if (answer === undefined) { opened.close(); return refusal(LOCAL_CODE.requestFailed); }
      const { response, value } = answer;
      const denied = decodeResult(value);
      if (!response.ok || denied?.ok === false) {
        opened.close();
        return denied ?? refusal(LOCAL_CODE.responseMalformed);
      }
      if (!record(value) || !exact(value, ["code", "layer", "ok", "origin"])
        || value["ok"] !== true || typeof value["code"] !== "string" || !STABLE_NAME.test(value["code"])
        || typeof value["layer"] !== "string" || !STABLE_NAME.test(value["layer"])
        || !validProjectOrigin(value["origin"])) {
        opened.close(); return refusal(LOCAL_CODE.projectOriginInvalid);
      }
      try { opened.location.href = value["origin"]; }
      catch { opened.close(); return refusal(LOCAL_CODE.requestFailed); }
      return { code: value["code"], layer: value["layer"], ok: true };
    },
    registerProject: (input) => projectInput(input) ? mutate("/manager/projects/register", input)
      : Promise.resolve(refusal(LOCAL_CODE.inputInvalid)),
    startProject: (instanceId) => byId(instanceId, "start"),
    stopProject: (instanceId) => byId(instanceId, "stop"),
  };
  return Object.freeze(client);
}
export async function connectProjectManager(input: {
  readonly fetchImpl: ProjectManagerFetch;
}): Promise<ProjectManagerConnection> {
  const bootstrap = await request(input.fetchImpl, "/manager/bootstrap", {
    method: "GET",
  }, false);
  if (bootstrap === undefined || !bootstrap.response.ok) return refusal(LOCAL_CODE.bootstrapUnavailable);
  const value = bootstrap.value;
  if (!record(value) || !exact(value, ["authenticated", "csrfToken", "schemaVersion"])
    || typeof value["authenticated"] !== "boolean" || !text(value["csrfToken"], 256)
    || typeof value["schemaVersion"] !== "string") return refusal(LOCAL_CODE.bootstrapMalformed);
  if (value["schemaVersion"] !== PROJECT_MANAGER_SCHEMA_VERSION) return refusal(LOCAL_CODE.protocolMismatch);
  const csrfToken = value["csrfToken"];
  // Closed over exactly like the CSRF token: the credential is handed to the client's
  // request builders and never returned, stored or rendered.
  let credential = "";
  const client = createClient(input.fetchImpl, csrfToken, () => credential);
  const ready = async (): Promise<ProjectManagerReady | ProjectManagerRefusal> => {
    const listed = await client.listProjects();
    return listed.ok ? { client, ok: true, projects: listed.projects } : listed;
  };
  if (value["authenticated"]) return await ready();

  const created = await request(input.fetchImpl, "/manager/session/pair/request", {
    body: "{}", headers: headers(csrfToken, credential), method: "POST",
  }, true);
  if (created === undefined || !created.response.ok || !record(created.value)
    || !exact(created.value, ["confirmationLabel", "ok", "requestId"])
    || created.value["ok"] !== true
    || typeof created.value["confirmationLabel"] !== "string"
    || !CONFIRMATION_LABEL.test(created.value["confirmationLabel"])
    || typeof created.value["requestId"] !== "string"
    || !REQUEST_ID.test(created.value["requestId"])) return refusal(LOCAL_CODE.pairingRefused);
  const confirmationLabel = created.value["confirmationLabel"];
  const requestId = created.value["requestId"];
  let pending!: ProjectManagerPairingPending;
  let active: Promise<ProjectManagerConnection> | null = null;
  let settled: ProjectManagerReady | ProjectManagerRefusal | null = null;
  const claimOnce = async (): Promise<ProjectManagerConnection> => {
    const paired = await request(input.fetchImpl, "/manager/session/pair/claim", {
      body: JSON.stringify({ requestId }), headers: headers(csrfToken, credential),
      method: "POST",
    }, true);
    if (paired === undefined) return refusal(LOCAL_CODE.pairingRefused);
    if (paired.response.status === 409 && record(paired.value)
      && (paired.value["code"] === "PAIRING_APPROVAL_REQUIRED"
        || paired.value["code"] === "PAIRING_REQUEST_BUSY")) return pending;
    const pairedBody = paired.value;
    if (!paired.response.ok || !record(pairedBody)
      || !exact(pairedBody, ["code", "layer", "ok", "sessionCredential"])
      || pairedBody["ok"] !== true || pairedBody["code"] !== "PROJECT_MANAGER_PAIRED"
      || pairedBody["layer"] !== "PROJECT_MANAGER_HTTP"
      || !text(pairedBody["sessionCredential"], 256)) return refusal(LOCAL_CODE.pairingRefused);
    // The one hand-over: from here every request carries it on CREDENTIAL_HEADER.
    credential = pairedBody["sessionCredential"];
    settled = await ready();
    return settled;
  };
  pending = Object.freeze({
    claim: (): Promise<ProjectManagerConnection> => {
      if (settled !== null) return Promise.resolve(settled);
      if (active !== null) return active;
      active = claimOnce().finally(() => { active = null; });
      return active;
    },
    confirmationLabel,
    status: "AWAITING_OPERATOR" as const,
  });
  return pending;
}
