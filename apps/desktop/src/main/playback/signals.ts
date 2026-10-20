/** What `promise` resolves with, or null once `signal` aborts, whichever comes first. */
export function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const aborted = () => resolve(null);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    });
  });
}

/** Tells everyone waiting on `changed` to look again. */
export function tell(changed: ReadonlySet<() => void>): void {
  for (const look of [...changed]) look();
}

/** Resolves once `ready()` holds, looked at whenever `changed` is told, or once `signal` aborts. */
export function until(
  changed: Set<() => void>,
  ready: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const look = () => {
      if (!signal.aborted && !ready()) return;
      changed.delete(look);
      signal.removeEventListener("abort", look);
      resolve();
    };
    changed.add(look);
    signal.addEventListener("abort", look, { once: true });
    look();
  });
}
