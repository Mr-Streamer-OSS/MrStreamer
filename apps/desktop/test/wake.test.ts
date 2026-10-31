import { afterEach, expect, it, vi } from "vitest";
import { watchForWake } from "../src/main/platform/wake.ts";

afterEach(() => vi.useRealTimers());

it("hears a wake only when the clock jumped past its checks", () => {
  vi.useFakeTimers();
  const woke = vi.fn();
  watchForWake(woke, 1000);
  vi.advanceTimersByTime(5000);
  expect(woke).not.toHaveBeenCalled();
  // Asleep: the clock moves on, the timers don't.
  vi.setSystemTime(Date.now() + 60 * 60 * 1000);
  vi.advanceTimersByTime(1000);
  expect(woke).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  expect(woke).toHaveBeenCalledTimes(1);
});
