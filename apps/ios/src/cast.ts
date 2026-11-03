import { rewritePlaylist, type Refusal, type RouteKind } from "./cast-media.ts";
import { store, useStore, type Store } from "./store.ts";

// Play on TV: an open Cast sender, with no Google SDK. `modules/cast` finds TVs on the local
// network, opens the TLS connection to one and serves media from the phone; everything the
// protocol says is decided here. playback.ts owns what plays and decides when a TV plays it.
//
// The TV runs Google's Default Media Receiver and is given one address on the phone's relay per
// load, under a token the native side made, with the title and its line. A provider's address,
// login and headers stay on the phone: the relay reads the provider and rewrites each playlist
// (`cast-media.ts`). The connection isn't authenticated: whatever answers the browse as a TV gets
// what a TV gets, and nothing more.
//
// The TV plays only while the app is open. Leaving it with a TV connected, the native side asks
// iOS for a moment in the background at once, in which playback.ts stops the TV and closes the
// relay (`onLeftApp`); when iOS gives none, or it runs out, the native side closes every relay and
// connection itself.

/** A TV on the local network, as it names itself. */
export interface Tv {
  readonly id: string;
  /** "Living Room TV". */
  readonly name: string;
  /** "Chromecast", "Google TV Streamer"; null when it doesn't say. */
  readonly model: string | null;
}

/** Looking for TVs, while the chooser is open. */
export type Search =
  | { readonly kind: "off" }
  | { readonly kind: "searching"; readonly tvs: readonly Tv[] }
  /** Local Network is off for the app in Settings. */
  | { readonly kind: "denied" }
  | { readonly kind: "failed" };

/** The TV's own volume, 0 to 1. */
export interface Volume {
  readonly level: number;
  readonly muted: boolean;
}

/** How what a TV plays stands, as it last said. */
export interface TvStatus {
  readonly state: "loading" | "playing" | "paused" | "ended" | "failed" | "stopped";
  /** Seconds into it. */
  readonly time: number;
  /** Its length in seconds; null for a channel or before the TV knows. */
  readonly duration: number | null;
}

/** What a load gives the TV. */
export interface TvMedia {
  /** The relay's address for it. */
  readonly address: string;
  readonly contentType: string;
  readonly live: boolean;
  /** The segment format of an HLS stream; null for a file. */
  readonly segments: "fmp4" | "ts" | null;
  readonly title: string;
  readonly subtitle: string;
  /** Seconds to start a title from. */
  readonly from: number;
  readonly paused: boolean;
}

/** What one load plays, until it is stopped or the link goes. */
export interface TvLoaded {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Stops the TV's media; resolves once the TV answered or didn't in time. */
  stop(): Promise<void>;
}

/** The open connection to one TV with the media receiver running on it. */
export interface TvLink {
  readonly tv: Tv;
  readonly volume: Pick<Store<Volume | null>, "get" | "subscribe">;
  setVolume(level: number): void;
  /** Loads `media`; rejects when the TV refuses it or doesn't answer. */
  load(media: TvMedia, status: (status: TvStatus) => void): Promise<TvLoaded>;
  /** Stops the receiver and closes the connection, within a few seconds whatever the TV does. */
  close(): Promise<void>;
  /** Resolves when the link went on its own: the TV, the network or another sender ended it. */
  readonly lost: Promise<void>;
}

/** A refusal said before anything reached the TV, for playback.ts to show. */
export class TvRefused extends Error {
  readonly refusal: Refusal | "network";
  constructor(refusal: Refusal | "network") {
    super(`Can't play on a TV: ${refusal}`);
    this.refusal = refusal;
  }
}

/** A route the relay serves under a load's token: its id and the address it reads. */
interface RelayRoute {
  readonly id: string;
  readonly url: string;
  readonly playlist: boolean;
}

type Listener<E> = (event: E) => void;

