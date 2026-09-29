// The typed contract between the UI and the main process.
//
// Add a method by giving it an input schema in `ipcInputs` and a result type in `IpcOutputs`.
// The main process refuses to start unless every method has a handler (see src/main/ipc.ts).
import { type } from "arktype";
import type { Result } from "./errors.ts";
import type { CatalogueStatus, Category, LiveChannel } from "./library.ts";
import { CODECS, type StreamFailure, type StreamSession } from "./playback.ts";
import { Preferences } from "./preferences.ts";
import type { SubscriptionSummary } from "./subscription.ts";

const none = type("undefined");

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
  "playback.open": type({ channelId: "string", decoders: type.enumerated(...CODECS).array() }),
  "playback.close": type({ sessionId: "string" }),
  "playback.failure": type({ sessionId: "string" }),
  "preferences.get": none,
  // The recent list changes only through recordWatch. Leaving it out also keeps its default from
  // filling in an empty list on every update.
  "preferences.update": Preferences.omit("recentChannelIds").partial(),
  "preferences.recordWatch": type({ channelId: "string" }),
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
  /** Opens a stream for a channel and closes any stream that was open before. */
  "playback.open": StreamSession;
  "playback.close": null;
  /** Why a session's upstream request failed, or null if it has not failed. */
  "playback.failure": StreamFailure | null;
  "preferences.get": Preferences;
  "preferences.update": Preferences;
  /** Remembers a channel as last and recently watched. */
  "preferences.recordWatch": Preferences;
}

export type IpcMethod = keyof IpcOutputs;
export type IpcInput<M extends IpcMethod> = (typeof ipcInputs)[M]["infer"];
export type IpcOutput<M extends IpcMethod> = IpcOutputs[M];

/** Methods without input can be called with no argument. */
export type IpcArgs<M extends IpcMethod> =
  undefined extends IpcInput<M> ? [input?: IpcInput<M>] : [input: IpcInput<M>];

/** Events the main process pushes to the UI. */
export interface IpcEvents {
  /** The live catalogue changed after a refresh. */
  "library.updated": CatalogueStatus;
}
export type IpcEvent = keyof IpcEvents;

/** The API the preload script exposes as `window.mrStreamer`. */
export interface BridgeApi {
  invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<Result<IpcOutput<M>>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
}
