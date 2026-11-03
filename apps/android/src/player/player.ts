import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { withoutAddresses } from "@mrstreamer/core/provider";
import { store, type Store } from "../platform/store.ts";
import type { PlayIntent } from "./intent.ts";
import type {
  Capabilities,
  HoldRef,
  NativeFailure,
  NativePhase,
  NativePlayer,
  Observation,
  Release,
  Track,
} from "./native.ts";
import type { Resolve } from "./resolve.ts";

// The app's one player, for Watch, the mini player and whatever plays next: it turns an intent
// into one attempt at a time on the native player (modules/player). play() replaces what plays;
// each attempt has its own id, so an observation or a working out of its address that arrives
// after it was replaced changes nothing. Its state says what was observed, not what was asked.

/** Why an attempt doesn't play: its address couldn't be worked out, or the native player said. */
export type PlaybackFailure =
  | { readonly kind: "resolve"; readonly error: AppError }
  | { readonly kind: "native"; readonly failure: NativeFailure };

export type PlaybackPhase = "resolving" | Exclude<NativePhase, "stopped">;

export interface Playing {
  readonly kind: "playing";
  readonly intent: PlayIntent;
  readonly attempt: string;
  readonly phase: PlaybackPhase;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly bufferedMs: number;
  readonly live: boolean;
  readonly seekable: boolean;
  readonly speed: number;
  readonly failure: PlaybackFailure | null;
  /** The tracks the media declares, with whether this phone decodes each. */
  readonly tracks: readonly Track[];
}

export type PlayerState = { readonly kind: "idle" } | Playing;

/**
 * Where an attempt was when it paused, stopped, was replaced or ended: what history saves to
 * continue from.
 */
export interface Settled {
  readonly intent: PlayIntent;
  readonly phase: "paused" | "stopped" | "ended";
  readonly positionMs: number;
  readonly durationMs: number | null;
}

export interface PlayerOwner {
  readonly state: Store<PlayerState>;
  /** Plays `intent` in place of what plays, and returns its attempt. */
  play(intent: PlayIntent): string;
  /** Each answers false when nothing plays or the command doesn't apply, such as seeking live. */
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  seek(positionMs: number): Promise<boolean>;
  setSpeed(speed: number): Promise<boolean>;
  /** A video track's id from the state's tracks, or null to let the player choose. */
  setQuality(trackId: string | null): Promise<boolean>;
  stop(): Promise<void>;
  /**
   * Stops whatever holds a source or file `matches` names, as before removing a source or
   * deleting a download, and resolves with how each attempt holding one let go of it once the
   * native player says (none when nothing held one).
   */
  release(matches: (hold: HoldRef) => boolean): Promise<readonly Release[]>;
  capabilities(): Capabilities;
}

export interface PlayerOptions {
  readonly resolve: Resolve;
  /** Called as each attempt pauses, stops, is replaced or ends. */
  readonly onSettled?: (settled: Settled) => void;
}

const holdOf = (intent: PlayIntent): HoldRef =>
  intent.kind === "file"
    ? { kind: "file", path: intent.path }
    : { kind: "source", sourceId: intent.sourceId };

/** `cause` as the app shows it, with no address that could hold a login. */
const failureOf = (cause: unknown): AppError =>
  cause instanceof AppFailure
    ? cause.error
    : {
        kind: "unexpected",
        detail: withoutAddresses(cause instanceof Error ? cause.message : String(cause)),
      };

interface Admitted {
  readonly intent: PlayIntent;
  readonly released: Promise<Release>;
  readonly settle: (release: Release) => void;
}

function admittedOf(intent: PlayIntent): Admitted {
  let settle!: (release: Release) => void;
  const released = new Promise<Release>((resolve) => (settle = resolve));
  return { intent, released, settle };
}

