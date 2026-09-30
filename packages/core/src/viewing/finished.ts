// When a movie or episode counts as watched to the end. On its own, without imports, so the
// player can share it without taking the schemas along.

/** The share at the end that counts as the credits: watching into it finishes the title. */
const CREDITS_SHARE = 0.05;
/** Short titles still leave this much at the end. */
const MIN_CREDITS_SECONDS = 30;

/** Whether a position is in the credits, or past the end. */
export function isFinished(position: number, duration: number): boolean {
  const credits = Math.max(duration * CREDITS_SHARE, MIN_CREDITS_SECONDS);
  return duration > 0 && position >= duration - credits;
}