interface CastModule {
  /** Starts browsing for TVs; `onBrowse` says how it goes and what it found. */
  browse(): void;
  stopBrowsing(): void;
  /** Opens the TLS connection `channel` to TV `device`, as `onBrowse` named it. */
  connect(channel: string, device: string): Promise<void>;
  /** Writes bytes, in base64, on the channel; nothing once it closed. */
  write(channel: string, data: string): void;
  disconnect(channel: string): void;
  /**
   * Serves `url` as route "0" of a new token on the phone's Wi-Fi address, reading it with
   * `headers`. Null when the phone has no private Wi-Fi IPv4 address.
   */
  serve(
    url: string,
    headers: Readonly<Record<string, string>> | null,
    playlist: boolean,
  ): Promise<{ readonly address: string; readonly token: string } | null>;
  /** Adds routes to a token. */
  route(token: string, routes: readonly RelayRoute[]): void;
  /** Reads a playlist route as the TV would, after redirects; null when it can't be read. */
  read(token: string, id: string): Promise<{ readonly url: string; readonly body: string } | null>;
  /** Answers an `onPlaylist` request with the rewritten text, or null to refuse it. */
  answer(request: string, body: string | null): void;
  /** Removes the token and resolves once every request under it, to the TV and upstream, ended. */
  revoke(token: string): Promise<void>;
  /** Gives back the time iOS gave in the background for `onBackground`. */
  endBackground(): void;
  addListener(
    event: "onBrowse",
    listener: Listener<{ state: "searching" | "denied" | "failed"; tvs: Tv[] }>,
  ): { remove(): void };
  addListener(
    event: "onData",
    listener: Listener<{ channel: string; data: string }>,
  ): { remove(): void };
  addListener(event: "onClosed", listener: Listener<{ channel: string }>): { remove(): void };
  addListener(
    event: "onPlaylist",
    listener: Listener<{ request: string; token: string; url: string; body: string }>,
  ): { remove(): void };
  /**
   * The app left the foreground with a connection open; iOS's time in the background is held
   * until `endBackground`, or until it runs out and the native side closed everything itself.
   */
  addListener(event: "onBackground", listener: Listener<object>): { remove(): void };
}

let found: CastModule | null | undefined;
/** The native module, or null in a build without it; looked up on first use, as the tests need. */
function native(): CastModule | null {
  if (found !== undefined) return found;
  const host: { expo?: { modules?: { Cast?: CastModule } } } = globalThis;
  found = host.expo?.modules?.Cast ?? null;
  if (found) listen(found);
  return found;
}

/** Whether this build can play on a TV at all. */
export const tvAvailable = () => native() !== null;

const search = store<Search>({ kind: "off" });
export const useTvSearch = () => useStore(search);
let browsing = 0;

/**
 * Looks for TVs until the returned stop is called: only while the chooser is open, so iOS asks
 * for Local Network the first time it opens and never before.
 */
export function browseTvs(): () => void {
  const module = native();
  if (!module) return () => {};
  if (browsing++ === 0) {
    search.set({ kind: "searching", tvs: [] });
    module.browse();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--browsing > 0) return;
    module.stopBrowsing();
    search.set({ kind: "off" });
  };
}

/** Each open channel's reader, by its name. */
const channels = new Map<string, { read: (bytes: Uint8Array) => void; closed: () => void }>();
/** Each served token's playlist rewriting. */
const relays = new Map<string, (url: string, body: string) => string | null>();
/** Told when the app left the foreground with a TV connected. */
let leaving: ((done: () => void) => void) | null = null;

function listen(module: CastModule) {
  module.addListener("onBrowse", ({ state, tvs }) => {
    if (browsing === 0) return;
    search.set(state === "searching" ? { kind: "searching", tvs } : { kind: state });
  });
  module.addListener("onData", ({ channel, data }) =>
    channels.get(channel)?.read(fromBase64(data)),
  );
  module.addListener("onClosed", ({ channel }) => channels.get(channel)?.closed());
  module.addListener("onPlaylist", ({ request, token, url, body }) => {
    let answer: string | null = null;
    try {
      answer = relays.get(token)?.(url, body) ?? null;
    } finally {
      module.answer(request, answer);
    }
  });
  module.addListener("onBackground", () => {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      module.endBackground();
    };
    if (leaving) leaving(release);
    else release();
  });
}

