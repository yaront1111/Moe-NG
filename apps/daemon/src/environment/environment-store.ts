import { randomUUID } from "node:crypto";

import {
  environmentRefusal,
  environmentValueBytes,
  environmentValueFingerprint,
  isEnvironmentName,
  isEnvironmentValueWithinBound,
  isEnvironmentVariableName,
} from "./environment-contracts.js";
import type { EnvironmentName } from "./environment-contracts.js";
import { sealEnvironmentValue } from "./environment-cipher.js";
import {
  ENVIRONMENT_VARIABLE_SET_EVENT,
  ENVIRONMENT_VARIABLE_UNSET_EVENT,
} from "./environment-fold.js";
import {
  admitEnvironment,
  answerEnvironmentRead,
  environmentAggregateId,
  isEnvironmentRefusal,
} from "./environment-projection.js";
import type { EnvironmentReadResult, EnvironmentStoreConfig } from "./environment-projection.js";

/**
 * The durable per-environment variable store: sealed bytes in, metadata out, never a value.
 *
 * WHAT REACHES DURABLE BYTES. The event payload carries the SEALED blob, the plaintext's
 * fingerprint, the name and the timestamp. The command record carries the SUBJECT ONLY - kind,
 * environment, name. Neither carries the value. This is not incidental: the store persists
 * `commandBytes` alongside every commit, so a value placed there would be durable plaintext, and
 * the canary suite greps those exact bytes.
 *
 * WHY THE ORDER OF CHECKS IS FIXED. Scope, then name, then size, then key. Each refusal is minted
 * by exactly one surface, so a doubly-invalid call has one stable answer instead of a
 * whichever-ran-first answer that would make the code/layer pair untestable.
 *
 * WHAT `unset` DOES AND DOES NOT DO. The log is APPEND-ONLY and the system replays from it, so
 * unset makes a variable non-current: no longer listed, no longer delivered, no longer readable
 * through these reads. It does NOT erase the ciphertext of previously-set values from history,
 * and it does not make a store exported earlier safe if the credential later leaks. That is
 * acceptable only because the history is unreadable without the credential; an operator who
 * pasted a production secret and unset it has NOT scrubbed their store. Key rotation would be the
 * real remedy and is deliberately out of scope here.
 *
 * CONCURRENCY, and why a version conflict is not one of the four codes. Each write reads the
 * aggregate version and commits under it, so two racing writers cannot both land: the loser's
 * `commit` raises the store's own `ExpectedVersionConflictError`, which propagates. That is
 * deliberate. The refusal roster here is CLOSED at four codes and every one of them is a fact
 * about the CALLER's request; a lost race is a fact about the store, and translating it into a
 * caller-shaped refusal would tell an operator their variable name was wrong. The command layer
 * that publishes these operations owns the retry decision, and passing `commandId` lets a retry
 * dedupe rather than double-write. What matters here, and is asserted by the canary suite, is
 * that the propagated error carries no value.
 *
 * A NON-STRING VALUE reaching `setEnvironmentVariable` at runtime refuses as ENV_VALUE_TOO_LARGE
 * rather than crashing: it is the only VALUE-layer code the closed map has, and refusing at the
 * right layer with the wrong shade of reason beats throwing on untyped input.
 *
 * NO PLAINTEXT-RETURNING FUNCTION IS EXPORTED FROM THIS MODULE. Delivering values into spawns is
 * a separate concern and a separate row.
 */

export const ENVIRONMENT_COMMAND_KIND_SET = "environment.set_variable" as const;
export const ENVIRONMENT_COMMAND_KIND_UNSET = "environment.unset_variable" as const;

export type {
  EnvironmentCredentialSource,
  EnvironmentReadOk,
  EnvironmentReadResult,
  EnvironmentStoreConfig,
} from "./environment-projection.js";
export { environmentAggregateId } from "./environment-projection.js";

export interface SetEnvironmentVariableInput {
  /** The caller's command id, so a retried command dedupes in the store. Minted when omitted. */
  readonly commandId?: string;
  readonly environment: string;
  readonly name: string;
  readonly value: string;
}

export interface UnsetEnvironmentVariableInput {
  readonly commandId?: string;
  readonly environment: string;
  readonly name: string;
}

const textEncoder = new TextEncoder();

function commitEnvironmentEvent(
  config: EnvironmentStoreConfig,
  environment: EnvironmentName,
  commandKind: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  commandId: string | undefined,
): void {
  const aggregateId = environmentAggregateId(config.projectId, environment);
  config.store.commit({
    aggregateId,
    // The command record carries the SUBJECT only. A value here would be durable plaintext.
    commandBytes: textEncoder.encode(JSON.stringify({
      environment, kind: commandKind, name: payload["name"],
    })),
    commandId: commandId ?? randomUUID(),
    committedAt: config.now(),
    events: [{
      eventId: randomUUID(),
      eventType,
      payload: textEncoder.encode(JSON.stringify(payload)),
    }],
    expectedVersion: config.store.getAggregateVersion(aggregateId),
  });
}

export function setEnvironmentVariable(
  config: EnvironmentStoreConfig,
  input: SetEnvironmentVariableInput,
): EnvironmentReadResult {
  if (!isEnvironmentName(input.environment)) {
    return environmentRefusal("ENV_ENVIRONMENT_UNKNOWN");
  }
  if (!isEnvironmentVariableName(input.name)) return environmentRefusal("ENV_NAME_INVALID");
  if (!isEnvironmentValueWithinBound(input.value)) {
    return environmentRefusal("ENV_VALUE_TOO_LARGE");
  }
  const admitted = admitEnvironment(config, input.environment);
  if (isEnvironmentRefusal(admitted)) return admitted;
  commitEnvironmentEvent(
    config, admitted.environment, ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_VARIABLE_SET_EVENT,
    {
      environment: admitted.environment,
      fingerprintSha256: environmentValueFingerprint(input.value),
      name: input.name,
      sealed: Buffer.from(
        sealEnvironmentValue(admitted.credential, environmentValueBytes(input.value)),
      ).toString("base64"),
      updatedAt: config.now(),
    },
    input.commandId,
  );
  return answerEnvironmentRead(config, admitted.environment, admitted.credential);
}

export function unsetEnvironmentVariable(
  config: EnvironmentStoreConfig,
  input: UnsetEnvironmentVariableInput,
): EnvironmentReadResult {
  if (!isEnvironmentName(input.environment)) {
    return environmentRefusal("ENV_ENVIRONMENT_UNKNOWN");
  }
  if (!isEnvironmentVariableName(input.name)) return environmentRefusal("ENV_NAME_INVALID");
  const admitted = admitEnvironment(config, input.environment);
  if (isEnvironmentRefusal(admitted)) return admitted;
  commitEnvironmentEvent(
    config, admitted.environment, ENVIRONMENT_COMMAND_KIND_UNSET,
    ENVIRONMENT_VARIABLE_UNSET_EVENT,
    { environment: admitted.environment, name: input.name, updatedAt: config.now() },
    input.commandId,
  );
  return answerEnvironmentRead(config, admitted.environment, admitted.credential);
}

export function readEnvironmentVariables(
  config: EnvironmentStoreConfig,
  environment: string,
): EnvironmentReadResult {
  const admitted = admitEnvironment(config, environment);
  if (isEnvironmentRefusal(admitted)) return admitted;
  return answerEnvironmentRead(config, admitted.environment, admitted.credential);
}
