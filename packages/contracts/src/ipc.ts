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
} from "./ondemand.ts";
import {
  CODECS,
  type ChannelTracks,
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
  "subscription.remove": none,
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
  /** Downloads the guide now, and answers with its status. */
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
      decoders: decoders(),
      "repair?": "boolean",
      /** The sound track to play, by PID; the channel's first otherwise. */
      "audio?": "number.integer >= 0",
      /** Without `audio`, the sound in this language when the channel has it: "nl". */
      "audioLanguage?": "string",
    }),
  "playback.openTitle": () => type({ title: TitleRef, decoders: decoders() }),
  "playback.close": () => type({ sessionId: "string" }),
  "playback.closeAll": none,
  "playback.failure": () => type({ sessionId: "string" }),
  "playback.tracks": () => type({ sessionId: "string" }),
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
    }),
  "viewing.removeFromContinue": () => type({ commandId: "string", title: TitleRef }),
  "viewing.progress": () => type({ "movieIds?": "string[]", "seriesIds?": "string[]" }),
  "updates.status": none,
  "updates.setChannel": () => type({ channel: "'stable' | 'nightly'" }),
  "updates.check": none,
  "updates.download": none,
  "updates.cancel": none,
  "updates.restart": none,
  "updates.dismiss": () => type({ version: "string" }),
  "licences.list": none,
  "licences.text": () => type({ id: "string" }),
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
  /** Takes a movie, or an episode's series, out of Continue watching until it plays again. */
  "viewing.removeFromContinue": Viewing;
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
  /** Third-party components the app ships, with their licences, by name. */
  "licences.list": readonly ThirdPartyNotice[];
  /** The full notice of one component from `licences.list`, as plain text. */
  "licences.text": string;
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
  /** A new programme guide is loaded. */
  "guide.updated": null;
  /** The movie and series lists were fetched again, or the fetch failed and kept them. */
  "ondemand.updated": OnDemandStatus;
  /** Favourites or recently watched channels changed, up to `sequence`. */
  "viewing.changed": { readonly sequence: number };
  /** The update moved on, for example a download's progress. */
  "updates.changed": UpdateStatus;
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
