// Playback engines behind one interface, so the rest of the UI only ever talks to `Engine`. The
// main process delivers each stream in codecs these engines decode; see src/main/playback.
import Hls from "hls.js";
import mpegts from "mpegts.js";
import type { StreamFormat } from "@mrstreamer/contracts/playback";

/** The picture may run this far behind the newest data before it jumps forward. */
const LIVE_MAX_LATENCY_S = 8;
/** How much buffer a jump forward keeps, against the next network hiccup. */
const LIVE_KEEP_BUFFER_S = 3;
/** No picture or sound within this long counts as a failed start. */
const START_TIMEOUT_MS = 20_000;
/** A clock that stands still this long after playback started counts as a broken stream. */
const STALL_TIMEOUT_MS = 15_000;
/** This much buffered media without the clock starting means the stream cannot be decoded. */
const UNPLAYABLE_BUFFER_S = 4;
/**
 * A clock that stands still this long while that much media waits beyond it means the stream's
 * timing is broken, as with frames that lack timestamps: data arrives but cannot be played.
 */
const BROKEN_TIMING_STALL_MS = 4000;

export type EngineName = "mpegts.js" | "hls.js" | "native";

export interface EngineError {
  /**
   * `network`: data stopped arriving. `media`: decoding failed. `unsupported`: a codec the engine
   * cannot play. `wrong-container`: not the format this engine reads at all, so another engine may.
   */
  readonly kind: "network" | "media" | "unsupported" | "wrong-container";
  readonly detail: string;
}

export function isEngineError(value: unknown): value is EngineError {
  return typeof value === "object" && value !== null && "kind" in value && "detail" in value;
}

/** What is known about the playing stream. Fields are null when the engine cannot tell. */
export interface StreamInfo {
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly audioChannels: number | null;
}

/** One stream playing in a video element. Create one per stream. */
export interface Engine {
  readonly name: EngineName;
  /** Resolves when the first frame (or for radio, the first audio) plays. Rejects with an `EngineError`. */
  readonly started: Promise<void>;
  /** Called at most once, when playback breaks after it started. */
  onFailure(listener: (error: EngineError) => void): void;
  /**
   * Hears each private data packet of the stream, as teletext, DVB subtitles and copied captions
   * travel, with its time on the element's clock in seconds. Only MPEG-TS streams have them.
   */
  onPrivateData(listener: (pid: number, data: Uint8Array, at: number) => void): void;
  info(): StreamInfo;
  /** Stops playback, closes the connection and frees the video element. */
  destroy(): void;
}

export function createEngine(format: StreamFormat, video: HTMLVideoElement, url: string): Engine {
  if (format === "mpegts") return mpegtsEngine(video, url);
  if (Hls.isSupported()) return hlsEngine(video, url);
  return nativeEngine(video, url);
}

function mpegtsEngine(video: HTMLVideoElement, url: string): Engine {
  if (!mpegts.getFeatureList().mseLivePlayback) {
    return failedEngine("mpegts.js", video, {
      kind: "unsupported",
      detail: "This system cannot play MPEG-TS live streams.",
    });
  }
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url },
    {
      enableWorker: true,
      lazyLoad: false,
      autoCleanupSourceBuffer: true,
      // Providers send a burst of buffered seconds when a stream opens, and a stall can leave the
      // picture behind live. Jump forward when that exceeds the maximum, keeping some buffer,
      // rather than play faster: a faster rate is audible and visible for half a minute.
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: LIVE_MAX_LATENCY_S,
      liveBufferLatencyMinRemain: LIVE_KEEP_BUFFER_S,
    },
  );
  const life = lifecycle(video, () => {
    player.pause();
    player.unload();
    player.detachMediaElement();
    player.destroy();
  });
  player.on(mpegts.Events.ERROR, (type: unknown, detail: unknown, info: unknown) => {
    life.fail(mpegtsError(type, detail, info));
  });
  player.on(mpegts.Events.LOADING_COMPLETE, () => {
    life.fail({ kind: "network", detail: "The provider ended the stream." });
  });
  let privateData: ((pid: number, data: Uint8Array, at: number) => void) | null = null;
  // mpegts.js times private data in milliseconds on the timeline it gives the element.
  player.on(mpegts.Events.PES_PRIVATE_DATA_ARRIVED, (packet: unknown) => {
    if (!privateData || typeof packet !== "object" || packet === null) return;
    const { pid, data, pts, nearest_pts } = packet as Record<string, unknown>;
    const at = typeof pts === "number" ? pts : nearest_pts;
    if (typeof pid === "number" && data instanceof Uint8Array && typeof at === "number") {
      privateData(pid, data, at / 1000);
    }
  });
  player.attachMediaElement(video);
  player.load();
  void Promise.resolve(player.play()).catch(() => {});

  return {
    name: "mpegts.js",
    ...life.handle,
    onPrivateData(listener) {
      privateData = listener;
    },
    info() {
      // createPlayer returns the base Player type; for MSE playback mediaInfo carries codec details.
      const media: mpegts.MSEPlayerMediaInfo = player.mediaInfo;
      return {
        ...elementInfo(video),
        fps: numberOr(media.fps),
        videoCodec: stringOr(media.videoCodec),
        audioCodec: stringOr(media.audioCodec),
        audioChannels: numberOr(media["audioChannelCount"]),
      };
    },
  };
}

