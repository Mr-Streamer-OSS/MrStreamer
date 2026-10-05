// The typed contract between the UI and the main process.
//
// Add a method by giving it an input schema in `ipcInputs` and a result type in `IpcOutputs`.
// The main process refuses to start unless every method has a handler (see src/main/ipc.ts).
import { type } from "arktype";
import type { Result } from "./errors.ts";
import type { GuideStatus, Listing, Programme, ProgrammeMatch } from "./guide.ts";
import type { CatalogueStatus, Category, LiveChannel } from "./library.ts";
import type { ThirdPartyNotice } from "./licences.ts";
import {
  COLLECTION_SORTS,
  isCollectionId,
  ROW_TABS,
  TitleRef,
  TITLE_KINDS,
  type CollectionPage,
  type CollectionRow,
  type CollectionTile,
  type EpisodeDetails,
  type OnDemandStatus,
  type Title,
  type TitleMatches,
  type TitleDetails,
  type TitleKind,
} from "./ondemand.ts";
import type { OutputStatus, RemoteMedia, RemotePlayingTitle, RemoteTitle } from "./output.ts";
import {
  CODECS,
  type ChannelTracks,
  type LivePlaying,
  type StreamFailure,
  type StreamSession,
  type TitleSession,
} from "./playback.ts";
import { Preferences } from "./preferences.ts";
import type { SubscriptionSummary } from "./subscription.ts";
import type { UpdateStatus } from "./updates.ts";
import type { TitleProgress, Viewing } from "./viewing.ts";

// Every schema is built on its method's first call: defining them all would add to every start,
// and most methods aren't called while the app starts.
const none = () => type("undefined");
const titleKind = () => type.enumerated(...TITLE_KINDS);
const decoders = () => type.enumerated(...CODECS).array();

/** Login details as typed by the user. `server` may also hold a pasted M3U link. */
const loginInput = () =>
  type({
    server: "string > 0",
    username: "string",
    password: "string",
  });
export type LoginInput = IpcInput<"subscription.connect">;

