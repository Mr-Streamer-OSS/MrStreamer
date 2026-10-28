// Copied into src only by the explicit fixture overlay. No production entry imports this file.
import type { PlaybackObservation } from "expo-video";

type Context = Readonly<{
  generation: number | null;
  phase: "idle" | "loading" | "playing" | "paused" | "failed";
  pip: boolean;
  external: boolean;
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
      return {
        terminal: event.terminal,
        failure: event.failure.kind,
        evidence:
          event.failure.evidence === null
            ? null
            : {
                kind: event.failure.evidence.kind,
                origin: event.failure.evidence.origin,
                code: {
                  domain: event.failure.evidence.code.domain,
                  code: event.failure.evidence.code.code,
                },
                underlying: event.failure.evidence.underlying
                  .slice(0, 8)
                  .map(({ domain, code }) => ({ domain, code })),
              },
        underlyingOmitted: Math.max(0, (event.failure.evidence?.underlying.length ?? 0) - 8),
      };
    default:
      return {};
  }
}

/** A bounded, synchronous diagnostic session. Clocks are JS receipt only, never native time. */
export function measurementRecords(
  now: () => number,
  write: (json: string) => void,
  artifact: Readonly<{ source: string; overlay: string }>,
) {
  const started = now();
  const records: object[] = [];
  let ended: "event-limit" | "elapsed-limit" | "byte-limit" | "capture-failed" | null = null;
  let recordBytes = 0;
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
  const scope = (context: Context) => ({
    phase: context.phase,
    watch: context.watch,
    aside: context.aside,
    pip: context.pip,
    external: context.external,
    generation: scoped(context.generation),
  });
  const detail = (input: Input) => {
    switch (input.kind) {
      case "native": {
        const { event } = input;
        return {
          kind: event.kind,
          nativeVersion: event.version,
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
        return { kind: input.kind, active: input.active };
    }
  };
  return (input: Input) => {
    if (ended !== null) return;
    try {
      const elapsed = now() - started;
      if (elapsed >= maxElapsedMs) ended = "elapsed-limit";
      else {
        const entry = { jsReceiptElapsedMs: elapsed, ...detail(input) };
        const bytes = JSON.stringify(entry).length; // Projected fields are ASCII enums, numbers and booleans.
        if (recordBytes + bytes > 60_000) ended = "byte-limit";
        else {
          records.push(entry);
          recordBytes += bytes;
        }
        if (records.length === maxEvents) ended = "event-limit";
      }
      // The terminal record is in the envelope, not evicted by the event limit. Later callbacks
      // do no capture work. Their count is unknown, rather than a fabricated zero loss total.
      const json = JSON.stringify({
        version: 1,
        artifact,
        maxRecordBytes: 60_000,
        mode: "fixture-overlay",
        clock: "js-performance-now",
        nativeCallbackTime: "unavailable",
        startedJsMs: started,
        records,
        end: ended,
        // Only the callback that crosses the elapsed limit is dropped; the event limit keeps its last.
        droppedAtBoundary: ended === "elapsed-limit" || ended === "byte-limit" ? 1 : 0,
        afterEnd: "not-observed",
        maxEvents,
        maxElapsedMs,
        lifetime: "ends on first callback at/after limit; no idle timer",
      });
      write(json);
    } catch {
      ended = "capture-failed";
    }
  };
}
