/** Reserved daemon workflow subjects cannot be staffed as operator-authored nodes. */
export function isRepositoryWorkflowRef(value: string): boolean {
  return value.startsWith("publish:") || value.startsWith("criterion:");
}
