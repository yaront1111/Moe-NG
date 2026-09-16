/** The subject that merges the nodes' branches in the project's own checkout (2026-09-16). */
export const INTEGRATION_REF_PREFIX = "integrate:";

/** Reserved daemon workflow subjects cannot be staffed as operator-authored nodes. */
export function isRepositoryWorkflowRef(value: string): boolean {
  return value.startsWith("publish:") || value.startsWith("criterion:")
    || value.startsWith(INTEGRATION_REF_PREFIX);
}
