// The time programme progress is drawn at. One timer for the whole window, ticking every 30
// seconds: progress bars move a pixel at a time, so nothing needs animating in between.
import { create } from "zustand";

const TICK_MS = 30_000;

const useClock = create<{ now: number }>(() => ({ now: Date.now() }));
setInterval(() => useClock.setState({ now: Date.now() }), TICK_MS);

/** The current time in epoch milliseconds, updated every 30 seconds. */
export function useNow(): number {
  return useClock((state) => state.now);
}
