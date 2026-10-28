// Copied into src only by the explicit fixture overlay. No production entry imports this file.
import type { PlaybackObservation } from "expo-video";

type Context = Readonly<{
  generation: number | null;
  phase: string;
  watch: boolean;
  aside: boolean;
}>;
type Input =
  | { kind: "native"; event: PlaybackObservation; context: Context }
  | {
      kind: "intent";
      action: "pause" | "play" | "toggle-idle" | "close" | "set-aside" | "open-watch";
      context: Context;
    }
  | { kind: "screen"; watch: boolean }
  | { kind: "foreground"; active: boolean };

const maxEvents = 256;
const maxElapsedMs = 120_000;

/** The fields kept per observation kind. Track, detach and failure details stay private. */
function observed(event: PlaybackObservation) {
  switch (event.kind) {
    case "state":
      return {
        timeControl: event.timeControl,
        mediaTimeSeconds: event.mediaTimeSeconds,
        bufferEmpty: event.bufferEmpty,
        likelyToKeepUp: event.likelyToKeepUp,
      };
    case "ready":
      return { durationSeconds: event.durationSeconds };
    case "failure":
      return { terminal: event.terminal, failure: event.failure.kind };
    default:
      return {};
  }
}

/** A bounded, synchronous diagnostic session. Clocks are JS receipt only, never native time. */
export function measurementRecords(now: () => number, write: (json: string) => void) {
  const started = now();
  const records: object[] = [];
  let ended: "event-limit" | "elapsed-limit" | "write-failed" | null = null;
  const identity = new Map<number, number>();
  const scoped = (id: number | null) => {
    if (id === null) return null;
    let value = identity.get(id);
    if (value === undefined) {
      value = identity.size + 1;
      identity.set(id, value);
    }
    return value;
  };
  const scope = (context: Context) => ({ ...context, generation: scoped(context.generation) });
  const detail = (input: Input) => {
    switch (input.kind) {
      case "native": {
        const { event } = input;
        return {
          kind: event.kind,
          sequence: event.sequence,
          attempt: scoped(event.attemptId),
          item: scoped(event.itemId),
          context: scope(input.context),
          ...observed(event),
        };
      }
      case "intent":
        return { kind: input.kind, action: input.action, context: scope(input.context) };
      default:
        return input;
    }
  };
  return (input: Input) => {
    if (ended !== null) return;
    const elapsed = now() - started;
    if (elapsed >= maxElapsedMs) ended = "elapsed-limit";
    else {
      records.push({ jsReceiptElapsedMs: elapsed, ...detail(input) });
      if (records.length === maxEvents) ended = "event-limit";
    }
    // The terminal record is in the envelope, not evicted by the event limit. Later callbacks
    // do no capture work. Their count is unknown, rather than a fabricated zero loss total.
    const json = JSON.stringify({
      version: 1,
      mode: "fixture-overlay",
      clock: "js-performance-now",
      nativeCallbackTime: "unavailable",
      startedJsMs: started,
      records,
      end: ended,
      // Only the callback that crosses the elapsed limit is dropped; the event limit keeps its last.
      droppedAtBoundary: ended === "elapsed-limit" ? 1 : 0,
      afterEnd: "not-observed",
      maxEvents,
      maxElapsedMs,
      lifetime: "ends on first callback at/after limit; no idle timer",
    });
    try {
      write(json);
    } catch {
      ended = "write-failed";
    }
  };
}
