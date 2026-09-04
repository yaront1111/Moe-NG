/**
 * Person-first lines for a daemon refusal or a failed read. The code and layer stay
 * behind Details (OutcomeNote); they are never the sentence the eye hits first.
 */

export function writeFailedSaid(): string {
  return "That didn't go through.";
}

export function readFailedSaid(what: string): string {
  return `The ${what} could not be read right now.`;
}
