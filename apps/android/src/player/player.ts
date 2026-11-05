import { playerOutput, type CastOutput } from "./output.ts";
import type { SubtitleModel } from "../subtitles/model.ts";
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
import { mediaModel, type MediaModel, type MediaPersistence } from "./media.ts";
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

export type PreviewState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "previewing";
      readonly attempt: string;
      readonly intent: PlayIntent;
      readonly phase: PlaybackPhase;
      readonly positionMs: number;
    };

export interface Preview {
  readonly attempt: string;
  /** Ends this preview only; no-op once replaced. */
  end(): Promise<void>;
}

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
  readonly cast: CastOutput;
  /** Subtitle actions share this player; the native app attaches its protected-storage adapter. */
  subtitles?: SubtitleModel;
  readonly state: Store<PlayerState>;
  readonly previewState: Store<PreviewState>;
  preview(intent: PlayIntent): Preview | null;
  /** Ends only the preview, leaving viewer playback and media state alone. */
  endPreview(): Promise<void>;
  readonly media: MediaModel;
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
   * Tries a failed attempt again as a new one, its address worked out afresh (a login changed
   * since is used) from where it was: a title, file or recording from the position it reached.
   * Nothing when nothing failed.
   */
  retry(): void;
  /**
   * Calls `listener` as each attempt pauses, stops, is replaced or ends, once per change: where
   * history saves it to continue from. Returns the unsubscribe.
   */
  onSettled(listener: (settled: Settled) => void): () => void;
  /**
   * Stops whatever holds a source or file `matches` names, as before removing a source or
   * deleting a download, and resolves with how each attempt holding one let go of it once the
   * native player says (none when nothing held one).
   */
  release(matches: (hold: HoldRef) => boolean): Promise<readonly Release[]>;
  capabilities(): Capabilities;
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
  /** Where its media's position 0 is in the intent: what a retry continues from. */
  readonly startMs: number;
  readonly preview: boolean;
  /** The phase and position it last settled at, so an unchanged settle isn't reported twice. */
  settled: string | null;
  readonly released: Promise<Release>;
  readonly settle: (release: Release) => void;
}

function admittedOf(intent: PlayIntent, startMs: number, preview = false): Admitted {
  let settle!: (release: Release) => void;
  const released = new Promise<Release>((resolve) => (settle = resolve));

  return { intent, startMs, preview, settled: null, released, settle };
}

/**
 * `intent` again from `positionMs` into the media an attempt of it played, which started at
 * `startMs` into the intent: a recording's media can begin before the moment it was asked from.
 */
function continued(intent: PlayIntent, positionMs: number, startMs: number): PlayIntent {
  switch (intent.kind) {
    case "live":
      return intent;
    case "catch-up":
      return { ...intent, from: (intent.from ?? intent.window.start) - startMs + positionMs };
    case "title":
    case "file":
      return { ...intent, resumeAt: positionMs };
  }
}

