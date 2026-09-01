/**
 * What the daemon answers the project page with, and what those answers say.
 * This module holds the shapes - a listed project, its lifecycle tokens, an
 * operation result - the one fail-closed local refusal the page may substitute
 * for an unreadable answer, and the daemon's own tokens said in words. Nothing
 * here renders.
 */
export const PROJECT_LIFECYCLES = Object.freeze([
  "STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED", "UNKNOWN",
] as const);

export type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];

export interface ProjectHomeProject {
  readonly instanceId: string;
  readonly lifecycle: ProjectLifecycle;
  readonly projectId: string;
  readonly root: string;
  readonly title: string;
}

export interface ProjectHomeResult {
  readonly code: string;
  readonly layer: string;
  readonly ok: boolean;
}

export const PROJECT_HOME_LOCAL_REFUSAL = Object.freeze({
  code: "PROJECT_HOME_REQUEST_FAILED",
  layer: "CONTROL_ROOM_PROJECT_HOME",
  ok: false,
} satisfies ProjectHomeResult);

const STABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;

/** A callback answer is trusted only in the exact shape of a stable code and layer. */
export function safeResult(value: unknown): ProjectHomeResult {
  if (typeof value !== "object" || value === null) return PROJECT_HOME_LOCAL_REFUSAL;
  const candidate = value as Partial<ProjectHomeResult>;
  if (typeof candidate.ok !== "boolean" || typeof candidate.code !== "string"
    || typeof candidate.layer !== "string" || !STABLE_NAME.test(candidate.code)
    || !STABLE_NAME.test(candidate.layer)) return PROJECT_HOME_LOCAL_REFUSAL;
  return { code: candidate.code, layer: candidate.layer, ok: candidate.ok };
}

/** The daemon's lifecycle token said as a word; the token itself rides `data-lifecycle`. */
const LIFECYCLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  FAILED: "Failed", RUNNING: "Running", STARTING: "Starting",
  STOPPED: "Stopped", STOPPING: "Stopping", UNKNOWN: "Unknown",
});

export function lifecycleWord(lifecycle: string): string {
  return LIFECYCLE_WORDS[lifecycle] ?? lifecycle;
}

/**
 * projects-09. These are only the daemon's own codes said in words, one entry per
 * code, adding no fact the code does not already carry. Each value is
 * `[what happened, what to do next]`; an empty next step means none is needed.
 * Codes with no entry fall back to `GENERIC_WORDS`, so an unmapped daemon refusal
 * reads as a refusal and never as an invented success or diagnosis.
 * Sources: project-manager-client.ts LOCAL_CODE, apps/daemon/src/projects
 * (project-manager-service.ts, project-manager-files.ts, project-runtime-supervisor.ts,
 * project-manager-http-routing.ts) and apps/daemon/src/cli/moe-init.ts.
 *
 * Two codes are worded strictly to what the daemon means by them:
 * CONFIG_UNREADABLE comes from one catch around realpath, stat and readFile of
 * the folder and its moe.config.json, so it says a read failed and not that the
 * file is absent; CSRF_INVALID is a token mismatch, so it names no expiry.
 */
export type ResultWords = readonly [said: string, next: string];

