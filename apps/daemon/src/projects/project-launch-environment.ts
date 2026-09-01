import {
  PROJECT_STACK_ENVIRONMENT_KEYS,
  PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS,
} from "@moe/runner";

const STACK_KEYS = new Set<string>(PROJECT_STACK_ENVIRONMENT_KEYS);
const PROVIDER_CREDENTIAL_KEYS = new Set<string>(PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS);

/** Snapshot process-style input without invoking accessors or preserving case collisions. */
export function snapshotProjectLaunchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> | null {
  const snapshot: Record<string, string | undefined> = Object.create(null) as Record<
    string, string | undefined
  >;
  try {
    for (const name of Reflect.ownKeys(source)) {
      if (typeof name !== "string") return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      const upper = name.toUpperCase();
      if (!STACK_KEYS.has(upper)) continue;
      if (Object.hasOwn(snapshot, upper)) return null;
      if (descriptor.value !== undefined && typeof descriptor.value !== "string") return null;
      snapshot[upper] = descriptor.value as string | undefined;
    }
  } catch {
    return null;
  }
  return Object.freeze(snapshot);
}

/** Keep host variables, but carry credentials only from the selected provider overlay. */
export function selectedProviderEnvironment(
  snapshot: Readonly<Record<string, string | undefined>>,
  selected: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(snapshot)) {
    if (!PROVIDER_CREDENTIAL_KEYS.has(name)) environment[name] = value;
  }
  for (const [name, value] of Object.entries(selected)) environment[name] = value;
  return Object.freeze(environment);
}
