import { openEnvironmentValue } from "./environment-cipher.js";
import { environmentRefusal, isEnvironmentVariableName } from "./environment-contracts.js";
import type { EnvironmentRefusal } from "./environment-contracts.js";
import {
  admitEnvironment,
  isEnvironmentRefusal,
  readEnvironmentState,
} from "./environment-projection.js";
import type { EnvironmentStoreConfig } from "./environment-projection.js";

/**
 * THE ONE PLACE PLAINTEXT LEAVES THE ENVIRONMENT STORE, AND THE ONLY THING IT MAY BE USED FOR.
 *
 * WHY THIS IS NOT IN `environment-store.ts`. That module's header ends with a sentence another
 * suite depends on: "NO PLAINTEXT-RETURNING FUNCTION IS EXPORTED FROM THIS MODULE. Delivering
 * values into spawns is a separate concern and a separate row." Adding this read there would
 * falsify a claim that is asserted as SOURCE TEXT, so the store's no-plaintext property would
 * stop being greppable at exactly the moment it started being false. Keeping the read here means
 * the dangerous surface is one small file a reviewer can read end to end, and `git log` on it is
 * the audit trail for every change to how a secret reaches a process. Do not tidy this back into
 * the store.
 *
 * WHAT USES IT. `deliverEnvironment` is the merge, and it is called from all THREE of this
 * repo's spawn-environment constructions - `orchestrator/agent-spawn-environment.ts`,
 * `orchestrator/verifier-process-runner.ts` and `preview/preview-process.ts` - so the rule about
 * what an operator variable may and may not displace is written once instead of drifting three
 * ways. The two private `runtimeEnvironment` copies in the runner and the preview process are
 * already proof that a duplicated rule here drifts.
 *
 * MERGED UNDER THE ALLOWLIST, NEVER AROUND IT. An operator's names are ARBITRARY - `DATABASE_URL`,
 * `STRIPE_KEY` - so they are in no roster and match no provider prefix. Feeding them THROUGH
 * `agentEnvironment` or `runtimeEnvironment` would drop every one of them: the closed roster doing
 * exactly its job. So the merge is applied to the object the filter RETURNS. That is the whole
 * distinction: the child still sees only the allowlisted host surface, plus exactly the variables
 * an operator deliberately put in this project's environment, and nothing else. Widening either
 * roster to make a variable arrive is the failure this arrangement exists to prevent.
 *
 * THE COLLISION RULE: THE ALLOWLISTED RUNTIME VALUE WINS, AND THE COLLISION IS REPORTED. The store
 * admits `PATH` - `ENVIRONMENT_VARIABLE_NAME_PATTERN` is `/^[A-Z][A-Z0-9_]*$/u` and says nothing
 * about reserved names - so an operator can set a variable named `PATH`, `COMSPEC` or `SYSTEMROOT`.
 * Letting it through would hand an operator-controlled value the power to choose which `node` or
 * which shell the daemon's own verifier spawns; that is a privilege escalation wearing a
 * configuration variable's clothes, and it is worse than the feature is worth. Refusing the whole
 * spawn is the other defensible answer and was rejected: a preview that will not start because
 * someone named a variable `TEMP` is an outage, and the safe half of the behaviour (the child gets
 * the daemon's own runtime) is available without one. Silence was NOT an option, which is why
 * `collisions` is a returned field rather than a comment: the names are already non-secret (the
 * read shape has always carried `name`), so an operator surface can say exactly which variable was
 * not delivered and why.
 *
 * PARTIAL OPENING REFUSES THE WHOLE DELIVERY. `environment-projection.ts:89-94` already fixed this
 * rule for the metadata read - "A single unopenable record fails the WHOLE read: reporting the
 * openable subset would let a partially-unreadable store look healthy" - and delivery has the
 * strictly stronger version of the same problem: a spawn that quietly receives three of four
 * variables fails somewhere far from here, hours later, looking like an application bug. So one
 * unopenable seal refuses the delivery with `ENV_STORE_KEY_UNAVAILABLE` and no variables at all.
 * This is also what preserves `openEnvironmentValue`'s guarantee end to end: a wrong credential, a
 * flipped byte, a replayed salt and a swapped tag all land on AUTHENTICATION_FAILED with NO BYTES
 * RELEASED because GCM verifies before it yields, and a caller that returned "the ones that
 * worked" would have converted a fail-closed primitive into a fail-open feature.
 *
 * NOTHING HERE LOGS, THROWS A VALUE, OR PUTS A VALUE IN A REFUSAL. The refusals are minted by
 * `environmentRefusal`, whose details are fixed prose keyed by code and are never interpolated.
 * The plaintext exists in exactly two places: the returned `variables` map, and the child process
 * environment `deliverEnvironment` builds from it.
 *
 * WHAT A HOSTILE VALUE DOES AT THE SPAWN, measured on win32 against `spawn(..., { shell: true })`,
 * which is how both the verifier (verifier-process-runner.ts:155) and the preview
 * (preview-process.ts:206) run. `shell: true` interpolates the COMMAND STRING, never the
 * environment block, so a value is handed to the child as structured data and is inert: a newline,
 * `; echo x & whoami`, `a=b`, `%PATH%`, `$(whoami)` and a CRLF pair all arrived in the child
 * BYTE-FOR-BYTE with no shell evaluation and no extra variable injected. The ONE exception is a
 * NUL byte, which node rejects with `ERR_INVALID_ARG_VALUE` from `spawn` itself - and the store's
 * `isEnvironmentValueWithinBound` bounds a value's SIZE but not its bytes, so a NUL can be stored.
 * Both spawn sites already wrap `spawn` in try/catch, so that lands as a failed capture and a
 * preview refusal respectively: fail-closed, no crash, and the value in no error path. Refusing it
 * HERE would need a VALUE-layer code that does not exist (the closed roster's only one means "too
 * large"), so the value grammar is the store's to tighten and is recorded on this row rather than
 * invented here.
 */

