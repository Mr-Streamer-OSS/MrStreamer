// A local record of what the app did, for when something goes wrong: its operations, how long
// they took and how they ended. Entries hold only names, durations and failure kinds, so no
// address, login or channel can reach it. The app keeps them in a file in its data folder; without
// that, they go nowhere. Nothing is ever sent anywhere.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { IpcMethod } from "@mrstreamer/contracts/ipc";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import type { SubtitlesUnavailable } from "./subtitles/feed.ts";
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
  /**
   * A run of a movie or episode made into a stream for a receiver on the network: what it copied
   * or converted, how long its first segment took, and where a copied picture's segments start:
   * on the keyframes the file's index names (`cues` in Matroska, `samples` in MP4). `mismatch`
   * when the index named a keyframe the run didn't start on, after which the picture converts;
   * `none` for a converted picture.
   */
  | {
      readonly op: "receiver";
      readonly ms: number;
      readonly video: "copy" | "convert" | "none";
      readonly audio: "copy" | "convert" | "none";
      readonly index: "cues" | "samples" | "none" | "mismatch";
      readonly outcome: "ok" | StreamFailure["kind"];
    }
  /**
   * The subtitles a movie or episode has on screen at a position, read beside a run from there:
   * what that took of the provider's file, nothing when they had been read before, and why they
   * couldn't be had when they couldn't.
   */
  | {
      readonly op: "subtitles";
      readonly ms: number;
      readonly bytes: number;
      readonly requests: number;
      /** The most bytes of the file kept in memory for it. */
      readonly kept: number;
      /**
       * In the session so far: how long such readings held the provider, the longest playback
       * waited for it meanwhile, and how many of their requests playback cut short.
       */
      readonly heldMs: number;
      readonly waitedMs: number;
      readonly revoked: number;
      readonly outcome: "ok" | SubtitlesUnavailable;
    }
  /**
   * What an update source answered when a check failed: its status and GitHub's rate-limit
   * headers, which tell a limit from a refusal. Never the address or the body.
   */
  | {
      readonly op: "update-source";
      readonly source: "feed" | "github";
      readonly status: number | null;
      readonly remaining: number | null;
      readonly reset: number | null;
      readonly retryAfter: number | null;
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
