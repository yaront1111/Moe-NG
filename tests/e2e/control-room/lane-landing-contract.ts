/**
 * The one constant `lane-landing.ts` and `lane-review-round.ts` both need.
 *
 * Its own module so the two do not import each other: the landing drives the round, and the
 * round's evidence package digests the file the landing's seat wrote. A cycle between them
 * would load whichever side Node reached first with the other half still undefined.
 */

/** The one path the seat double writes. Root-relative, so the lander's own diff names it. */
export const LANDED_PATH = "landed-by-the-seat.txt";