/** An environment's variables as plaintext, ready to be merged into a child's environment. */
export type EnvironmentDeliveredVariables = Readonly<Record<string, string>>;

export interface EnvironmentDeliveryOk {
  readonly environment: string;
  readonly ok: true;
  readonly variables: EnvironmentDeliveredVariables;
}

export type EnvironmentDeliveryResult = EnvironmentDeliveryOk | EnvironmentRefusal;

const decoder = new TextDecoder();

/**
 * Opens every CURRENT variable of `environment` and returns them as plaintext, or refuses.
 *
 * The scope, key and openability checks are `admitEnvironment`'s, not restated here, so a delivery
 * read refuses with the same code and from the same layer as every other entry point in this
 * slice. The second opening pass below is deliberate rather than wasteful: `admitEnvironment`
 * proves the state is openable and then drops what it opened, and re-deriving the plaintext from
 * the state read HERE is what keeps this module's guarantee independent of the preamble's.
 */
export function readEnvironmentDelivery(
  config: EnvironmentStoreConfig,
  environment: string,
): EnvironmentDeliveryResult {
  const admitted = admitEnvironment(config, environment);
  if (isEnvironmentRefusal(admitted)) return admitted;
  const variables: Record<string, string> = {};
  for (const [name, record] of readEnvironmentState(config, admitted.environment)) {
    // THE WRITE'S NAME GRAMMAR, RE-APPLIED AT THE DELIVERY BOUNDARY. `environment-fold.ts` reads
    // `name` straight off the event payload and does NOT re-check it, so a forged or hand-edited
    // record can carry any string at all. The one that matters is `__proto__`: assigning it on a
    // plain object sets the PROTOTYPE instead of creating a key, so the variable would vanish
    // from `Object.keys` and the child would silently not receive it - a delivery failing exactly
    // the way this module refuses to fail. Refusing is fail-closed and costs a legitimate store
    // nothing, because `setEnvironmentVariable` enforces this same predicate on the way in.
    if (!isEnvironmentVariableName(name)) return environmentRefusal("ENV_NAME_INVALID");
    const opened = openEnvironmentValue(admitted.credential, record.sealed);
    // One unopenable seal refuses the WHOLE delivery, and the partial map built so far is
    // discarded with it. See the header: a spawn that receives some of its variables is worse
    // than one that receives none, because only the second one fails where the fault is.
    if (!opened.ok) return environmentRefusal("ENV_STORE_KEY_UNAVAILABLE");
    variables[name] = decoder.decode(opened.plaintext);
  }
  return Object.freeze({
    environment: admitted.environment, ok: true as const, variables: Object.freeze(variables),
  });
}

export interface EnvironmentDeliveryMerge {
  /**
   * Delivered names that an allowlisted runtime key already held, in the order encountered. The
   * runtime value was kept and these were NOT delivered. Names only - never a value.
   */
  readonly collisions: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Overlays `delivered` onto `allowlisted` - the object a spawn-environment construction RETURNED,
 * never the `process.env` it was given - under the collision rule in the header.
 *
 * DELIVERY MUST NOT BECOME A DEPENDENCY. With nothing to deliver this returns the very object it
 * was handed, by reference: a project with no variables set spawns byte-identically to how it
 * spawned before this feature existed, and there is no copy, no re-ordered key set and no
 * undefined-valued slot for that case to differ by. The verifier ran fine before delivery and must
 * not start depending on it. THE ALIASING THAT BUYS THAT is the caller's to respect: pass an
 * object you own - all three call sites pass one their allowlist construction just built - because
 * mutating the result would then be mutating the input. Nothing here mutates `allowlisted`.
 */
export function deliverEnvironment(
  allowlisted: NodeJS.ProcessEnv,
  delivered: EnvironmentDeliveredVariables | undefined,
  platform: NodeJS.Platform = process.platform,
): EnvironmentDeliveryMerge {
  const names = delivered === undefined ? [] : Object.keys(delivered);
  if (names.length === 0) return { collisions: [], environment: allowlisted };
  const environment: NodeJS.ProcessEnv = { ...allowlisted };
  const collisions: string[] = [];
  const runtimeNames = new Set(Object.keys(allowlisted).map((name) => (
    platform === "win32" ? name.toUpperCase() : name
  )));
  for (const name of names) {
    // Presence rather than truthiness: an allowlisted key explicitly set to the empty string
    // is still the runtime's answer for that name, and letting an operator value replace it would
    // be the same displacement by a quieter route.
    // Windows folds environment names at spawn, so Path also owns delivered PATH.
    if (runtimeNames.has(platform === "win32" ? name.toUpperCase() : name)) {
      collisions.push(name);
      continue;
    }
    environment[name] = delivered?.[name];
  }
  return { collisions: Object.freeze(collisions), environment };
}