// --- The relay -------------------------------------------------------------------------------

/** One load's media on the relay, until revoked. */
export interface Relay {
  /** The address the TV loads. */
  readonly address: string;
  readonly contentType: string;
  /** An HLS stream's segment format, as its first variant says; null for a file. */
  readonly segments: "fmp4" | "ts" | null;
  /** Ends every request under it; resolves once they all ended. */
  revoke(): Promise<void>;
}

const extension = (url: string, fallback: string) =>
  /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? fallback;

/**
 * Serves `url` for one load: a file as it is, an HLS stream with each playlist rewritten as it is
 * read. An HLS stream's playlist, and its first variant's, are read once first, so a stream the
 * TV can't be given is refused before anything reaches it. `sound` is the chosen sound's
 * language. Rejects with `TvRefused`.
 */
export async function serveOnRelay(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  kind: { readonly hls: true } | { readonly hls: false; readonly contentType: string },
  sound: string | null,
): Promise<Relay> {
  const module = native();
  if (!module) throw new TvRefused("network");
  const served = await module.serve(url, headers ?? null, kind.hls);
  if (!served) throw new TvRefused("network");
  const { token } = served;
  const revoke = () => {
    relays.delete(token);
    return module.revoke(token);
  };
  if (!kind.hls) {
    return {
      address: `${served.address}0.${extension(url, "mp4")}`,
      contentType: kind.contentType,
      segments: null,
      revoke,
    };
  }
  let next = 1;
  /** Rewrites one playlist read from `base`, adding the routes it names to the token. */
  const rewrite = (base: string, body: string) => {
    const made: RelayRoute[] = [];
    const route = (target: string, kind: RouteKind) => {
      const id = String(next++);
      made.push({ id, url: target, playlist: kind === "playlist" });
      return `${id}.${kind === "playlist" ? "m3u8" : extension(target, "ts")}`;
    };
    const rewritten = rewritePlaylist(body, base, route, sound);
    if (rewritten.kind === "playlist") module.route(token, made);
    return rewritten;
  };
  relays.set(token, (base, body) => {
    const rewritten = rewrite(base, body);
    return rewritten.kind === "playlist" ? rewritten.text : null;
  });
  try {
    const entry = await module.read(token, "0");
    if (!entry) throw new TvRefused("stream");
    let first = rewrite(entry.url, entry.body);
    if (first.kind === "playlist" && first.variant !== null) {
      const variant = await module.read(token, first.variant.replace(/\.m3u8$/, ""));
      if (!variant) throw new TvRefused("stream");
      first = rewrite(variant.url, variant.body);
    }
    if (first.kind === "refused") throw new TvRefused(first.refusal);
    return {
      address: `${served.address}0.m3u8`,
      contentType: "application/x-mpegURL",
      segments: first.segments ?? "ts",
      revoke,
    };
  } catch (cause) {
    await revoke();
    throw cause;
  }
}

// --- Background ------------------------------------------------------------------------------

/**
 * Told when the app leaves the foreground with a TV connected, with the call that gives back the
 * time iOS gave to stop it. playback.ts registers it.
 */
export function onLeftApp(listener: ((done: () => void) => void) | null) {
  native();
  leaving = listener;
}

// --- The Cast protocol -----------------------------------------------------------------------

const SENDER = "sender-0";
const PLATFORM = "receiver-0";
const NAMESPACE = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
} as const;
/** Google's Default Media Receiver, which needs no registration. */
const MEDIA_RECEIVER = "CC1AD845";
/** The protocol's limit on one frame's message. */
const MAX_FRAME = 65_535;

const TIMING = {
  connect: 6000,
  launch: 12_000,
  answer: 8000,
  close: 2500,
  ping: 5000,
  silence: 15_000,
  poll: 1000,
};

