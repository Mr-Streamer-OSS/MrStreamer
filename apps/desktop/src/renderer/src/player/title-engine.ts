// Movies and episodes through Media Source Extensions. One run plays the title from a position
// with the chosen tracks, as the proxy sends it (see src/main/playback/title.ts): fragmented MP4
// whose `x-start` header says where its picture begins. Placing the fragments there makes the
// element's clock the title's clock, so the position is `currentTime`, a seek into what is
// already buffered is instant, and subtitle cues line up without arithmetic in the view.
//
// Reading holds back once enough is buffered ahead. While paused nothing more is read, and the
// provider's connection sits idle until playback moves on; the controller ends the run after a
// long pause.
import { subtitleDecoder, type SubtitleCodec } from "@mrstreamer/core/subtitles/decoder";
import type { EngineError, StreamInfo } from "./engine.ts";
import { readMp4Start } from "./mp4.ts";
import { addTextCue, clearSubtitles, subtitlePresenter, subtitleTrack } from "./subtitles.ts";
import { webvttReader } from "./webvtt.ts";

/** Stop reading once this much is buffered ahead, and read again below the second value. */
const AHEAD_S = { stop: 60, resume: 40 } as const;
/** No picture within this long counts as a failed start. */
const START_TIMEOUT_MS = 30_000;
/** How long a run may send nothing at all. */
const NOTHING_TIMEOUT_MS = 45_000;
/** A clock that stands still this long while playing, with nothing buffered, counts as broken. */
const STALL_TIMEOUT_MS = 20_000;
/** The start of a run is read into memory until its codecs are known; more is not a movie. */
const HEAD_LIMIT = 16 * 1024 * 1024;

export interface TitleRun {
  /** The session's address; the run adds its position and tracks. */
  readonly url: string;
  readonly start: number;
  readonly audio: number | null;
  readonly subtitle: number | null;
  /** The teletext page or caption channel to show, for a track that holds several. */
  readonly page: number | null;
  /** Converts the sound even when the player decodes it: the second try after a failed start. */
  readonly convertSound: boolean;
  /**
   * Shows the first picture and waits, as when the viewer changes tracks or skips while paused;
   * otherwise it plays.
   */
  readonly paused: boolean;
  /** Seconds, so the element's timeline covers the whole title. */
  readonly duration: number | null;
}

export interface TitleEngine {
  /** Resolves once the picture moves. Rejects with an `EngineError`. */
  readonly started: Promise<void>;
  /** Called at most once, when playback breaks after it started. */
  onFailure(listener: (error: EngineError) => void): void;
  /** Called when the title plays to its end. */
  onEnded(listener: () => void): void;
  /** Seconds into the title. */
  position(): number;
  /** Moves within what is already here; false when the caller must start a run from there. */
  seekWithin(position: number): boolean;
  /**
   * Takes the subtitles off for the rest of the run: what shows goes, and the run's cues and
   * packets stop being read. Showing subtitles again takes a new run.
   */
  hideSubtitles(): void;
  info(): StreamInfo;
  /** Stops reading, ends the run's connection and frees the element. */
  destroy(): void;
}

