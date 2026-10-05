// Where playback goes: this computer, or a receiver on the local network, a TV the viewer sends
// it to with Google Cast or AirPlay.
//
// The playback service stays the one owner of every stream. This service decides who plays it:
// it holds the receiver the viewer chose, opens sessions for it there, has the receiver's adapter
// load them (see ../receivers/adapter.ts), and keeps what the receiver last confirmed. The UI's
// controls act on that and show it; the receiver's own clock is the title's clock while it plays.
//
// Looking for receivers and connecting to one change nothing that plays. Only playing something
// on a connected receiver closes what was open here, through the playback service, so the
// provider sees one connection throughout. Going back closes the receiver's session first.
//
// Every load has a generation, counted here, and the account it began under. A command names its
// generation and is dropped once another load took its place. What a receiver says of an earlier
// load is dropped too, so a late answer can't move the clock of what plays now, save progress
// under another account, or end an episode that is no longer the one playing.
//
// A receiver plays from an address of this computer, so the app has to stay open: quitting ends
// what the receiver plays.
import type {
  Output as OutputState,
  OutputFailure,
  OutputStatus,
  Receiver,
  RemoteCommand,
  RemoteItem,
  RemoteMedia,
  RemoteTitle,
} from "@mrstreamer/contracts/output";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { lanAddresses } from "../playback/lan.ts";
import {
  ReceiverFailed,
  type AdapterEvent,
  type Connection,
  type ReceiverAdapter,
  type ReceiverMedia,
  type ScreenRect,
  type TransportStatus,
} from "../receivers/adapter.ts";
import { Playback, type ReceiverTarget } from "./playback.ts";
import { Subscriptions } from "./subscription.ts";

/**
 * How long a receiver gets to ask this computer for what it was sent. One that never does can't
 * reach here: a firewall, or it is on another network.
 */
const FETCH_MS = 10_000;
/** Whose pictures a receiver is given to show: TMDB's, which anyone may fetch. */
const ARTWORK_HOST = "image.tmdb.org";

export interface OutputDeps {
  /** The ways this build reaches receivers: Google Cast, AirPlay, both or none. */
  readonly adapters: readonly ReceiverAdapter[];
  /** This computer's addresses on the local network, likeliest first, when not the system's. */
  readonly addresses?: () => readonly string[];
  /** How long a receiver gets to ask for what it was sent, in ms, when not the usual. */
  readonly fetchMs?: number;
}

/** What the receiver may show about what it plays. */
export interface Shown {
  readonly name: string;
  readonly detail?: string | null | undefined;
  readonly artworkUrl?: string | null | undefined;
}

/** What plays on the receiver, with what this service needs to follow it. */
interface Playing {
  readonly generation: number;
  readonly sessionId: string;
  readonly item: RemoteItem;
  /** The account it began under: its progress is that account's alone. */
  readonly account: string;
  /** Seconds to add to a position the receiver names to get seconds into the title. */
  readonly offset: number;
  /** Ends the wait for the receiver's first request. */
  readonly watch: AbortController;
  media: RemoteMedia;
}

export class Output extends Context.Service<
  Output,
  {
    readonly status: Effect.Effect<OutputStatus>;
    readonly changes: Stream.Stream<OutputStatus>;
    /** Looks for receivers while `on`. Plays and changes nothing. */
    scan(on: boolean): Effect.Effect<void>;
    /** Connects to a receiver the status lists. What plays here goes on. */
    connect(receiverId: string): Effect.Effect<OutputStatus, Failed>;
    /**
     * Opens the system's own list of receivers at `anchor`, a place on screen, and connects to
     * the one the viewer picks. Nothing changes when they pick none.
     */
    pick(anchor: ScreenRect): Effect.Effect<OutputStatus, Failed>;
    /** Back to this computer: ends what the receiver plays, closes its session, lets go of it. */
    readonly disconnect: Effect.Effect<void>;
    /**
     * Plays a channel on the connected receiver, in place of what it had and of what was open
     * here. `variants` are the channel's streams to try, as for `Playback.open`.
     */
    playChannel(
      channelId: string,
      options: {
        readonly variants: readonly string[];
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
        readonly shown: Shown;
      },
    ): Effect.Effect<RemoteMedia, Failed>;
    /**
     * Opens a movie or episode for the connected receiver from its provider file, in place of
     * what was open here, and says what it holds. Nothing plays until `playTitle`.
     */
    openTitle(title: TitleRef, upstreamUrl: string): Effect.Effect<RemoteTitle, Failed>;
    /** Plays an opened title on the receiver from `position` seconds with these tracks. */
    playTitle(
      sessionId: string,
      options: {
        readonly position: number;
        readonly audio: number | null;
        readonly subtitle: number | null;
        readonly paused?: boolean | undefined;
        readonly shown: Shown;
      },
    ): Effect.Effect<RemoteMedia, Failed>;
    /** Tells the receiver. Does nothing when `generation` is no longer what it plays. */
    command(generation: number, command: RemoteCommand): Effect.Effect<void, Failed>;
    setVolume(volume: {
      readonly level?: number | undefined;
      readonly muted?: boolean | undefined;
    }): Effect.Effect<void, Failed>;
    /** Whether a receiver has playback, or had it until it was lost: nothing previews here then. */
    readonly remote: Effect.Effect<boolean>;
    /**
     * Whether progress a receiver reported for `generation` may be saved: only while that load
     * is the receiver's, and the account it began under is the connected one.
     */
    savesProgress(generation: number): Effect.Effect<boolean>;
    /** Another account connected, or none: ends what the receiver plays of the one before. */
    readonly accountChanged: Effect.Effect<void>;
  }
