/**
 * Canonicalizes the one host fact the default Claude boundary is allowed to
 * read from a Windows worker environment.
 *
 * Node documents `process.env` in a Worker as case-sensitive even on Windows.
 * A test/runtime host can therefore expose the same OS variable under both
 * `SystemRoot` and `SYSTEMROOT`. Windows itself has only one case-insensitive
 * variable, so byte-identical own data aliases are one fact, not competing
 * authority. Conflicting, accessor-backed, or otherwise unusable aliases are
 * left untouched: the physical boundary will inspect and refuse them.
 */
export function canonicalizeEquivalentSystemRootAliases(environment: unknown): unknown {
  try {
    if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
      return environment;
    }
    const names = Object.keys(environment)
      .filter((name) => name.toUpperCase() === "SYSTEMROOT");
    if (names.length < 2) return environment;

    let systemRoot: string | undefined;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, name);
      if (descriptor === undefined || !("value" in descriptor)
        || typeof descriptor.value !== "string") {
        return environment;
      }
      if (systemRoot !== undefined && descriptor.value !== systemRoot) return environment;
      systemRoot = descriptor.value;
    }
    return systemRoot === undefined ? environment : Object.freeze({ SystemRoot: systemRoot });
  } catch {
    return environment;
  }
}