interface CastMessage {
  readonly sourceId: string;
  readonly destinationId: string;
  readonly namespace: string;
  readonly payload: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function varint(value: number): number[] {
  const bytes = [];
  for (; value > 0x7f; value >>>= 7) bytes.push((value & 0x7f) | 0x80);
  return [...bytes, value];
}

/** A message as one frame: its length in four bytes, then a protobuf `CastMessage`. */
function encodeFrame(message: CastMessage): Uint8Array {
  const parts: number[] = [1 << 3, 0];
  const text = (field: number, value: string) => {
    const bytes = encoder.encode(value);
    parts.push((field << 3) | 2, ...varint(bytes.length), ...bytes);
  };
  text(2, message.sourceId);
  text(3, message.destinationId);
  text(4, message.namespace);
  parts.push(5 << 3, 0);
  text(6, message.payload);
  if (parts.length > MAX_FRAME) throw new RangeError("Cast message over the frame limit");
  const frame = new Uint8Array(4 + parts.length);
  new DataView(frame.buffer).setUint32(0, parts.length);
  frame.set(parts, 4);
  return frame;
}

/** The message in one frame's body, or null when it isn't a text `CastMessage`. */
function decodeFrame(body: Uint8Array): CastMessage | null {
  const fields = new Map<number, Uint8Array>();
  let binary = false;
  for (let at = 0; at < body.length;) {
    const tag = readVarint(body, at);
    if (!tag) return null;
    at = tag.next;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = readVarint(body, at);
      if (!value) return null;
      if (number === 5 && value.value !== 0) binary = true;
      at = value.next;
    } else if (wire === 2) {
      const length = readVarint(body, at);
      if (!length || length.next + length.value > body.length) return null;
      fields.set(number, body.subarray(length.next, length.next + length.value));
      at = length.next + length.value;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else return null;
  }
  const text = (number: number) => decoder.decode(fields.get(number) ?? new Uint8Array());
  const message = {
    sourceId: text(2),
    destinationId: text(3),
    namespace: text(4),
    payload: text(6),
  };
  return binary || !message.sourceId || !message.namespace ? null : message;
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let index = 0; index < 10; index++) {
    const byte = bytes[at + index];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if (byte < 0x80) return { value, next: at + index + 1 };
  }
  return null;
}

