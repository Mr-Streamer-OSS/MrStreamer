// The typed contract between the UI and the main process.
//
// Add a method by giving it an input schema in `ipcInputs` and a result type in `IpcOutputs`.
// The main process refuses to start unless every method has a handler (see src/main/ipc.ts).
import { type } from "arktype";
import type { Result } from "./errors.ts";
import type { Listing, Programme, ProgrammeMatch } from "./guide.ts";
import type { CatalogueStatus, Category, LiveChannel } from "./library.ts";
import type { ThirdPartyNotice } from "./licences.ts";
import {
  TitleRef,
  TITLE_KINDS,
  TITLE_SORTS,
  type OnDemandStatus,
  type Title,
  type TitleCategory,
  type TitleDetails,
  type TitlePage,
} from "./ondemand.ts";
import { CODECS, type StreamFailure, type StreamSession, type TitleSession } from "./playback.ts";
import { Preferences } from "./preferences.ts";
import type { SubscriptionSummary } from "./subscription.ts";
import type { UpdateStatus } from "./updates.ts";
import type { TitleProgress, Viewing } from "./viewing.ts";

const none = type("undefined");
const titleKind = type.enumerated(...TITLE_KINDS);
const decoders = type.enumerated(...CODECS).array();

/** Login details as typed by the user. `server` may also hold a pasted M3U link. */
export const LoginInput = type({
  server: "string > 0",
  username: "string",
  password: "string",
});
export type LoginInput = typeof LoginInput.infer;

/** Input schema for every IPC method. The main process validates each call before handling it. */
export const ipcInputs = {
  "subscription.get": none,
  "subscription.connect": LoginInput,
  "subscription.remove": none,
  "library.status": none,
  "library.categories": none,
  "library.channels": type({ "categoryId?": "string", "query?": "string", "ids?": "string[]" }),
  "library.channel": type({ channelId: "string" }),
  "library.refresh": none,
  "guide.listings": type({ channelIds: "string[]" }),
  "guide.schedule": type({ channelId: "string" }),
  "guide.search": type({ query: "string" }),
  "ondemand.status": none,
  "ondemand.refresh": none,
  "ondemand.categories": type({ kind: titleKind }),
  "ondemand.titles": type({
    kind: titleKind,
    "categoryId?": "string",
    sort: type.enumerated(...TITLE_SORTS),
    offset: "number.integer >= 0",
    limit: "1 <= number.integer <= 500",
  }),
  "ondemand.byIds": type({ kind: titleKind, ids: "string[]" }),
  "ondemand.search": type({ query: "string" }),
  "ondemand.details": type({ kind: titleKind, id: "string > 0" }),
  "playback.open": type({
    channelId: "string",
    decoders,
    "repair?": "boolean",
  }),
  "playback.openTitle": type({ title: TitleRef, decoders }),
  "playback.close": type({ sessionId: "string" }),
  "playback.failure": type({ sessionId: "string" }),
  "preferences.get": none,
  "preferences.update": Preferences.partial(),
  "viewing.get": none,
  // Each change carries an id the UI makes up, so sending it again changes nothing more.
  "viewing.setFavourite": type({ commandId: "string", channelId: "string", favourite: "boolean" }),
  "viewing.recordWatch": type({ commandId: "string", channelId: "string" }),
  "viewing.recordProgress": type({
    commandId: "string",
    title: TitleRef,
    position: "number >= 0",
    duration: "number > 0",
  }),
  "viewing.removeFromContinue": type({ commandId: "string", title: TitleRef }),
  "viewing.progress": type({ "movieIds?": "string[]", "seriesId?": "string" }),
  "updates.status": none,
  "updates.setChannel": type({ channel: "'stable' | 'nightly'" }),
  "updates.check": none,
  "updates.download": none,
  "updates.cancel": none,
  "updates.restart": none,
  "updates.dismiss": type({ version: "string" }),
  "licences.list": none,
  "licences.text": type({ id: "string" }),
} satisfies Record<keyof IpcOutputs, { infer: unknown }>;

/** What each IPC method resolves to when it succeeds. */
export interface IpcOutputs {
  "subscription.get": SubscriptionSummary | null;
  "subscription.connect": SubscriptionSummary;
  "subscription.remove": null;
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
  "ondemand.status": OnDemandStatus;
  /** Fetches the movie and series lists again. */
  "ondemand.refresh": OnDemandStatus;
  /** A kind's categories, in the provider's order. Fetches the lists first when there are none. */
  "ondemand.categories": readonly TitleCategory[];
  /** One page of a category, or of every title without those for adults. */
  "ondemand.titles": TitlePage;
  /** Titles by id, in the order given; ids no longer listed are left out. */
  "ondemand.byIds": readonly Title[];
  /** Movies and series whose name matches, best first, without titles for adults. */
  "ondemand.search": { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  "ondemand.details": TitleDetails;
  /** Opens a stream for a channel and closes any stream that was open before. */
  "playback.open": StreamSession;
  /** Opens a movie or episode, and closes any stream that was open before. */
  "playback.openTitle": TitleSession;
  "playback.close": null;
  /** Why a session's upstream request failed, or null if it has not failed. */
  "playback.failure": StreamFailure | null;
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
export type IpcInput<M extends IpcMethod> = (typeof ipcInputs)[M]["infer"];
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
}
export type IpcEvent = keyof IpcEvents;

/** The API the preload script exposes as `window.mrStreamer`. */
export interface BridgeApi {
  invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<Result<IpcOutput<M>>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
}
