import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { PaneRefusal } from "@mrstreamer/contracts/playback";
import { sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import type { Profiles } from "../platform/profile-store.ts";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import { observeOpen } from "../analytics/playback.ts";
import { streamsOf } from "./streams.ts";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import { CurrentPaneArrival, type Playback } from "../services/playback.ts";
import type { PlaybackCoordination } from "../services/playback-coordination.ts";
import type { Library } from "../services/library.ts";
import type { OnDemand } from "../services/ondemand.ts";
import type { Downloads } from "../services/downloads.ts";
import type { Recordings } from "../services/recordings.ts";
import type { Output } from "../services/output.ts";
import type { Settings } from "../services/preferences.ts";
import type { Analytics } from "../analytics/service.ts";

// The public player's latest successful open owns its diagnostic reads. Receiver and household
// sessions never enter this record, and a new viewer cannot inspect the previous viewer's session.
const playerSessions = new WeakMap<Playback["Service"], { id: string; owner: ActiveProfile }>();

/**
 * The sound a live open asks for: the track the player names, else the one the viewer picked on
 * this channel before, matched by its id and then its language, else the profile's language.
 * When the stream has none of them, the stream's own first track plays (`liveAudio`).
 */
function soundFor(
  channel: LiveChannel,
  audio: number | undefined,
  audioLanguage: string | undefined,
) {
  const remembered = audio === undefined ? channel.choices?.audio : undefined;

  return {
    audio: audio ?? null,
    savedAudio: remembered ?? null,
    audioLanguage: audioLanguage ?? null,
  };
}

export function playbackHandlers({
  playback,
  coordination,
  library,
  onDemand,
  downloads,
  recordings,
  output,
  settings,
  analytics,
  profiles,
}: {
  /** Whose viewing an open belongs to: the admitted owner, or the active one. */
  readonly profiles: Pick<Profiles["Service"], "active">;
  readonly playback: Playback["Service"];
  readonly coordination: Pick<PlaybackCoordination["Service"], "begin" | "passed">;
  readonly library: Pick<Library["Service"], "channel">;
  readonly onDemand: Pick<OnDemand["Service"], "file">;
  readonly downloads: Pick<Downloads["Service"], "copy">;
  readonly recordings: Pick<Recordings["Service"], "copy">;
  readonly output: Pick<Output["Service"], "remote">;
  readonly settings: Pick<Settings["Service"], "get" | "ofSubscription">;
  readonly analytics: Pick<Analytics, "admitPlayback" | "playbackFailureObserver">;
}): HandlersFor<"playback"> {
  const inspect = <A>(sessionId: string, read: Effect.Effect<A>) =>
    Effect.flatMap(profiles.active, (owner) => {
      const session = playerSessions.get(playback);

      return session?.id === sessionId && sameProfile(session.owner, owner)
        ? read
        : Effect.succeed(null);
    });

  // Refusals are pane domain values; real policy/source/disk failures remain Failed.
  const paneResult = <A>(work: Effect.Effect<A, Failed | PaneRefusal>) =>
    Effect.catchTag(work, "PaneRefused", (refusal) => Effect.succeed(refusal));

  const arrived = Effect.gen(function* () {
    const arrival = yield* Effect.serviceOption(CurrentPaneArrival);

    if (arrival._tag === "None")
      return yield* Effect.fail({ _tag: "PaneRefused", reason: "stale" } satisfies PaneRefusal);

    return arrival.value;
  });

  return {
    "playback.openPane": (input) =>
      paneResult(
        Effect.gen(function* () {
          const arrival = yield* arrived;
          const channel = yield* library.channel(input.channel);
          const variants = yield* streamsOf(settings, channel, input.variant);
          const request = yield* playback.beginArrivedPane(arrival, ownedId(channel));

          return yield* playback.openPane(request, ownedId(channel), input.decoders, {
            variants,
            repair: input.repair ?? false,
            ...soundFor(channel, input.audio, input.audioLanguage),
          });
        }),
      ),
    "playback.adoptPane": (input) =>
      paneResult(
        Effect.gen(function* () {
          const arrival = yield* arrived;
          const owner = yield* profiles.active;
          yield* library.channel(input.channel);
          yield* playback.paneSession(input.paneId, owner, input.channel, input.sessionId, "adopt");
          const request = yield* playback.beginArrivedPane(arrival, input.channel);

          return yield* playback.adoptPane(request, input.sessionId);
        }),
      ),
    "playback.singlePane": (input) =>
      paneResult(
        Effect.gen(function* () {
          const arrival = yield* arrived;
          const owner = yield* profiles.active;

          const request = yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          yield* playback.beginArrivedPane(arrival, input.channel);
          const session = yield* playback.singlePane(request, input.sessionId, arrival);
          playerSessions.set(playback, { id: session.sessionId, owner });

          return session;
        }),
      ),
    "playback.closePane": (input) =>
      paneResult(
        Effect.gen(function* () {
          const arrival = yield* arrived;
          const owner = yield* profiles.active;

          const request = yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "close",
          );

          if (yield* coordination.passed(request.epoch))
            return yield* Effect.fail({
              _tag: "PaneRefused",
              reason: "stale",
            } satisfies PaneRefusal);

          yield* playback.beginArrivedPane(arrival, input.channel);
          yield* playback.closePane(request, input.channel, input.sessionId, arrival);

          return null;
        }),
      ),
    "playback.paneTimeline": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.timeline(input.sessionId);
        }),
      ),
    "playback.paneSeek": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.seekLive(input.sessionId, input.at, input.audio);
        }),
      ),
    "playback.paneTracks": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.tracks(input.sessionId);
        }),
      ),
    "playback.panePlaying": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.playing(input.sessionId);
        }),
      ),
    "playback.paneFailure": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.failure(input.sessionId, input.selector);
        }),
      ),
    "playback.paneDiagnostic": (input) =>
      paneResult(
        Effect.gen(function* () {
          const owner = yield* profiles.active;
          yield* playback.paneSession(
            input.paneId,
            owner,
            input.channel,
            input.sessionId,
            "existing",
          );

          return yield* playback.diagnostic(input.sessionId);
        }),
      ),
    "playback.paneCapacity": ({ channel }) =>
      Effect.andThen(library.channel(channel), playback.paneCapacity(channel)),
    "playback.open": (
      {
        channel: named,
        variant,
        archive,
        decoders,
        repair,
        audio,
        audioLanguage,
        preview,
        measurement,
      },
      frame,
    ) => {
      const token = analytics.admitPlayback("live", preview ? undefined : measurement, frame);

      return Effect.flatMap(profiles.active, (owner) =>
        observeOpen(
          coordination,
          () => analytics.playbackFailureObserver(token ?? undefined),
          (turn) =>
            Effect.gen(function* () {
              const channel = yield* library.channel(named);
              const variants = yield* streamsOf(settings, channel, variant, archive);

              const session = yield* playback.open(ownedId(channel), decoders, {
                variants,
                owner,
                archive: archive ?? null,
                repair: repair ?? false,
                ...soundFor(channel, audio, audioLanguage),
                preview: preview ?? false,
                turn,
              });

              playerSessions.set(playback, { id: session.sessionId, owner });

              return session;
            }),
          Effect.gen(function* () {
            // A page's preview never takes the provider's connection from a receiver. Refused
            // here while one is the output, also one that is gone with nothing open; the playback
            // service looks again when the open takes its turn, for one that began meanwhile.
            if (preview && (yield* output.remote)) {
              return yield* new Failed({
                error: { kind: "unexpected", detail: t("A receiver has playback.") },
              });
            }
          }),
        ),
      );
    },
    "playback.openTitle": ({ title, decoders, measurement }, frame) => {
      const token = analytics.admitPlayback("vod", measurement, frame);

      return Effect.flatMap(profiles.active, (owner) =>
        observeOpen(
          coordination,
          () => analytics.playbackFailureObserver(token ?? undefined),
          (turn) =>
            Effect.gen(function* () {
              // What plays goes first, whichever subscription it is of, so no provider sees a
              // connection beside the one about to open.
              yield* playback.closeAll;
              const { url, revision, headers, listingKey } = yield* onDemand.file(title);

              const session = yield* playback.openTitle(title, url, decoders, {
                turn,
                owner,
                revision,
                headers,
                listingKey,
              });

              playerSessions.set(playback, { id: session.sessionId, owner });

              return session;
            }),
        ),
      );
    },
    "playback.openCopy": ({ copy, decoders, measurement }, frame) => {
      const token = analytics.admitPlayback("vod", measurement, frame);

      return Effect.flatMap(profiles.active, (owner) =>
        observeOpen(
          coordination,
          () => analytics.playbackFailureObserver(token ?? undefined),
          (turn) =>
            Effect.gen(function* () {
              const recorded = yield* recordings.copy(copy, owner);

              const session = yield* playback.openCopy(
                recorded ?? (yield* downloads.copy(copy, owner)),
                decoders,
                turn,
              );

              playerSessions.set(playback, { id: session.sessionId, owner });

              return session;
            }),
        ),
      );
    },
    "playback.close": ({ sessionId }) => Effect.as(playback.close(sessionId), null),
    "playback.closeAll": () =>
      Effect.andThen(coordination.begin, Effect.as(playback.closeAll, null)),
    "playback.diagnostic": ({ sessionId }) => inspect(sessionId, playback.diagnostic(sessionId)),
    "playback.failure": ({ sessionId, selector }) =>
      inspect(sessionId, playback.failure(sessionId, selector)),
    "playback.timeline": ({ sessionId }) => playback.timeline(sessionId),
    "playback.seekLive": ({ sessionId, at, audio }) => playback.seekLive(sessionId, at, audio),
    "playback.tracks": ({ sessionId }) => playback.tracks(sessionId),
    "playback.playing": ({ sessionId }) => playback.playing(sessionId),
  };
}