/** Turns the bytes a channel delivers into the messages they complete; null once they aren't. */
function messageReader(): (chunk: Uint8Array) => CastMessage[] | null {
  let held = new Uint8Array();
  return (chunk) => {
    const joined = new Uint8Array(held.length + chunk.length);
    joined.set(held);
    joined.set(chunk, held.length);
    const messages: CastMessage[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, at, 4).getUint32(0);
      if (length > MAX_FRAME) return null;
      if (joined.length - at - 4 < length) break;
      const message = decodeFrame(joined.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      // A binary message, which nothing the app speaks sends, is passed over.
      if (message) messages.push(message);
    }
    held = joined.slice(at);
    return messages;
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]!;
    out += at + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : "=";
    out += at + 2 < bytes.length ? BASE64[n & 63]! : "=";
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of clean) {
    value = (value << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A JSON payload's fields, or an empty object when it isn't one. */
function payloadOf(message: CastMessage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(message.payload);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
const numberOr = <T>(value: unknown, fallback: T) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** A media status's `playerState`, and `idleReason` when idle, as a `TvStatus` state. */
function stateOf(player: unknown, idle: unknown): TvStatus["state"] {
  if (player === "PLAYING") return "playing";
  if (player === "PAUSED") return "paused";
  if (player !== "IDLE") return "loading";
  if (idle === "FINISHED") return "ended";
  if (idle === "ERROR") return "failed";
  return idle === "CANCELLED" || idle === "INTERRUPTED" ? "stopped" : "loading";
}

let made = 0;

/**
 * Connects to `tv` and starts the media receiver on it. Rejects when it can't be reached or the
 * receiver doesn't start.
 */
export async function connectTv(tv: Tv): Promise<TvLink> {
  const module = native();
  if (!module) throw new Error("This build can't play on a TV.");
  const channel = `c${++made}`;
  const read = messageReader();
  let open = true;
  /** Closing in order: the receiver's answer to STOP is no loss. */
  let closing = false;
  let requests = 0;
  const waiting = new Map<number, (payload: Record<string, unknown>) => void>();
  let transport: string | null = null;
  let session: string | null = null;
  let media: { id: number | null; status: (status: TvStatus) => void } | null = null;
  const volume = store<Volume | null>(null);
  let heard = Date.now();
  let lostNow!: () => void;
  const lost = new Promise<void>((resolve) => (lostNow = resolve));
  let timers: ReturnType<typeof setInterval>[] = [];

  const send = (to: string, namespace: string, payload: object) => {
    if (!open) return;
    module.write(
      channel,
      toBase64(
        encodeFrame({
          sourceId: SENDER,
          destinationId: to,
          namespace,
          payload: JSON.stringify(payload),
        }),
      ),
    );
  };
  const ask = (to: string, namespace: string, payload: object, ms = TIMING.answer) => {
    const requestId = ++requests;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error("The TV didn't answer."));
      }, ms);
      waiting.set(requestId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      send(to, namespace, { ...payload, requestId });
    });
  };
  const end = (by: "us" | "them") => {
    if (!open) return;
    open = false;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    channels.delete(channel);
    module.disconnect(channel);
    if (by === "them") {
      media?.status({ state: "stopped", time: 0, duration: null });
      lostNow();
    }
  };

  const receiverStatus = (payload: Record<string, unknown>) => {
    const status = isRecord(payload["status"]) ? payload["status"] : {};
    const level = status["volume"];
    if (isRecord(level)) {
      volume.set({
        level: numberOr(level["level"], volume.get()?.level ?? 1),
        muted: level["muted"] === true,
      });
    }
    const applications = Array.isArray(status["applications"]) ? status["applications"] : null;
    if (!applications || transport === null) return;
    // Another sender started something else, or the TV's own remote stopped the receiver.
    const ours = applications.some(
      (app) => isRecord(app) && app["sessionId"] === session && app["transportId"] === transport,
    );
    if (!ours && !closing) end("them");
  };

  const mediaStatus = (payload: Record<string, unknown>) => {
    const statuses = Array.isArray(payload["status"]) ? payload["status"] : [];
    for (const status of statuses) {
      if (!isRecord(status) || !media) continue;
      const id = numberOr(status["mediaSessionId"], null);
      if (media.id !== null && id !== media.id) continue;
      const info = isRecord(status["media"]) ? status["media"] : {};
      media.status({
        state: stateOf(status["playerState"], status["idleReason"]),
        time: Math.max(0, numberOr(status["currentTime"], 0)),
        duration: numberOr(info["duration"], null),
      });
    }
  };

  channels.set(channel, {
    read(bytes) {
      const messages = read(bytes);
      if (!messages) return end("them");
      heard = Date.now();
      for (const message of messages) {
        if (!open) return;
        const payload = payloadOf(message);
        if (message.namespace === NAMESPACE.heartbeat) {
          if (payload["type"] === "PING")
            send(message.sourceId, NAMESPACE.heartbeat, { type: "PONG" });
          continue;
        }
        if (message.namespace === NAMESPACE.connection) {
          if (payload["type"] === "CLOSE") end("them");
          continue;
        }
        const requestId = numberOr(payload["requestId"], 0);
        const answer = waiting.get(requestId);
        if (answer) {
          waiting.delete(requestId);
          answer(payload);
        }
        if (payload["type"] === "RECEIVER_STATUS") receiverStatus(payload);
        else if (payload["type"] === "MEDIA_STATUS") mediaStatus(payload);
      }
    },
    closed: () => end("them"),
  });

  try {
    await Promise.race([
      module.connect(channel, tv.id),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("The TV didn't answer.")), TIMING.connect),
      ),
    ]);
    send(PLATFORM, NAMESPACE.connection, { type: "CONNECT", origin: {} });
    timers.push(
      setInterval(() => {
        if (Date.now() - heard > TIMING.silence) return end("them");
        send(PLATFORM, NAMESPACE.heartbeat, { type: "PING" });
      }, TIMING.ping),
    );
    const launched = await ask(
      PLATFORM,
      NAMESPACE.receiver,
      { type: "LAUNCH", appId: MEDIA_RECEIVER },
      TIMING.launch,
    );
    const status = isRecord(launched["status"]) ? launched["status"] : {};
    const app = (Array.isArray(status["applications"]) ? status["applications"] : []).find(
      (each): each is Record<string, unknown> => isRecord(each) && each["appId"] === MEDIA_RECEIVER,
    );
    if (
      launched["type"] !== "RECEIVER_STATUS" ||
      typeof app?.["transportId"] !== "string" ||
      typeof app["sessionId"] !== "string"
    ) {
      throw new Error("The TV didn't start its player.");
    }
    transport = app["transportId"];
    session = app["sessionId"];
    send(transport, NAMESPACE.connection, { type: "CONNECT", origin: {} });
  } catch (cause) {
    end("us");
    throw cause;
  }
  const to = transport;

  const close = async () => {
    if (!open || closing) return;
    closing = true;
    await ask(
      PLATFORM,
      NAMESPACE.receiver,
      { type: "STOP", sessionId: session },
      TIMING.close,
    ).catch(() => undefined);
    send(to, NAMESPACE.connection, { type: "CLOSE" });
    send(PLATFORM, NAMESPACE.connection, { type: "CLOSE" });
    end("us");
  };

  return {
    tv,
    volume,
    setVolume: (level) =>
      send(PLATFORM, NAMESPACE.receiver, {
        type: "SET_VOLUME",
        volume: { level: Math.min(1, Math.max(0, level)) },
        requestId: ++requests,
      }),
    lost,
    close,
    async load(loaded, status) {
      const mine: NonNullable<typeof media> = { id: null, status };
      media = mine;
      const answer = await ask(to, NAMESPACE.media, {
        type: "LOAD",
        sessionId: session,
        media: {
          contentId: loaded.address,
          contentUrl: loaded.address,
          contentType: loaded.contentType,
          streamType: loaded.live ? "LIVE" : "BUFFERED",
          ...(loaded.segments === "fmp4"
            ? { hlsSegmentFormat: "fmp4", hlsVideoSegmentFormat: "fmp4" }
            : loaded.segments === "ts"
              ? { hlsSegmentFormat: "ts", hlsVideoSegmentFormat: "mpeg2_ts" }
              : {}),
          metadata: { metadataType: 0, title: loaded.title, subtitle: loaded.subtitle },
        },
        autoplay: !loaded.paused,
        ...(loaded.live ? {} : { currentTime: loaded.from }),
      });
      const statuses = Array.isArray(answer["status"]) ? answer["status"] : [];
      const first = statuses.find(isRecord);
      if (answer["type"] !== "MEDIA_STATUS" || !first) {
        if (media === mine) media = null;
        throw new Error("The TV couldn't play it.");
      }
      mine.id = numberOr(first["mediaSessionId"], null);
      mediaStatus(answer);
      const poll = setInterval(() => {
        if (media !== mine) return clearInterval(poll);
        send(to, NAMESPACE.media, { type: "GET_STATUS", requestId: ++requests });
      }, TIMING.poll);
      timers.push(poll);
      const command = (payload: object) => {
        if (media === mine && mine.id !== null) {
          send(to, NAMESPACE.media, { ...payload, mediaSessionId: mine.id, requestId: ++requests });
        }
      };
      return {
        play: () => command({ type: "PLAY" }),
        pause: () => command({ type: "PAUSE" }),
        seek: (seconds) => command({ type: "SEEK", currentTime: Math.max(0, seconds) }),
        async stop() {
          if (media !== mine) return;
          media = null;
          clearInterval(poll);
          if (mine.id === null || !open) return;
          await ask(
            to,
            NAMESPACE.media,
            { type: "STOP", mediaSessionId: mine.id },
            TIMING.close,
          ).catch(() => undefined);
        },
      };
    },
  };
}