export function playerOwner(native: NativePlayer, options: PlayerOptions): PlayerOwner {
  const state = store<PlayerState>({ kind: "idle" });
  let attempts = 0;
  /** The attempt under way while its address is worked out. */
  let resolving: AbortController | null = null;
  /** Attempts the native player was given, until it reports what they held released. */
  const admitted = new Map<string, Admitted>();

  const playing = () => {
    const now = state.get();
    return now.kind === "playing" ? now : null;
  };
  const update = (attempt: string, change: (now: Playing) => Playing) =>
    state.set((now) => (now.kind === "playing" && now.attempt === attempt ? change(now) : now));

  native.addListener("onState", (observation: Observation) => {
    const entry = admitted.get(observation.attempt);
    if (!entry) return;
    const { phase } = observation;
    if (phase === "paused" || phase === "stopped" || phase === "ended")
      options.onSettled?.({
        intent: entry.intent,
        phase,
        positionMs: observation.positionMs,
        durationMs: observation.durationMs,
      });
    if (phase === "stopped") return;
    update(observation.attempt, (now) => ({
      ...now,
      phase,
      positionMs: observation.positionMs,
      durationMs: observation.durationMs,
      bufferedMs: observation.bufferedMs,
      live: observation.live,
      seekable: observation.seekable,
      speed: observation.speed,
      failure: observation.failure ? { kind: "native", failure: observation.failure } : null,
    }));
  });
  native.addListener("onTracks", ({ attempt, tracks }) =>
    update(attempt, (now) => ({ ...now, tracks })),
  );
  native.addListener("onReleased", (release: Release) => {
    admitted.get(release.attempt)?.settle(release);
    admitted.delete(release.attempt);
  });

  /** Ends the current attempt: its address stops being worked out, or the native player stops it. */
  async function end() {
    resolving?.abort();
    resolving = null;
    const now = playing();
    state.set({ kind: "idle" });
    if (now && admitted.has(now.attempt)) await native.stop(now.attempt);
  }

  const command = async (run: (attempt: string) => Promise<boolean>) => {
    const now = playing();
    return now && admitted.has(now.attempt) ? run(now.attempt) : false;
  };

  return {
    state,

    play(intent) {
      const before = playing();
      resolving?.abort();
      const controller = new AbortController();
      resolving = controller;
      const attempt = `${++attempts}-${Date.now().toString(36)}`;
      // What played stops now, not once the new address is worked out: a failure to reach the
      // new one must not leave the old one playing under it.
      if (before && admitted.has(before.attempt)) void native.stop(before.attempt);
      state.set({
        kind: "playing",
        intent,
        attempt,
        phase: "resolving",
        positionMs: 0,
        durationMs: null,
        bufferedMs: 0,
        live: intent.kind === "live",
        seekable: false,
        speed: 1,
        failure: null,
        tracks: [],
      });
      const failed = (cause: unknown) =>
        update(attempt, (now) => ({
          ...now,
          phase: "failed",
          failure: { kind: "resolve", error: failureOf(cause) },
        }));
      options.resolve(intent, controller.signal).then(
        (request) => {
          if (resolving !== controller) return;
          resolving = null;
          admitted.set(attempt, admittedOf(intent));
          native.admit({ ...request, attempt }).catch((cause: unknown) => {
            admitted.delete(attempt);
            failed(cause);
          });
        },
        (cause: unknown) => {
          if (resolving !== controller) return;
          resolving = null;
          failed(cause);
        },
      );
      return attempt;
    },

    pause: () => command((attempt) => native.pause(attempt)),
    resume: () => command((attempt) => native.resume(attempt)),
    seek: (positionMs) => command((attempt) => native.seek(attempt, positionMs)),
    setSpeed: (speed) => command((attempt) => native.setSpeed(attempt, speed)),
    setQuality: (trackId) => command((attempt) => native.setQuality(attempt, trackId)),
    stop: end,

    async release(matches) {
      const now = playing();
      if (now && matches(holdOf(now.intent))) await end();
      const holding = [...admitted.values()].filter((entry) => matches(holdOf(entry.intent)));
      return Promise.all(holding.map((entry) => entry.released));
    },

    capabilities: () => native.capabilities(),
  };
}