>()("mrstreamer/Output") {
  static readonly layer = (deps: OutputDeps) => Layer.effect(Output, make(deps));
}

function make(deps: OutputDeps) {
  return Effect.gen(function* () {
    const playback = yield* Playback;
    const subscriptions = yield* Subscriptions;
    const updates = yield* PubSub.unbounded<OutputStatus>();
    /** Changes to what is connected and what plays run one at a time. */
    const one = (yield* Semaphore.make(1)).withPermits(1);
    const adapters = deps.adapters;
    const addresses = deps.addresses ?? lanAddresses;

    let scanning = false;
    /** The receivers each adapter found, by its kind. */
    const found = new Map<string, readonly Receiver[]>();
    /** Whether the system sees a receiver it lists itself; null without such an adapter. */
    let routes: boolean | null = adapters.some((each) => each.kind === "airplay") ? false : null;
    let output: OutputState = { kind: "local" };
    let connected: { readonly connection: Connection; readonly adapter: ReceiverAdapter } | null =
      null;
    /** A connect under way, which going back to this computer ends. */
    let connecting: AbortController | null = null;
    let playing: Playing | null = null;
    let generation = 0;
    /** Which of this computer's addresses the next load is served on, counted round. */
    let addressTurn = 0;
    /** Titles opened for the receiver and not played yet, by session. */
    const opened = new Map<string, { readonly title: TitleRef; readonly offset: number }>();

    const snapshot = (): OutputStatus => ({
      offers: adapters.map((each) => each.kind),
      airplayRoutes: routes,
      scanning,
      receivers: [...found.values()].flat(),
      output,
    });
    const publish = () => void PubSub.publishUnsafe(updates, snapshot());

    const failed = (failure: OutputFailure) => new Failed({ error: { kind: "output", failure } });
    const failureOf = (cause: unknown): OutputFailure =>
      cause instanceof ReceiverFailed
        ? cause.failure
        : { kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) };
    /** An adapter's call as an Effect that fails with why the receiver didn't take it. */
    const told = <A>(call: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: call, catch: (cause) => failed(failureOf(cause)) });

    /** Runs what an adapter's or the playback service's callback sets off, outside any call. */
    const later = (effect: Effect.Effect<void>) => void Effect.runFork(effect);

    /** Ends what plays on the receiver, for this service: its session closes, its wait ends. */
    const drop = (close: boolean) =>
      Effect.suspend(() => {
        const was = playing;
        playing = null;
        was?.watch.abort();
        return was && close ? playback.close(was.sessionId) : Effect.void;
      });

    /** What plays now doesn't any more, and why, with the receiver still there. */
    const mediaFailed = (failure: OutputFailure, stop: boolean) =>
      Effect.gen(function* () {
        const was = playing;
        yield* drop(true);
        if (stop && was && connected) {
          yield* Effect.promise(() => connected!.connection.stop(was.generation).catch(() => {}));
        }
        if (output.kind === "receiver") output = { ...output, media: null, failure };
        publish();
      });

    /** The receiver's own news of what it plays. */
    function hear(adapter: ReceiverAdapter, event: AdapterEvent): void {
      switch (event.type) {
        case "receivers":
          found.set(adapter.kind, event.receivers);
          return publish();
        case "routes":
          routes = event.available;
          return publish();
        case "volume":
          if (connected?.adapter !== adapter || output.kind !== "receiver") return;
          if (!connected.connection.volume) return;
          output = { ...output, volume: { level: event.level, muted: event.muted } };
          return publish();
        case "status":
          if (connected?.adapter === adapter) status(event.status);
          return;
        case "media-failed":
          if (connected?.adapter !== adapter || playing?.generation !== event.generation) return;
          return later(mediaFailed(event.failure, false));
        case "released":
          if (connected?.adapter !== adapter) return;
          // Let go of from the receiver's side: back to this computer, nothing failed.
          return later(
            one(
              Effect.gen(function* () {
                yield* drop(true);
                connected = null;
                output = { kind: "local" };
                publish();
              }),
            ),
          );
        case "lost": {
          if (connected?.adapter !== adapter || output.kind !== "receiver") return;
          const { receiver } = output;
          return later(
            one(
              Effect.gen(function* () {
                yield* drop(true);
                connected = null;
                output = { kind: "lost", receiver, failure: event.failure };
                publish();
              }),
            ),
          );
        }
      }
    }

    /** What the receiver says of a load. Only the one that plays now counts. */
    function status(said: TransportStatus): void {
      const now = playing;
      if (!now || said.generation !== now.generation || output.kind !== "receiver") return;
      if (said.state === "stopped" || (said.state === "ended" && now.item.kind === "channel")) {
        // It holds the load no more. A channel has no end: its stream stopped, and the session
        // knows why. Stopped from the receiver's side otherwise, which is nobody's failure.
        return later(
          Effect.gen(function* () {
            const stream =
              now.item.kind === "channel" ? yield* playback.failure(now.sessionId) : null;
            if (playing !== now) return;
            yield* drop(true);
            if (output.kind !== "receiver") return;
            output = {
              ...output,
              media: null,
              failure: stream ? { kind: "stream", failure: stream } : null,
            };
            publish();
          }),
        );
      }
      now.media = {
        ...now.media,
        state: said.state,
        position: now.item.kind === "title" ? Math.max(0, said.position + now.offset) : 0,
        at: said.at,
      };
      output = { ...output, media: now.media };
      publish();
    }

    for (const adapter of adapters) adapter.listen((event) => hear(adapter, event));
    // Quitting ends what the receiver plays and lets go of it, each adapter within its own bound.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(adapters.map((each) => each.close()))),
    );

    /** A session's part of what the playback service is told of its receiver. */
    const target = (connection: Connection): Effect.Effect<ReceiverTarget, Failed> =>
      Effect.suspend(() => {
        const candidates = connection.localAddress ? [connection.localAddress] : addresses();
        const address = candidates[addressTurn % Math.max(1, candidates.length)];
        if (!address) return Effect.fail(failed({ kind: "no-network" }));
        return Effect.succeed({
          address,
          decoders: connection.decoders,
          // Closed by something else than this service: another stream opened here, or the
          // window closed. The receiver is told to stop what it can no longer get; nothing failed.
          closed: () => {
            const now = playing;
            if (!now) return;
            later(
              Effect.gen(function* () {
                if (playing !== now) return;
                yield* drop(false);
                if (connected) {
                  const { connection } = connected;
                  yield* Effect.promise(() => connection.stop(now.generation).catch(() => {}));
                }
                if (output.kind === "receiver") output = { ...output, media: null, failure: null };
                publish();
              }),
            );
          },
          failed: (failure: StreamFailure) => {
            const now = playing;
            if (!now) return;
            later(
              Effect.suspend(() =>
                playing === now ? mediaFailed({ kind: "stream", failure }, true) : Effect.void,
              ),
            );
          },
        } satisfies ReceiverTarget);
      });

    /**
     * Has the receiver play a session that is open for it, and waits no longer than it takes the
     * load. From then on the receiver has `fetchMs` to ask this computer for it.
     */
    const load = (
      connection: Connection,
      sessionId: string,
      item: RemoteItem,
      offset: number,
      media: Omit<ReceiverMedia, "generation" | "metadata">,
      shown: Shown,
    ) =>
      Effect.gen(function* () {
        const account = yield* subscriptions.key;
        if (!account) return yield* new Failed({ error: { kind: "no-subscription" } });
        const mine = ++generation;
        const watch = new AbortController();
        const now: Playing = {
          generation: mine,
          sessionId,
          item,
          account,
          offset,
          watch,
          media: {
            generation: mine,
            sessionId,
            item,
            state: "loading",
            position: item.kind === "title" ? media.position + offset : 0,
            at: Date.now(),
            duration: media.duration,
            subtitles: media.subtitles,
          },
        };
        playing = now;
        if (output.kind === "receiver") output = { ...output, media: now.media, failure: null };
        publish();
        const artwork = URL.parse(shown.artworkUrl ?? "");
        yield* told((signal) =>
          connection.load(
            {
              ...media,
              generation: mine,
              metadata: {
                title: shown.name,
                subtitle: shown.detail ?? null,
                // Only a picture anyone may fetch, never one from the provider's own server.
                artworkUrl:
                  artwork?.protocol === "https:" && artwork.hostname === ARTWORK_HOST
                    ? artwork.href
                    : null,
              },
            },
            AbortSignal.any([signal, watch.signal]),
          ),
        ).pipe(
          Effect.tapError((failure) =>
            playing === now && failure.error.kind === "output"
              ? mediaFailed(failure.error.failure, false)
              : Effect.void,
          ),
        );
        // A receiver that never asks for the stream can't reach this computer.
        const timer = setTimeout(
          () =>
            later(
              Effect.gen(function* () {
                if (playing !== now) return;
                if ((yield* playback.receiverRequests(sessionId)) !== 0) return;
                // The next try is served on this computer's next address, where it has several.
                addressTurn++;
                yield* mediaFailed({ kind: "not-fetched" }, true);
              }),
            ),
          deps.fetchMs ?? FETCH_MS,
        );
        watch.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        return now.media;
      });

    /** The receiver that takes media now, or the failure that there is none. */
    const receiver = Effect.suspend(() =>
      connected && output.kind === "receiver"
        ? Effect.succeed(connected.connection)
        : Effect.fail(failed({ kind: "unreachable" })),
    );

    /** Connects through `adapter`; null when the viewer picked nothing in the system's list. */
    const connectTo = (
      adapter: ReceiverAdapter,
      request: Parameters<ReceiverAdapter["connect"]>[0],
      known: Receiver | null,
    ) =>
      one(
        Effect.gen(function* () {
          // One receiver at a time: the one before goes first, with what it played.
          yield* release;
          const mine = new AbortController();
          connecting = mine;
          output = { kind: "connecting", protocol: adapter.kind, receiver: known };
          publish();
          const connection = yield* told((signal) =>
            adapter.connect(request, AbortSignal.any([signal, mine.signal])),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (connecting === mine) connecting = null;
              }),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                output = { kind: "local" };
                publish();
              }),
            ),
          );
          if (!connection) {
            output = { kind: "local" };
            publish();
            return snapshot();
          }
          connected = { connection, adapter };
          addressTurn = 0;
          output = {
            kind: "receiver",
            receiver: connection.receiver,
            volume: null,
            media: null,
            failure: null,
          };
          publish();
          return snapshot();
        }),
      );

    /** Ends what the receiver plays and lets go of it, the session first. */
    const release = Effect.gen(function* () {
      connecting?.abort();
      yield* drop(true);
      const was = connected;
      connected = null;
      if (was) yield* Effect.promise(() => was.connection.disconnect().catch(() => {}));
    });

    return {
      status: Effect.sync(snapshot),
      changes: Stream.fromPubSub(updates),

      scan: (on: boolean) =>
        Effect.sync(() => {
          if (scanning === on) return;
          scanning = on;
          for (const adapter of adapters) adapter.scan(on);
          publish();
        }),

      connect: (receiverId: string) =>
        Effect.suspend(() => {
          const adapter = adapters.find((each) =>
            found.get(each.kind)?.some((listed) => listed.id === receiverId),
          );
          const known = [...found.values()].flat().find((each) => each.id === receiverId);
          if (!adapter || !known) return Effect.fail(failed({ kind: "unreachable" }));
          return connectTo(adapter, { kind: "receiver", id: receiverId }, known);
        }),

      pick: (anchor: ScreenRect) =>
        Effect.suspend(() => {
          const adapter = adapters.find((each) => each.kind === "airplay");
          if (!adapter) {
            return Effect.fail(
              failed({
                kind: "unavailable",
                detail: "This build has no system list of receivers.",
              }),
            );
          }
          return connectTo(adapter, { kind: "picker", anchor }, null);
        }),

      // A connect that waits, for the receiver or for the viewer in the system's list, ends
      // first: it holds the turn this takes.
      disconnect: Effect.andThen(
        Effect.sync(() => connecting?.abort()),
        one(
          Effect.gen(function* () {
            if (output.kind !== "local") {
              output = { kind: "local" };
              publish();
            }
            yield* release;
          }),
        ),
      ),

      playChannel: (
        channelId: string,
        options: {
          readonly variants: readonly string[];
          readonly audio?: number | null;
          readonly audioLanguage?: string | null;
          readonly shown: Shown;
        },
      ) =>
        one(
          Effect.gen(function* () {
            const connection = yield* receiver;
            // What it played closes without telling it to stop: the load takes its place.
            yield* drop(true);
            opened.clear();
            const stream = yield* playback.openReceiver(channelId, yield* target(connection), {
              variants: options.variants,
              audio: options.audio ?? null,
              audioLanguage: options.audioLanguage ?? null,
            });
            return yield* load(
              connection,
              stream.sessionId,
              { kind: "channel", channelId },
              0,
              {
                url: stream.url,
                live: true,
                position: 0,
                paused: false,
                duration: null,
                subtitles: false,
              },
              options.shown,
            );
          }),
        ),

      openTitle: (title: TitleRef, upstreamUrl: string) =>
        one(
          Effect.gen(function* () {
            const connection = yield* receiver;
            yield* drop(true);
            opened.clear();
            const session = yield* playback.openReceiverTitle(
              title,
              upstreamUrl,
              yield* target(connection),
            );
            opened.set(session.sessionId, { title, offset: session.offset });
            return {
              sessionId: session.sessionId,
              title,
              duration: session.duration,
              audio: session.audio,
              subtitles: session.subtitles,
              shows: ["text"],
            } satisfies RemoteTitle;
          }),
        ),

      playTitle: (
        sessionId: string,
        options: {
          readonly position: number;
          readonly audio: number | null;
          readonly subtitle: number | null;
          readonly paused?: boolean | undefined;
          readonly shown: Shown;
        },
      ) =>
        one(
          Effect.gen(function* () {
            const connection = yield* receiver;
            const title = opened.get(sessionId);
            const loaded = title
              ? yield* playback.loadReceiverTitle(sessionId, {
                  audio: options.audio,
                  subtitle: options.subtitle,
                })
              : null;
            if (!title || !loaded) {
              return yield* failed({ kind: "stream", failure: STOPPED });
            }
            // The same session with other tracks or from another position: only its load changes.
            yield* drop(false);
            return yield* load(
              connection,
              sessionId,
              { kind: "title", title: title.title },
              title.offset,
              {
                url: loaded.url,
                live: false,
                position: Math.max(0, options.position - title.offset),
                paused: options.paused === true,
                // The receiver reads the title's length from its playlist.
                duration: null,
                subtitles: loaded.subtitles,
              },
              options.shown,
            );
          }),
        ),

      command: (mine: number, command: RemoteCommand) =>
        one(
          Effect.gen(function* () {
            const now = playing;
            const connection = connected?.connection;
            if (!now || !connection || now.generation !== mine) return;
            switch (command.command) {
              case "play":
                return yield* told(() => connection.play(mine));
              case "pause":
                return yield* told(() => connection.pause(mine));
              case "seek":
                return yield* told(() =>
                  connection.seek(mine, Math.max(0, command.position - now.offset)),
                );
              case "subtitles":
                yield* told(() => connection.showSubtitles(mine, command.on));
                if (playing === now && output.kind === "receiver") {
                  now.media = { ...now.media, subtitles: command.on };
                  output = { ...output, media: now.media };
                  publish();
                }
                return;
              case "stop":
                yield* drop(true);
                opened.clear();
                yield* Effect.promise(() => connection.stop(mine).catch(() => {}));
                if (output.kind === "receiver") output = { ...output, media: null, failure: null };
                publish();
            }
          }),
        ),

      setVolume: (volume: {
        readonly level?: number | undefined;
        readonly muted?: boolean | undefined;
      }) =>
        Effect.suspend(() => {
          const connection = connected?.connection;
          if (!connection?.volume) return Effect.void;
          return told(() =>
            connection.setVolume({
              ...(volume.level !== undefined ? { level: volume.level } : {}),
              ...(volume.muted !== undefined ? { muted: volume.muted } : {}),
            }),
          );
        }),

      remote: Effect.sync(() => output.kind === "receiver" || output.kind === "lost"),

      savesProgress: (mine: number) =>
        Effect.map(
          subscriptions.key,
          (account) => playing?.generation === mine && playing.account === account,
        ),

      accountChanged: one(
        Effect.gen(function* () {
          const was = playing;
          opened.clear();
          yield* drop(true);
          if (was && connected) {
            yield* Effect.promise(() => connected!.connection.stop(was.generation).catch(() => {}));
          }
          if (output.kind === "receiver") output = { ...output, media: null, failure: null };
          publish();
        }),
      ),
    };
  });
}

/** The session a receiver played was closed, or isn't one it can play from. */
const STOPPED: StreamFailure = { kind: "network", detail: "The stream was closed." };
