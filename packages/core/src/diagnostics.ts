// A local record of what the app did, for when something goes wrong: its operations, how long
// they took and how they ended. Entries hold only names, durations and failure kinds, so no
// address, login or channel can reach it. The app keeps them in a file in its data folder; without
// that, they go nowhere. Nothing is ever sent anywhere.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { IpcMethod } from "@mrstreamer/contracts/ipc";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Failed } from "./failure.ts";

/** How an operation ended: fine, stopped, or the kind of failure the UI explains. */
export type Outcome = "ok" | "interrupted" | AppError["kind"];

/** The app's steps worth timing: starting, logging in, and fetching or installing things. */
export type Step =
  | "start"
  | "connect"
  | "catalogue"
  /** The movie and series lists. */
  | "titles"
  /** One movie's or series' details. */
  | "details"
  | "guide"
  | "check"
  | "download"
  | "install";

export type Diagnostic =
  /** A step of the app's work and how it ended. */
  | { readonly op: Step; readonly ms: number; readonly outcome: Outcome }
  /** A stream the proxy served: how it reached the player, and how long it took to start. */
  | {
      readonly op: "stream";
      readonly ms: number;
      readonly delivery: "direct" | "converted" | "repaired" | "none";
      readonly outcome: "ok" | StreamFailure["kind"];
    }
  /** A movie or episode the proxy played from a position: what it copied or converted. */
  | {
      readonly op: "title";
      readonly ms: number;
      readonly video: "copy" | "convert" | "none";
      readonly audio: "copy" | "convert" | "none";
      readonly outcome: "ok" | StreamFailure["kind"];
    }
  /** An IPC call that failed. */
  | { readonly op: "call"; readonly method: IpcMethod; readonly outcome: Outcome };

/** Where diagnostics go. Records nothing unless the app provides a place for them. */
export const Diagnostics = Context.Reference<{ record(entry: Diagnostic): void }>(
  "mrstreamer/Diagnostics",
  { defaultValue: () => ({ record: () => {} }) },
);

/** Records how long `effect` took as `op`, and how it ended. */
export function diagnosed(op: Step) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;
      const started = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            diagnostics.record({ op, ms: now - started, outcome: outcomeOf(exit) }),
          ),
        ),
      );
    });
}

/** How an effect ended, as a diagnostic outcome. */
export function outcomeOf(exit: Exit.Exit<unknown, unknown>): Outcome {
  if (Exit.isSuccess(exit)) return "ok";
  const failed = Cause.findErrorOption(exit.cause);
  if (failed._tag === "Some" && failed.value instanceof Failed) return failed.value.error.kind;
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "unexpected";
}