export function titleEngine(video: HTMLVideoElement, run: TitleRun): TitleEngine {
  const abort = new AbortController();
  /** Ends the subtitles with the run, or before it, when the viewer turns them off. */
  const subtitlesOff = new AbortController();
  const subtitlesSignal = AbortSignal.any([abort.signal, subtitlesOff.signal]);
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const subtitles = subtitleTrack(video);
  clearSubtitles(video);
  subtitles.mode = run.subtitle === null ? "disabled" : "showing";
  let buffer: SourceBuffer | null = null;
  let codecs: string | null = null;
  let settled = false;
  let finished = false;
  let failureListener: ((error: EngineError) => void) | null = null;
  let pendingFailure: EngineError | null = null;
  let endedListener: (() => void) | null = null;
  const { promise: started, resolve, reject } = Promise.withResolvers<void>();
  started.catch(() => {});

  const fail = (error: EngineError) => {
    if (finished) return;
    finished = true;
    stopWatching();
    if (!settled) {
      settled = true;
      reject(error);
    } else if (failureListener) failureListener(error);
    else pendingFailure = error;
  };

  // Started once the clock moves on from where the run placed it.
  let from: number | null = null;
  let lastTime = 0;
  let lastProgressAt = Date.now();
  const openedAt = Date.now();
  const watchdog = setInterval(() => {
    const now = Date.now();
    // Nothing to show yet, paused or not: the provider answered and then stalled. Later than
    // the proxy's own wait for a run's start, whose answer says more.
    if (from === null && now - openedAt > NOTHING_TIMEOUT_MS) {
      fail({ kind: "network", detail: `No picture within ${NOTHING_TIMEOUT_MS / 1000} s.` });
      return;
    }
    if (video.paused || video.seeking || video.currentTime > lastTime + 0.05) {
      lastTime = video.currentTime;
      lastProgressAt = now;
      return;
    }
    if (!settled && now - openedAt > START_TIMEOUT_MS) {
      fail({ kind: "network", detail: `No picture within ${START_TIMEOUT_MS / 1000} s.` });
    } else if (settled && now - lastProgressAt > STALL_TIMEOUT_MS && ahead() < 1) {
      fail({ kind: "network", detail: "The title stopped arriving." });
    }
  }, 1000);
  const onError = () => {
    const error = video.error;
    fail({
      kind: error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "unsupported" : "media",
      detail: error?.message || "The title could not be decoded.",
    });
  };
  const onEnded = () => endedListener?.();
  // The clock moving on from where the run placed it is the start, as soon as it happens.
  const onTime = () => {
    if (from !== null && !settled && video.currentTime >= from + 0.1) {
      settled = true;
      resolve();
    }
  };
  video.addEventListener("error", onError);
  video.addEventListener("ended", onEnded);
  video.addEventListener("timeupdate", onTime);
  function stopWatching() {
    clearInterval(watchdog);
    video.removeEventListener("error", onError);
    video.removeEventListener("ended", onEnded);
    video.removeEventListener("timeupdate", onTime);
  }

  /** Seconds buffered beyond the position. */
  function ahead(): number {
    const ranges = video.buffered;
    for (let index = 0; index < ranges.length; index++) {
      if (
        ranges.start(index) <= video.currentTime + 0.5 &&
        ranges.end(index) >= video.currentTime
      ) {
        return ranges.end(index) - video.currentTime;
      }
    }
    return 0;
  }

  /** Resolves once the element has room to buffer more. */
  const room = () =>
    new Promise<void>((done) => {
      if (ahead() < AHEAD_S.stop) return done();
      const check = () => {
        if (abort.signal.aborted || ahead() < AHEAD_S.resume) {
          video.removeEventListener("timeupdate", check);
          video.removeEventListener("seeking", check);
          done();
        }
      };
      video.addEventListener("timeupdate", check);
      video.addEventListener("seeking", check);
      abort.signal.addEventListener("abort", check, { once: true });
    });

  const updated = (target: SourceBuffer) =>
    new Promise<void>((done, failed) => {
      target.addEventListener("updateend", () => done(), { once: true });
      target.addEventListener("error", () => failed(new Error("The player refused the title.")), {
        once: true,
      });
    });

  /** Appends a piece, making room behind the position when the element is full. */
  async function append(target: SourceBuffer, data: Uint8Array): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        target.appendBuffer(data as Uint8Array<ArrayBuffer>);
        await updated(target);
        return;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError") || tries > 3) {
          throw error;
        }
        const behind = video.currentTime - 20;
        if (behind > 0) {
          target.remove(0, behind);
          await updated(target);
        } else {
          await room();
        }
      }
    }
  }

  async function play(): Promise<void> {
    await new Promise((opened) =>
      mediaSource.addEventListener("sourceopen", opened, { once: true }),
    );
    const query = new URLSearchParams({ start: run.start.toFixed(3) });
    if (run.audio !== null) query.set("audio", String(run.audio));
    if (run.subtitle !== null) query.set("subtitle", String(run.subtitle));
    if (run.convertSound) query.set("sound", "convert");
    const response = await fetch(`${run.url}?${query}`, { signal: abort.signal });
    if (!response.ok || !response.body) {
      throw {
        kind: response.status === 415 ? "unsupported" : "network",
        detail: `The title answered HTTP ${response.status}.`,
      } satisfies EngineError;
    }
    const pictureStart = Number(response.headers.get("x-start")) || 0;
    const origin = Number(response.headers.get("x-origin")) || 0;
    const cues = response.headers.get("x-cues");
    if (cues) void readCues(cues, origin);
    const packets = response.headers.get("x-packets");
    const codec = response.headers.get("x-packets-codec");
    if (packets && isCodec(codec)) void readPackets(packets, codec, origin);

    const reader = response.body.getReader();
    abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
      once: true,
    });
    // The start is held until the tracks and the first fragment are known.
    let head = new Uint8Array(0);
    let start = readMp4Start(head);
    while (start.codecs === null || start.firstFragment === null) {
      const { value, done } = await reader.read();
      if (done || head.length > HEAD_LIMIT) {
        throw {
          kind: "unsupported",
          detail: "The title didn't start like a video.",
        } satisfies EngineError;
      }
      const joined = new Uint8Array(head.length + value.length);
      joined.set(head);
      joined.set(value, head.length);
      head = joined;
      start = readMp4Start(head);
    }
    codecs = start.codecs;
    const type = `video/mp4; codecs="${start.codecs}"`;
    if (!MediaSource.isTypeSupported(type)) {
      throw {
        kind: "unsupported",
        detail: `This system can't play ${start.codecs}.`,
      } satisfies EngineError;
    }
    if (run.duration) mediaSource.duration = run.duration;
    buffer = mediaSource.addSourceBuffer(type);
    buffer.timestampOffset = pictureStart - start.firstFragment;
    await append(buffer, head);
    // The picture decodes from the keyframe before the start and shows from the start itself,
    // unless the file only allowed a later one.
    from = Math.max(run.start, buffer.buffered.length > 0 ? buffer.buffered.start(0) : run.start);
    video.currentTime = from;
    lastTime = from;
    if (run.paused) {
      // Paused, the clock doesn't move: the run has started once the picture is there.
      void new Promise((ready) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking) ready(null);
        else video.addEventListener("seeked", ready, { once: true });
      }).then(() => {
        if (!settled && !finished) {
          settled = true;
          resolve();
        }
      });
    } else {
      void video.play().catch(() => {});
    }
    for (;;) {
      await room();
      if (abort.signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      await append(buffer, value);
    }
    if (mediaSource.readyState === "open" && !buffer.updating) mediaSource.endOfStream();
  }

  /** Streams the run's cues into the element's subtitle track, on the title's clock. */
  async function readCues(url: string, origin: number): Promise<void> {
    try {
      const response = await fetch(url, { signal: subtitlesSignal });
      if (!response.body) return;
      const reader = webvttReader();
      const decoder = new TextDecoder();
      const add = (cues: ReturnType<typeof reader.push>) => {
        // The track is shared with the next run, which may have started already.
        if (subtitlesSignal.aborted) return;
        for (const cue of cues) addTextCue(video, cue.start - origin, cue.end - origin, cue.text);
      };
      for await (const chunk of response.body)
        add(reader.push(decoder.decode(chunk, { stream: true })));
      add(reader.end());
    } catch {
      // Stopped with the run, or the cues broke off: the picture carries on without them.
    }
  }

  /**
   * Streams the run's subtitle packets, a JSON line each, through the decoder for their codec,
   * and shows what they draw on the title's clock.
   */
  async function readPackets(url: string, codec: SubtitleCodec, origin: number): Promise<void> {
    try {
      const response = await fetch(url, { signal: subtitlesSignal });
      if (!response.body) return;
      const decoder = subtitleDecoder(codec, run.page);
      const presenter = subtitlePresenter(video, origin);
      const text = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body) {
        pending += text.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line || subtitlesSignal.aborted) continue;
          const packet = JSON.parse(line) as { at: number; data: string };
          const data = Uint8Array.from(atob(packet.data), (char) => char.charCodeAt(0));
          const change = decoder.push(data, packet.at);
          if (change) presenter.show(change);
        }
      }
    } catch {
      // Stopped with the run, or the packets broke off: the picture carries on without them.
    }
  }

  video.src = objectUrl;
  play().catch((error: unknown) => {
    if (abort.signal.aborted) return;
    fail(
      typeof error === "object" && error !== null && "kind" in error && "detail" in error
        ? (error as EngineError)
        : { kind: "network", detail: error instanceof Error ? error.message : String(error) },
    );
  });

  return {
    started,
    onFailure(listener) {
      failureListener = listener;
      if (pendingFailure) {
        listener(pendingFailure);
        pendingFailure = null;
      }
    },
    onEnded(listener) {
      endedListener = listener;
    },
    position: () => video.currentTime,
    seekWithin(position) {
      const ranges = buffer?.buffered;
      if (!ranges) return false;
      for (let index = 0; index < ranges.length; index++) {
        if (position >= ranges.start(index) && position < ranges.end(index) - 0.5) {
          video.currentTime = position;
          return true;
        }
      }
      return false;
    },
    hideSubtitles() {
      subtitlesOff.abort();
      clearSubtitles(video);
      subtitles.mode = "disabled";
    },
    info: () => ({
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      fps: null,
      videoCodec: codecs?.split(",")[0] ?? null,
      audioCodec: codecs?.split(",")[1] ?? null,
      audioChannels: null,
    }),
    destroy() {
      if (abort.signal.aborted) return;
      finished = true;
      stopWatching();
      abort.abort();
      if (!settled) reject({ kind: "network", detail: "Stopped." } satisfies EngineError);
      clearSubtitles(video);
      subtitles.mode = "disabled";
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

const CODECS: readonly SubtitleCodec[] = ["pgs", "dvb", "teletext", "captions"];

function isCodec(value: string | null): value is SubtitleCodec {
  return CODECS.some((codec) => codec === value);
}