/** Input schema for every IPC method. The main process validates each call before handling it. */
export const ipcInputs = {
  "subscription.get": none,
  "subscription.connect": loginInput,
  /**
   * Forgets the login and what was loaded with it. `eraseViewing` also deletes the account's
   * favourites, watch history and progress, which otherwise stay for when it connects again.
   */
  "subscription.remove": () => type({ "eraseViewing?": "boolean" }),
  /** Asks the provider for the account's status now: expiry and connections in use. */
  "subscription.recheck": none,
  "library.status": none,
  "library.categories": none,
  "library.channels": () =>
    type({ "categoryId?": "string", "query?": "string", "ids?": "string[]" }),
  "library.channel": () => type({ channelId: "string" }),
  "library.refresh": none,
  "guide.listings": () => type({ channelIds: "string[]" }),
  "guide.schedule": () => type({ channelId: "string" }),
  "guide.search": () => type({ query: "string" }),
  "guide.status": none,
  /**
   * Asks the subscription for its guide now and downloads it. Answers with the status, also when
   * the subscription has no guide, which is no failure.
   */
  "guide.refresh": none,
  "ondemand.status": none,
  "ondemand.refresh": none,
  "ondemand.search": () => type({ query: "string" }),
  /** Movies or series only, for the field in their tab bar. */
  "ondemand.searchKind": () => type({ kind: titleKind(), query: "string" }),
  "ondemand.rows": () =>
    type({ kind: titleKind(), tab: type.enumerated(...ROW_TABS), "like?": "string > 0" }),
  "ondemand.tiles": () => type({ kind: titleKind(), of: "'genres' | 'services'" }),
  "ondemand.collection": () =>
    type({
      kind: titleKind(),
      id: type("string").narrow(isCollectionId),
      "sort?": type.enumerated(...COLLECTION_SORTS),
      offset: "number.integer >= 0",
      limit: "1 <= number.integer <= 500",
    }),
  "ondemand.details": () => type({ kind: titleKind(), id: "string > 0" }),
  /** One season of a series version, by number, asked for when the viewer opens it. */
  "ondemand.season": () => type({ id: "string > 0", season: "number.integer >= 0" }),
  "ondemand.titles": () => type({ kind: titleKind(), ids: "string[]" }),
  "playback.open": () =>
    type({
      channelId: "string",
      /**
       * The channel's stream to play, by id, instead of the one chosen before or Auto's. Only it
       * is tried.
       */
      "variant?": "string",
      decoders: decoders(),
      "repair?": "boolean",
      /** The chosen sound track id. MPEG-TS uses its PID; HLS selection happens in the engine. */
      "audio?": "number.integer >= 0",
      /** Without `audio`, the sound in this language when the channel has it: "nl". */
      "audioLanguage?": "string",
      /**
       * Nobody chose to watch this: a page's muted preview. Refused while a receiver has
       * playback, whose connection to the provider it would take.
       */
      "preview?": "boolean",
    }),
  "playback.openTitle": () => type({ title: TitleRef, decoders: decoders() }),
  "playback.close": () => type({ sessionId: "string" }),
  "playback.closeAll": none,
  "playback.failure": () => type({ sessionId: "string" }),
  "playback.tracks": () => type({ sessionId: "string" }),
  "playback.playing": () => type({ sessionId: "string" }),
  "output.status": none,
  /** Looks for receivers while `on`, as while the list of them shows. Plays and changes nothing. */
  "output.scan": () => type({ on: "boolean" }),
  /** Connects to a receiver from the status's list. What plays here goes on meanwhile. */
  "output.connect": () => type({ receiverId: "string > 0" }),
  /**
   * Opens the system's own list of receivers at `anchor`, a place in the window in CSS pixels,
   * and answers once the viewer picked one or closed it.
   */
  "output.pick": () =>
    type({
      anchor: type({ x: "number", y: "number", width: "number >= 0", height: "number >= 0" }),
    }),
  /** Back to this computer: ends what the receiver plays and lets go of it. */
  "output.disconnect": none,
  "output.playChannel": () =>
    type({
      channelId: "string",
      "variant?": "string",
      "audio?": "number.integer >= 0",
      "audioLanguage?": "string",
      /** What the receiver may show about it: the channel's name. */
      name: "string",
    }),
  "output.openTitle": () => type({ title: TitleRef }),
  "output.playTitle": () =>
    type({
      sessionId: "string",
      /** Seconds into the title to start at. */
      position: "number >= 0",
      audio: "number.integer >= 0 | null",
      subtitle: "number.integer >= 0 | null",
      /** Start held on the first picture. */
      "paused?": "boolean",
      /** What the receiver may show about it: "Escape from New York", "S2 E3 · Its name", a poster. */
      name: "string",
      "detail?": "string | null",
      "artworkUrl?": "string | null",
    }),
  "output.command": () =>
    type({ generation: "number.integer", command: "'play' | 'pause' | 'stop'" })
      .or({ generation: "number.integer", command: "'seek'", position: "number >= 0" })
      .or({ generation: "number.integer", command: "'subtitles'", on: "boolean" }),
  "output.volume": () => type({ "level?": "0 <= number <= 1", "muted?": "boolean" }),
  "output.playingTitle": none,
  "preferences.get": none,
  "preferences.update": () => Preferences.partial(),
  "viewing.get": none,
  // Each change carries an id the UI makes up, so sending it again changes nothing more.
  "viewing.setFavourite": () =>
    type({ commandId: "string", channelId: "string", favourite: "boolean" }),
  "viewing.recordWatch": () => type({ commandId: "string", channelId: "string" }),
  "viewing.recordProgress": () =>
    type({
      commandId: "string",
      title: TitleRef,
      position: "number >= 0",
      duration: "number > 0",
      /** When this play of the title began: epoch milliseconds. */
      since: "number",
    }),
  /** Every version played of the movies and series with these ids. */
  "viewing.removeFromContinue": () =>
    type({ commandId: "string", "movieIds?": "string[]", "seriesIds?": "string[]" }),
  /** Every version of the series, by id. */
  "viewing.finishSeries": () => type({ commandId: "string", seriesIds: "string[]" }),
  "viewing.progress": () => type({ "movieIds?": "string[]", "seriesIds?": "string[]" }),
  "updates.status": none,
  "updates.setChannel": () => type({ channel: "'stable' | 'nightly'" }),
  "updates.check": none,
  "updates.download": none,
  "updates.cancel": none,
  "updates.restart": none,
  "updates.dismiss": () => type({ version: "string" }),
  "updates.openStore": none,
  "licences.list": none,
  "licences.text": () => type({ id: "string" }),
  "window.miniPlayerAvailable": none,
  "window.setMiniPlayer": () => type({ on: "boolean" }),
} satisfies Record<keyof IpcOutputs, () => { infer: unknown }>;

