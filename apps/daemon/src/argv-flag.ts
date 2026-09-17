/**
 * The one argv reader the daemon's process entrypoints share: `--name=value`, and nothing else.
 *
 * NO SPACE-SEPARATED FORM, ON PURPOSE. `--name value` would make a missing value swallow the
 * next flag, and every entrypoint here is launched by tooling that writes the `=` form. A flag
 * given with no `=` therefore reads as ABSENT, not as an empty value.
 *
 * ABSENT AND EMPTY STAY DISTINGUISHABLE: `--name=` answers the empty string and an unnamed flag
 * answers `null`, so an entrypoint that must refuse a blank value can tell the operator which
 * mistake they made. The FIRST occurrence wins; a repeated flag never silently overrides.
 */

/** The value of `--<name>=` in `argv`, or `null` when the flag is not there. */
export function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((entry) => entry.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}