export const RESULT_WORDS: Readonly<Record<string, ResultWords>> = Object.freeze({
  MOE_INIT_CONFIG_PRESENT: ["Moe is already set up in that folder.", "Choose \u201cMoe already set this folder up\u201d above and add it again."],
  MOE_INIT_TARGET_NOT_EMPTY: ["That folder already has files in it, so Moe would not set it up.", "Point Moe at a new or empty folder, then copy your files in after it is added."],
  MOE_INIT_TARGET_UNWRITABLE: ["Moe cannot write into that folder.", "Pick a folder you can write to, then press Add project again."],
  PROJECT_HOME_REQUEST_FAILED: ["This page could not reach Moe.", "Press Refresh. If that fails too, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_AUTHENTICATION_REQUIRED: ["This browser is no longer paired with Moe Projects.", "Reload this page to pair again."],
  PROJECT_MANAGER_BOOTSTRAP_MALFORMED: ["Moe Projects answered in a way this page could not read.", "Reload this page. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_BOOTSTRAP_UNAVAILABLE: ["This page could not reach Moe Projects.", "Reload this page. If that fails, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_BUSY: ["Moe Projects is already handling another change.", "Wait a moment, then try again."],
  PROJECT_MANAGER_CONFIG_INVALID: ["Moe could not read the setup file in that folder.", "Pick a folder Moe set up itself, or let Moe set up a new folder."],
  PROJECT_MANAGER_CONFIG_UNREADABLE: ["Moe could not read a setup file in that folder.", "Choose \u201cMoe should set this folder up\u201d above, or pick a folder Moe set up before."],
  PROJECT_MANAGER_CONFIG_WRITE_FAILED: ["Moe could not write its setup file into that folder.", "Pick a folder you can write to, then press Add project again."],
  PROJECT_MANAGER_CONNECT_FAILED: ["This page could not reach Moe Projects.", "Reload this page. If that fails, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_CSRF_INVALID: ["Moe Projects no longer accepts this page's session.", "Reload this page to start a new one."],
  PROJECT_MANAGER_INSTANCE_ID_INVALID: ["This page could not name that project to Moe.", "Press Refresh, then use the button again."],
  PROJECT_MANAGER_INTAKE_INVALID: ["Moe would not take that folder and name.", "Check the folder path and the name, then press Add project again."],
  PROJECT_MANAGER_PAIRED: ["This browser is paired with Moe Projects.", ""],
  PROJECT_MANAGER_PAIRING_REFUSED: ["Pairing with Moe Projects did not go through.", "Reload this page to start pairing again."],
  PROJECT_MANAGER_POPUP_BLOCKED: ["Your browser blocked the new tab.", "Allow pop-ups for this address, then press Open again."],
  PROJECT_MANAGER_PROJECTS_MALFORMED: ["Moe Projects sent a project list this page could not read.", "Press Refresh. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_PROJECTS_REFRESHED: ["Project list updated.", ""],
  PROJECT_MANAGER_PROJECTS_UNAVAILABLE: ["Moe Projects did not send the project list.", "Press Refresh to ask again."],
  PROJECT_MANAGER_PROJECT_CREATED: ["Moe set up the folder and added the project.", "Press Start to run it."],
  PROJECT_MANAGER_PROJECT_INPUT_INVALID: ["Moe would not take that folder and name.", "Check the folder path and the name, then press Add project again."],
  PROJECT_MANAGER_PROJECT_ORIGIN_INVALID: ["Moe Projects did not give this page a usable address for that project.", "Press Refresh, then press Open again."],
  PROJECT_MANAGER_PROJECT_REGISTERED: ["Moe added that folder as a project.", "Press Start to run it."],
  PROJECT_MANAGER_PROJECT_UNKNOWN: ["Moe Projects no longer knows that project.", "Press Refresh to reload the list."],
  PROJECT_MANAGER_PROTOCOL_MISMATCH: ["This page and Moe Projects are different versions.", "Restart Moe Projects, then reload this page."],
  PROJECT_MANAGER_PROTOCOL_UNSUPPORTED: ["This page and Moe Projects are different versions.", "Restart Moe Projects, then reload this page."],
  PROJECT_MANAGER_REQUEST_FAILED: ["Moe Projects did not answer this page.", "Press Refresh. If that fails too, check the terminal window running Moe Projects."],
  PROJECT_MANAGER_RESPONSE_MALFORMED: ["Moe Projects sent an answer this page could not read.", "Reload this page. If it happens again, restart Moe Projects."],
  PROJECT_MANAGER_ROOT_INVALID: ["Moe could not use that folder path.", "Enter the full path to a folder on this computer, like C:\work\project."],
  PROJECT_RUNTIME_BOUNDARY_REFUSED: ["Moe lost contact with that project's runtime.", "Press Refresh, then try again."],
  PROJECT_RUNTIME_EXITED_BEFORE_READY: ["The project shut down before it finished starting.", "Press Start again. If it happens again, check that folder's setup."],
  PROJECT_RUNTIME_INSTANCE_ACTIVE: ["That project is already running.", "Press Refresh to see its current state."],
  PROJECT_RUNTIME_INSTANCE_UNKNOWN: ["Moe Projects no longer knows that project.", "Press Refresh to reload the list."],
  PROJECT_RUNTIME_NOT_RUNNING: ["That project is not running.", "Press Start first."],
  PROJECT_RUNTIME_OPENED: ["Moe opened that project in a new tab.", "If no tab appeared, allow pop-ups for this address and press Open again."],
  PROJECT_RUNTIME_OPERATION_ACTIVE: ["That project is busy with another action.", "Wait a moment, then press Refresh."],
  PROJECT_RUNTIME_STARTED: ["That project is running.", "Press Open to work in it."],
  PROJECT_RUNTIME_START_TIMEOUT: ["The project did not finish starting in time.", "Press Refresh, then press Start again."],
  PROJECT_RUNTIME_STOPPED: ["That project has stopped.", ""],
  PROJECT_RUNTIME_STOP_TIMEOUT: ["The project did not finish stopping in time.", "Press Refresh to see where it stands."],
  PROJECT_RUNTIME_STORE_ACTIVE: ["Another project is already using that folder's store.", "Stop the project using it, then press Start again."],
});

const GENERIC_WORDS = Object.freeze({
  ok: Object.freeze(["Moe accepted that.", "The list updates as the project reports back."] as const),
  refused: Object.freeze(["Moe refused that.", "Open Details for the exact reason, then press Refresh."] as const),
});

export function resultWords(result: Pick<ProjectHomeResult, "code" | "ok">): ResultWords {
  return RESULT_WORDS[result.code] ?? (result.ok ? GENERIC_WORDS.ok : GENERIC_WORDS.refused);
}