/** What each IPC method resolves to when it succeeds. */
export interface IpcOutputs {
  "subscription.get": SubscriptionSummary | null;
  "subscription.connect": SubscriptionSummary;
  "subscription.remove": null;
  "subscription.recheck": SubscriptionSummary | null;
  "library.status": CatalogueStatus;
  "library.categories": readonly Category[];
  /**
   * All channels in a category, the best matches for a query across the catalogue, or the
   * channels with the given ids in that order.
   */
  "library.channels": readonly LiveChannel[];
  "library.channel": LiveChannel;
  "library.refresh": CatalogueStatus;
  /** Now and next per channel id, for the channels the guide covers. */
  "guide.listings": Readonly<Record<string, Listing>>;
  /** The channel's programme on now and the rest the guide knows, in time order. */
  "guide.schedule": readonly Programme[];
  /** Programmes on now or later whose title matches, on now first. */
  "guide.search": readonly ProgrammeMatch[];
  "guide.status": GuideStatus;
  "guide.refresh": GuideStatus;
  "ondemand.status": OnDemandStatus;
  /** Fetches the movie and series lists again. */
  "ondemand.refresh": OnDemandStatus;
  /** Movies and series whose name matches, best first, without titles for adults. */
  "ondemand.search": { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  "ondemand.searchKind": TitleMatches;
  /** A title's details, asked for when the viewer opens it: the provider's and TMDB's. */
  "ondemand.details": TitleDetails;
  /**
   * The season's episodes as the provider lists them, in its order, with TMDB's name, story,
   * still, date, rating and credits where it has them. Asks TMDB about that season alone.
   */
  "ondemand.season": readonly EpisodeDetails[];
  /**
   * Movies or series by the id of any of their versions, from the lists alone, in the order
   * asked; ids the lists don't have are left out. Asks the provider nothing.
   */
  "ondemand.titles": readonly Title[];
  /** A tab's rows; For you starts with titles like `like`, one watched lately. */
  "ondemand.rows": readonly CollectionRow[];
  /** Genres or streaming services as tiles, most stocked first. */
  "ondemand.tiles": readonly CollectionTile[];
  /** One page of a collection. */
  "ondemand.collection": CollectionPage;
  /** Opens a stream for a channel and closes any stream that was open before. */
  "playback.open": StreamSession;
  /** Opens a movie or episode, and closes any stream that was open before. */
  "playback.openTitle": TitleSession;
  "playback.close": null;
  /** Closes every stream, including a title still reading its file before its session is known. */
  "playback.closeAll": null;
  /** Why a session's upstream request failed, or null if it has not failed. */
  "playback.failure": StreamFailure | null;
  /** A playing channel's sound and subtitle tracks; null until its stream has started. */
  "playback.tracks": ChannelTracks | null;
  /** Which of a channel's streams its session plays, and those that failed first. */
  "playback.playing": LivePlaying | null;
  /** Where playback goes, and the receivers found. */
  "output.status": OutputStatus;
  "output.scan": null;
  /** Resolves once the receiver takes media, or failed. */
  "output.connect": OutputStatus;
  /** Resolves with a receiver connected, or with nothing changed when the viewer picked none. */
  "output.pick": OutputStatus;
  /** Resolves once the receiver is let go of. */
  "output.disconnect": null;
  /** Plays a channel on the receiver in place of what it had, and closes any stream open here. */
  "output.playChannel": RemoteMedia;
  /** Opens a movie or episode for the receiver, and closes any stream open here. Nothing plays yet. */
  "output.openTitle": RemoteTitle;
  /** Plays an opened title on the receiver from a position with these tracks. */
  "output.playTitle": RemoteMedia;
  /** Does nothing when `generation` is no longer what the receiver plays. */
  "output.command": null;
  "output.volume": null;
  /**
   * The title the receiver plays, with what its file holds and the tracks chosen, for a window
   * opened while it plays. Null for a channel, or when it plays nothing.
   */
  "output.playingTitle": RemotePlayingTitle | null;
  "preferences.get": Preferences;
  "preferences.update": Preferences;
  /** Favourites and recently watched channels of the connected account. */
  "viewing.get": Viewing;
  /** Adds a channel to the favourites, or takes it out. */
  "viewing.setFavourite": Viewing;
  /** Remembers a channel as watched, and as the last one. */
  "viewing.recordWatch": Viewing;
  /** Remembers how far a movie or episode played. */
  "viewing.recordProgress": Viewing;
  /** Takes movies and series out of Continue watching until a play begun afterwards. */
  "viewing.removeFromContinue": Viewing;
  /**
   * Records that a series' last episode was watched: every version played leaves Continue
   * watching, as a removal does, until a play begun afterwards.
   */
  "viewing.finishSeries": Viewing;
  /** How far the given movies, or every episode of a series, got. */
  "viewing.progress": readonly TitleProgress[];
  "updates.status": UpdateStatus;
  /** Chooses Stable or Nightly and checks what it offers; installs and removes nothing. */
  "updates.setChannel": UpdateStatus;
  "updates.check": UpdateStatus;
  /** Downloads the update the last check found. Resolves when it is ready or failed. */
  "updates.download": UpdateStatus;
  /** Stops a download in progress. */
  "updates.cancel": null;
  /** Quits and installs the downloaded update. Only after the user confirmed the restart. */
  "updates.restart": null;
  /** Closes the notice for a version; Settings keeps offering it. */
  "updates.dismiss": UpdateStatus;
  /** Opens the app's page in the Microsoft Store, for a copy the Store updates. */
  "updates.openStore": null;
  /** Third-party components the app ships, with their licences, by name. */
  "licences.list": readonly ThirdPartyNotice[];
  /** The full notice of one component from `licences.list`, as plain text. */
  "licences.text": string;
  /** Whether the window can float over others as a mini player; Wayland keeps no window on top. */
  "window.miniPlayerAvailable": boolean;
  /**
   * Shrinks the window to a small picture that stays on top of other windows, or puts it back
   * where and as it was. Resolves once the window has moved.
   */
  "window.setMiniPlayer": null;
}

export type IpcMethod = keyof IpcOutputs;
export type IpcInput<M extends IpcMethod> = ReturnType<(typeof ipcInputs)[M]>["infer"];
export type IpcOutput<M extends IpcMethod> = IpcOutputs[M];

/** Methods without input can be called with no argument. */
export type IpcArgs<M extends IpcMethod> =
  undefined extends IpcInput<M> ? [input?: IpcInput<M>] : [input: IpcInput<M>];

/** Events the main process pushes to the UI. */
export interface IpcEvents {
  /** A catalogue refresh finished, or failed and kept the previous channels. */
  "library.updated": CatalogueStatus;
  /** A new programme guide is loaded, or the one loaded was dropped. */
  "guide.updated": null;
  /** The movie and series lists were fetched again, or the fetch failed and kept them. */
  "ondemand.updated": OnDemandStatus;
  /** TMDB's details of a title arrived after its details were given without them. */
  "ondemand.detailsChanged": { readonly kind: TitleKind; readonly id: string };
  /** Favourites or recently watched channels changed, up to `sequence`. */
  "viewing.changed": { readonly sequence: number };
  /** The update moved on, for example a download's progress. */
  "updates.changed": UpdateStatus;
  /** Where playback goes changed, or what the receiver plays did, or the receivers found. */
  "output.changed": OutputStatus;
  /**
   * Whether the window fills the screen, where the system hides its window controls. Sent when
   * that changes, and once the page loads.
   */
  "window.fullScreen": boolean;
}
export type IpcEvent = keyof IpcEvents;

/** The API the preload script exposes as `window.mrStreamer`. */
export interface BridgeApi {
  invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<Result<IpcOutput<M>>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
}