export function playerOwner(
  local: NativePlayer,
  resolve: Resolve,
  persistence?: MediaPersistence,
): PlayerOwner {
  const { native, cast } = playerOutput(local, resolve.canOverlap);
  const state = store<PlayerState>({ kind: "idle" });
  const previewState = store<PreviewState>({ kind: "idle" });
  const settledListeners = new Set<(settled: Settled) => void>();
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
    const preview = previewState.get();

    if (preview.kind === "previewing" && preview.attempt === observation.attempt) {
      previewState.set(
        observation.phase === "stopped"
          ? { kind: "idle" }
          : {
              ...preview,
              phase: observation.phase,
              positionMs: observation.positionMs,
            },
      );

      return;
    }

    if (entry.preview) return;
    const { phase } = observation;
    const settles = phase === "paused" || phase === "stopped" || phase === "ended";
    const key = settles ? `${phase}@${observation.positionMs}` : null;

    if (settles && entry.settled !== key) {
      entry.settled = key;

      const settled: Settled = {
        intent: entry.intent,
        phase,
        positionMs: observation.positionMs,
        durationMs: observation.durationMs,
      };

      for (const listener of settledListeners) listener(settled);
    } else entry.settled = key;

    if (phase === "stopped") {
      if (playing()?.attempt === observation.attempt) state.set({ kind: "idle" });

      return;
    }

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

  function endPreview() {
    const now = previewState.get();

    if (now.kind === "idle") return Promise.resolve();
    resolving?.abort();
    resolving = null;
    previewState.set({ kind: "idle" });

    return admitted.has(now.attempt) ? native.stop(now.attempt).then(() => {}) : Promise.resolve();
  }

  /** Ends the current attempt: its address stops being worked out, or the native player stops it. */
  async function end() {
    const previewEnded = endPreview();
    owner.media.cancelNext();
    resolving?.abort();
    resolving = null;
    const now = playing();
    state.set({ kind: "idle" });

    if (now && admitted.has(now.attempt)) await native.stop(now.attempt);
    await previewEnded;
  }

  const command = async (run: (attempt: string) => Promise<boolean>) => {
    const now = playing();

    return now && admitted.has(now.attempt) ? run(now.attempt) : false;
  };

  const owner: PlayerOwner = {
    cast,
    state,
    previewState,
    endPreview,
    preview(intent) {
      if (state.get().kind !== "idle" || owner.media.watching) return null;
      void endPreview();
      const controller = new AbortController();
      resolving = controller;
      const attempt = `preview-${++attempts}-${Date.now().toString(36)}`;
      previewState.set({ kind: "previewing", attempt, intent, phase: "resolving", positionMs: 0 });
      resolve(intent, controller.signal).then(
        async (request) => {
          if (resolving !== controller) return;
          resolving = null;
          admitted.set(attempt, admittedOf(intent, request.startMs, true));

          try {
            const accepted = await native.admit({
              ...request,
              attempt,
              title: intent.title,
              preview: true,
            });

            if (accepted === false) {
              admitted
                .get(attempt)
                ?.settle({ attempt, hold: holdOf(intent), outcome: "unconfirmed" });
              admitted.delete(attempt);
              previewState.set((now) =>
                now.kind === "previewing" && now.attempt === attempt ? { kind: "idle" } : now,
              );
            }
          } catch {
            admitted
              .get(attempt)
              ?.settle({ attempt, hold: holdOf(intent), outcome: "unconfirmed" });
            admitted.delete(attempt);
            previewState.set((now) =>
              now.kind === "previewing" && now.attempt === attempt
                ? { ...now, phase: "failed" }
                : now,
            );
          }
        },
        () => {
          if (resolving !== controller) return;
          resolving = null;
          previewState.set((now) =>
            now.kind === "previewing" && now.attempt === attempt
              ? { ...now, phase: "failed" }
              : now,
          );
        },
      );

      return {
        attempt,
        end: () => {
          const now = previewState.get();

          return now.kind === "previewing" && now.attempt === attempt
            ? endPreview()
            : Promise.resolve();
        },
      };
    },
    get media() {
      return media;
    },

    play(intent) {
      void endPreview();
      owner.media.cancelNext();
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

      resolve(intent, controller.signal).then(
        (request) => {
          if (resolving !== controller) return;
          resolving = null;
          admitted.set(attempt, admittedOf(intent, request.startMs));
          native
            .admit({ ...request, attempt, title: intent.title })
            .then(() => {
              if (playing()?.attempt === attempt) owner.media.admitted(attempt);
            })
            .catch((cause: unknown) => {
              // Whatever the native player opened before it failed is unknown: say so.
              admitted
                .get(attempt)
                ?.settle({ attempt, hold: holdOf(intent), outcome: "unconfirmed" });
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

    pause: () => {
      owner.media.cancelNext();

      return command((attempt) => native.pause(attempt));
    },
    resume: () => command((attempt) => native.resume(attempt)),
    seek: (positionMs) => {
      owner.media.cancelNext();

      return command((attempt) => native.seek(attempt, positionMs));
    },
    setSpeed: (speed) => owner.media.speed(speed),
    setQuality: (trackId) => owner.media.quality(trackId),
    stop: end,

    retry() {
      const now = playing();

      if (!now?.failure) return;
      const entry = admitted.get(now.attempt);

      // A failure before anything played starts the intent as it was asked.
      owner.play(
        entry && now.positionMs > 0
          ? continued(now.intent, now.positionMs, entry.startMs)
          : now.intent,
      );
    },

    onSettled(listener) {
      settledListeners.add(listener);

      return () => settledListeners.delete(listener);
    },

    async release(matches) {
      // Taken before stopping: a release reported while the stop is under way is still counted.
      const holding = [...admitted.values()].filter((entry) => matches(holdOf(entry.intent)));
      const preview = previewState.get();

      if (preview.kind === "previewing" && matches(holdOf(preview.intent))) await endPreview();
      const now = playing();

      if (now && matches(holdOf(now.intent))) await end();

      return Promise.all(holding.map((entry) => entry.released));
    },

    capabilities: () => native.capabilities(),
  };

  const media = mediaModel(owner, native, persistence);

  return owner;
}
