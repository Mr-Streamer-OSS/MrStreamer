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

/** A bounded, synchronous diagnostic session. Clocks are JS receipt only, never native time. */
export function measurementRecords(now: () => number, write: (json: string) => void) {
  const started = now();
  const records: object[] = [];
  let ended: "event-limit" | "elapsed-limit" | "write-failed" | null = null;
  let dropped = 0;
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
  return (input: Input) => {
    if (ended !== null) return;
    const elapsed = now() - started;
    if (elapsed >= 120_000) {
      ended = "elapsed-limit";
      dropped++;
    } else {
      let detail: object;
      if (input.kind === "native") {
        const { event, context } = input;
        const common = {
          kind: event.kind,
          sequence: event.sequence,
          attempt: scoped(event.attemptId),
          item: scoped(event.itemId),
          context: { ...context, generation: scoped(context.generation) },
        };
        switch (event.kind) {
          case "state":
            detail = {
              ...common,
              timeControl: event.timeControl,
              mediaTimeSeconds: event.mediaTimeSeconds,
              bufferEmpty: event.bufferEmpty,
              likelyToKeepUp: event.likelyToKeepUp,
            };
            break;
          case "ready":
            detail = { ...common, durationSeconds: event.durationSeconds };
            break;
          case "failure":
            detail = { ...common, terminal: event.terminal, failure: event.failure.kind };
            break;
          default:
            detail = common;
        }
      } else if (input.kind === "intent") {
        detail = {
          kind: input.kind,
          action: input.action,
          context: { ...input.context, generation: scoped(input.context.generation) },
        };
      } else detail = input;
      records.push({ jsReceiptElapsedMs: elapsed, ...detail });
      if (records.length === 256) ended = "event-limit";
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
      droppedAtBoundary: dropped,
      afterEnd: "not-observed",
      maxEvents: 256,
      maxElapsedMs: 120_000,
      lifetime: "ends on first callback at/after limit; no idle timer",
    });
    try {
      write(json);
    } catch {
      ended = "write-failed";
    }
  };
}