function mpegtsError(type: unknown, detail: unknown, info: unknown): EngineError {
  const message =
    info && typeof info === "object" && "msg" in info && typeof info.msg === "string"
      ? info.msg
      : String(detail);
  if (type === mpegts.ErrorTypes.NETWORK_ERROR) return { kind: "network", detail: message };
  if (detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED)
    return { kind: "wrong-container", detail: message };
  if (detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED)
    return { kind: "unsupported", detail: message };
  return { kind: "media", detail: message };
}

function hlsEngine(video: HTMLVideoElement, url: string): Engine {
  // Watch offers no subtitles for HLS, so none show on their own: hls.js would turn on a
  // stream's default subtitles and its captions, with no way to turn them off.
  const hls = new Hls({ enableWorker: true, enableCEA708Captions: false });
  hls.subtitleDisplay = false;
  hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => {
    if (data.id !== -1) hls.subtitleTrack = -1;
  });
  const life = lifecycle(video, () => hls.destroy());
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR)
      return life.fail({ kind: "network", detail: data.details });
    const unsupported =
      data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
      data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR;
    life.fail({ kind: unsupported ? "unsupported" : "media", detail: data.details });
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  void video.play().catch(() => {});

  return {
    name: "hls.js",
    ...life.handle,
    onPrivateData: () => {},
    info() {
      const level = hls.levels[hls.currentLevel];
      return {
        ...elementInfo(video),
        fps: level?.frameRate || null,
        videoCodec: level?.videoCodec ?? null,
        audioCodec: level?.audioCodec ?? null,
        audioChannels: null,
      };
    },
  };
}

/** Chromium's own player. Plays progressive files and raw audio streams such as AAC radio. */
export function nativeEngine(video: HTMLVideoElement, url: string): Engine {
  const life = lifecycle(video, () => {});
  video.src = url;
  void video.play().catch(() => {});
  return {
    name: "native",
    ...life.handle,
    onPrivateData: () => {},
    info: () => elementInfo(video),
  };
}

function failedEngine(name: EngineName, video: HTMLVideoElement, error: EngineError): Engine {
  const life = lifecycle(video, () => {});
  life.fail(error);
  return { name, ...life.handle, onPrivateData: () => {}, info: () => elementInfo(video) };
}

/**
 * The start, stall and failure bookkeeping every engine shares. `teardown` releases the engine's
 * own resources; the video element is reset afterwards.
 *
 * A stream counts as started once its clock moves. A first frame alone is not enough: a decoder
 * that cannot handle the audio shows one frame and then freezes. A watchdog tells the cases apart:
 * data piling up without playback means the format is unplayable, no data means the network.
 */
function lifecycle(video: HTMLVideoElement, teardown: () => void) {
  let settled = false;
  let finished = false;
  let destroyed = false;
  let failureListener: ((error: EngineError) => void) | null = null;
  let pendingFailure: EngineError | null = null;

  const { promise: started, resolve, reject } = Promise.withResolvers<void>();
  started.catch(() => {});

  const openedAt = Date.now();
  let lastTime = video.currentTime;
  let lastProgressAt = openedAt;

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (video.currentTime > lastTime + 0.05) {
      if (!settled && video.currentTime - lastTime > 0.25) begin();
      lastTime = video.currentTime;
      lastProgressAt = now;
      return;
    }
    if (!settled) {
      if (bufferedAhead(video) >= UNPLAYABLE_BUFFER_S) {
        fail({
          kind: "unsupported",
          detail: "The stream arrives but its audio or video cannot be decoded.",
        });
      } else if (now - openedAt > START_TIMEOUT_MS) {
        fail({
          kind: "network",
          detail: `No picture or sound within ${START_TIMEOUT_MS / 1000} s.`,
        });
      }
    } else if (video.paused) {
      // Time paused isn't time stalled.
      lastProgressAt = now;
    } else {
      const stalled = now - lastProgressAt;
      if (stalled > BROKEN_TIMING_STALL_MS && bufferedAhead(video) >= UNPLAYABLE_BUFFER_S) {
        fail({ kind: "media", detail: "The stream arrives, but its timing is broken." });
      } else if (stalled > STALL_TIMEOUT_MS) {
        fail({ kind: "network", detail: "The stream stopped delivering data." });
      }
    }
  }, 1000);

  function begin(): void {
    if (settled || finished) return;
    settled = true;
    resolve();
  }

  function fail(error: EngineError): void {
    if (finished) return;
    finished = true;
    detach();
    if (!settled) {
      settled = true;
      reject(error);
    } else if (failureListener) {
      failureListener(error);
    } else {
      pendingFailure = error;
    }
  }

  const onError = () => {
    const error = video.error;
    const unsupported = error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
    fail({
      kind: unsupported ? "unsupported" : "media",
      detail: error?.message || "The stream could not be decoded.",
    });
  };
  video.addEventListener("error", onError);

  function detach(): void {
    clearInterval(watchdog);
    video.removeEventListener("error", onError);
  }

  return {
    fail,
    handle: {
      started,
      onFailure(listener: (error: EngineError) => void): void {
        failureListener = listener;
        if (pendingFailure) {
          listener(pendingFailure);
          pendingFailure = null;
        }
      },
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        finished = true;
        detach();
        if (!settled) reject({ kind: "network", detail: "Stopped." } satisfies EngineError);
        teardown();
        video.pause();
        video.removeAttribute("src");
        video.load();
      },
    },
  };
}

/** Seconds of media buffered beyond the current position. */
function bufferedAhead(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) - currentTime : 0;
}

/** What the video element itself knows: only the picture size. */
function elementInfo(video: HTMLVideoElement): StreamInfo {
  return {
    width: video.videoWidth || null,
    height: video.videoHeight || null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    audioChannels: null,
  };
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
