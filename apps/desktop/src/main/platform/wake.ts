/**
 * Calls `woke` when the wall clock has moved well past a check that should have come sooner: the
 * computer slept. For a Snap, which can't hear logind's sleep notices (packaging/snap/README.md).
 * Timers stand still while Linux sleeps, so without this a reminder or a recording due meanwhile
 * would start late by as long as it slept.
 */
export function watchForWake(woke: () => void, everyMs = 30_000): void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > 2 * everyMs) woke();
    last = now;
  }, everyMs);
  timer.unref();
}
