/**
 * Durable budget admission identity for an authenticated activation decision.
 *
 * Every decision-key component is length-framed, so delimiter-bearing values cannot alias a
 * neighbouring field. The namespace is versioned because these bytes persist in reservations.
 */
export function activationAdmissionRef(
  projectId: string, principalId: string, commandId: string,
): string {
  return `activation.v2:${projectId.length}:${projectId}|${principalId.length}:${principalId}|` +
    `${commandId.length}:${commandId}`;
}

/** Read-only compatibility key for reservations written before decision-key binding. */
export const legacyActivationAdmissionRef = (commandId: string): string =>
  `activation:${commandId}`;
