// The sound and subtitle tracks of an HLS stream, read from hls.js and chosen through it. The
// stream's multivariant playlist declares its sound renditions, its subtitle renditions (WebVTT,
// or IMSC, which hls.js reads too) and its caption channels; hls.js also finds captions (CEA-608)
// in the picture of a stream that declares none. Subtitles the stream carries any other way, such
// as DVB subtitles or teletext inside its segments, aren't read.
//
// hls.js numbers renditions by their place in the group the playing variant uses, and numbers
// them again when it moves to a variant with another group. Here a rendition's id is worked out
// from what the playlist declares about it, so the viewer's choice stays the same track through
// such a move, and when the channel opens again, in whatever order that stream lists them.
// Captions the viewer chose are listed from the start of such a stream, though its picture tells
// of them only at their first line.
//
// Cues prove subtitle availability while Off, through bounded discovery. Subtitles show only
// when the viewer's choice says so. hls.js would turn on the ones a stream
// marks as its default, so whatever it selects by itself is put back to what was asked for. Its
// lines come as events, not on text tracks of its own: the player puts them on the element's
// subtitle track, which carries the viewer's timing and look.
//
// A rendition is loaded once hls.js has read a segment of it, which it says for every segment,
// lines or none. Waiting for a first line instead would never end on the renditions broadcasters
// keep up without subtitling anything: their segments are a WebVTT header and nothing more.
import Hls, { type ErrorData, type MediaPlaylist } from "hls.js";
import type { ChannelTracks, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { renditionAudio, renditionSubtitles } from "@mrstreamer/core/ondemand/tracks";
import type { Cue } from "@mrstreamer/core/subtitles/webvtt";

/** The id caption channels share among the subtitle tracks, their `page` apart: no rendition's. */
const CAPTIONS_ID = -1;
/** Lines that ended this long ago are let go. */
const KEEP_BEHIND_S = 5;
/** Discovery borrows the subtitle controller for one segment at a time. */
const PROBES_PER_BURST = 3;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_REST_MS = 30_000;

/** The sound a stream starts with, as `playback.open` takes it for the streams it serves. */
export interface SoundChoice {
  /** The sound track chosen on this channel before, by id, or null for none. */
  readonly audio: number | null;
  /** Without one, the sound in this language where the stream has it: "nl". */
  readonly audioLanguage: string | null;
}

/** A stream's tracks where the engine itself reads and switches them. */
export interface EngineTracks {
  /**
   * Hears the stream's tracks and which sound plays: once its playlist has said, and again
   * whenever the stream lists others, turns out to carry captions, or plays another sound.
   */
  onChange(listener: (tracks: ChannelTracks) => void): void;
  /** Plays another sound track, by id, where the stream is: it doesn't start again. */
  setAudio(id: number): void;
  /**
   * Chooses the subtitles whose lines `onLine` hears, or none. Lines read before that are yet to
   * end come at once: hls.js reads ahead of the picture, and each line only once. Captions are
   * listed from then on, whether or not the picture told of them yet.
   */
  setSubtitle(track: SubtitleTrack | null): void;
  /** Hears each line of the chosen subtitles, timed on the element's clock. */
  onLine(listener: (line: Cue) => void): void;
  /**
   * Hears that the chosen subtitles are loaded where the stream plays, whatever they say there:
   * at once when chosen, for captions, which come with the picture, and for a rendition hls.js
   * read that far before; else once it has read a segment of that rendition, and with each one
   * after. A segment without a line counts. One that can't be had or read doesn't.
   */
  onSubtitleLoaded(listener: () => void): void;
  /** The chosen rendition could not be read. The picture continues with subtitles off. */
  onSubtitleUnavailable(listener: (track: SubtitleTrack) => void): void;
  /**
   * Observes actual cues, including while CC is off. Discovery uses this engine's subtitle
   * controller only, at most three single-segment probes per burst, thirty seconds apart.
   * A selected rendition always keeps the controller; discovery resumes when it is off again.
   */
  onSubtitleAvailable(
    listener: (track: SubtitleTrack) => void,
    language?: string | null,
    known?: readonly SubtitleTrack[],
  ): void;
}

/**
 * Reads `hls`'s tracks for the stream it plays in `video`, starting with `sound`. `release` stops
 * it from telling anything more, for when the stream goes.
 */
export function hlsTracks(hls: Hls, video: HTMLVideoElement, sound: SoundChoice) {
  /** Caption channels (1 to 4) with what the playlist declares about each, or null for nothing. */
  const captions = new Map<number, MediaPlaylist | null>();
  /** The lines read and yet to end, by track, each once. */
  const lines = new Map<string, Map<string, Cue>>();
  /** Where the last segment hls.js read of each subtitle rendition ends, by the rendition's id. */
  const readUntil = new Map<number, number>();
  /** The subtitles asked for, which hls.js doesn't get to change. */
  let wanted: SubtitleTrack | null = null;
  /** Set once the playlist said which renditions the playing variant has. */
  let ready = false;
  let released = false;
  let told = "";
  let changeListener: ((tracks: ChannelTracks) => void) | null = null;
  let lineListener: ((line: Cue) => void) | null = null;
  let loadedListener: (() => void) | null = null;
  let availableListener: ((track: SubtitleTrack) => void) | null = null;
  let unavailableListener: ((track: SubtitleTrack) => void) | null = null;
  /** Failed renditions are not sampled again during this stream. A viewer may retry a pick. */
  const failed = new Set<number>();
  const proven = new Set<string>();
  const triedAt = new Map<number, number>();
  let preferredLanguage: string | null = null;
  let probing: number | null = null;
  let probesInBurst = 0;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let nextProbe: ReturnType<typeof setTimeout> | null = null;
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;

  /** The tracks as the viewer chooses them, in hls.js's order, captions last. */
  function listed(): ChannelTracks {
    const ids = renditionIds(hls.audioTracks);
    const subtitles = renditionIds(hls.subtitleTracks);
    return {
      audio: renditionAudio(hls.audioTracks.map((track, at) => facts(track, ids[at] ?? at))),
      subtitles: renditionSubtitles([
        ...hls.subtitleTracks.map((track, at) => ({
          ...facts(track, subtitles[at] ?? at),
          page: null,
          format: "text" as const,
        })),
        ...[...captions]
          .toSorted(([a], [b]) => a - b)
          .map(([channel, declared]) => ({
            ...facts(declared, CAPTIONS_ID),
            page: channel,
            format: "captions" as const,
          })),
      ]),
      playing: ids[hls.audioTrack] ?? null,
    };
  }

  /** Tells the player the tracks, when they aren't the ones it was told last. */
  function tell(): void {
    if (released || !ready) return;
    const tracks = listed();
    const next = JSON.stringify(tracks);
    if (next === told) return;
    told = next;
    changeListener?.(tracks);
  }

  /** Where the wanted subtitles are in hls.js's list now, or -1 for none or captions. */
  const wantedIndex = () =>
    wanted?.format === "text" ? renditionIds(hls.subtitleTracks).indexOf(wanted.id) : -1;

  /** Loads the viewer's choice, or the one bounded probe while that choice is off. */
  function assert(): void {
    if (released) return;
    const index =
      wanted?.format === "text"
        ? wantedIndex()
        : probing === null
          ? -1
          : renditionIds(hls.subtitleTracks).indexOf(probing);
    if (hls.subtitleTrack !== index) hls.subtitleTrack = index;
  }

  /** The key `lines` keeps a track's lines under. */
  const keyOf = (track: Pick<SubtitleTrack, "id" | "page">) => `${track.id}:${track.page}`;

  /** Cancels an in-progress probe without changing the viewer's choice. */
  function stopProbe(): void {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    probing = null;
    assert();
  }

  function finishProbe(): void {
    stopProbe();
    if (released || nextProbe) return;
    const delay = probesInBurst >= PROBES_PER_BURST ? PROBE_REST_MS : 0;
    nextProbe = setTimeout(() => {
      nextProbe = null;
      if (delay > 0) probesInBurst = 0;
      discover();
    }, delay);
  }

  /** Reads one segment through hls.js, which owns its fetching, decryption and cue parser. */
  function discover(): void {
    if (
      released ||
      !ready ||
      !availableListener ||
      probing !== null ||
      nextProbe ||
      wanted?.format === "text"
    )
      return;
    if (probesInBurst >= PROBES_PER_BURST) {
      finishProbe();
      return;
    }
    const candidates = listed().subtitles.filter(
      (track) => track.format === "text" && !proven.has(keyOf(track)) && !failed.has(track.id),
    );
    candidates.sort(
      (a, b) =>
        (triedAt.get(a.id) ?? 0) - (triedAt.get(b.id) ?? 0) ||
        Number(b.language === preferredLanguage) - Number(a.language === preferredLanguage),
    );
    const track = candidates[0];
    if (!track) return;
    probing = track.id;
    triedAt.set(track.id, Date.now());
    probesInBurst++;
    // A playlist or segment that stalls cannot hold discovery or fetch indefinitely.
    probeTimer = setTimeout(() => abandon(track.id), PROBE_TIMEOUT_MS);
    assert();
  }

  /** Drops only the failed rendition. stopLoad cancels even its pending playlist request. */
  function abandon(id: number): void {
    if (released) return;
    failed.add(id);
    const selected = wanted?.format === "text" && wanted.id === id ? wanted : null;
    if (selected) {
      wanted = null;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    if (probing === id) finishProbe();
    assert();
    // hls.js's error controller runs first and may already have stopped every loader. Restart
    // after the subtitle choice is cleared, so its fatal escalation cannot stop good video.
    hls.stopLoad();
    hls.startLoad(-1);
    if (selected) unavailableListener?.(selected);
    discover();
  }

  /** Handles subtitle errors after hls.js's controllers, before the engine's fatal handler. */
  function subtitleError(data: ErrorData): boolean {
    if (released) return false;
    const subtitle =
      data.context?.type === "subtitleTrack" ||
      data.frag?.type === "subtitle" ||
      data.parent === "subtitle" ||
      data.details === Hls.ErrorDetails.SUBTITLE_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.SUBTITLE_TRACK_LOAD_TIMEOUT;
    if (!subtitle || data.details === Hls.ErrorDetails.FRAG_GAP) return false;
    const index = data.frag?.level ?? data.context?.id;
    const id = index == null ? undefined : renditionIds(hls.subtitleTracks)[index];
    if (id !== undefined) abandon(id);
    else if (data.fatal) {
      hls.startLoad(-1);
    }
    return true;
  }

  function prove(key: string): void {
    if (proven.has(key)) return;
    const track = listed().subtitles.find((each) => keyOf(each) === key);
    if (!track) return;
    proven.add(key);
    availableListener?.(track);
  }

  /** Keeps `line` of the track under `key`, and passes it on when that track is the wanted one. */
  function read(key: string, line: Cue): void {
    prove(key);
    const kept = lines.get(key) ?? new Map<string, Cue>();
    lines.set(key, kept);
    // A line that spans two segments comes with each.
    const id = `${line.start}|${line.end}|${line.text}`;
    if (kept.has(id)) return;
    kept.set(id, line);
    if (wanted && keyOf(wanted) === key) lineListener?.(line);
  }

  /** Lets go of the lines that ended a while ago, on every track. */
  function forgetOld(): void {
    const before = video.currentTime - KEEP_BEHIND_S;
    for (const kept of lines.values()) {
      for (const [id, line] of kept) if (line.end < before) kept.delete(id);
    }
  }

  hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
    for (const declared of data.captions ?? []) {
      const channel = /^CC([1-4])$/.exec(declared.instreamId ?? "")?.[1];
      if (channel) captions.set(Number(channel), declared);
    }
  });
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    // hls.js picks the stream's default sound right after this, unless one is picked by then.
    if (released || ready) return;
    const { audio } = listed();
    const chosen = audio.findIndex((track) => track.id === sound.audio);
    const spoken = audio.findIndex(
      (track) => sound.audioLanguage !== null && track.language === sound.audioLanguage,
    );
    const start = chosen !== -1 ? chosen : spoken;
    if (start !== -1) hls.audioTrack = start;
  });
  // hls.js's own handlers ran before these: the renditions are those of the variant it goes to.
  for (const event of [Hls.Events.LEVEL_SWITCHING, Hls.Events.LEVEL_LOADING] as const) {
    hls.on(event, () => {
      ready = true;
      assert();
      tell();
      if (probing !== null && !renditionIds(hls.subtitleTracks).includes(probing)) stopProbe();
      discover();
    });
  }
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHING, tell);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, tell);
  hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, assert);
  // Captions the picture turned out to carry: hls.js says so at the first line of each channel.
  // One listed only for the viewer's choice gets what the playlist declares about it here.
  hls.on(Hls.Events.NON_NATIVE_TEXT_TRACKS_FOUND, (_event, data) => {
    for (const track of data.tracks) {
      const channel = captionChannel(track._id);
      if (channel !== null && !captions.get(channel)) {
        captions.set(channel, track.closedCaptions ?? null);
      }
    }
    tell();
  });
  hls.on(Hls.Events.CUES_PARSED, (_event, data) => {
    if (released) return;
    forgetOld();
    const cues = cuesOf(data.cues);
    if (data.type === "captions") {
      const channel = captionChannel(data.track);
      const [first] = cues;
      if (channel === null || !first) return;
      // One cue for each row of the screen, top to bottom: together they are one line.
      read(keyOf({ id: CAPTIONS_ID, page: channel }), {
        start: Math.min(...cues.map((cue) => cue.start)),
        end: Math.max(...cues.map((cue) => cue.end)),
        text: cues.map((cue) => cue.text).join("\n"),
      });
      return;
    }
    const at = data.subtitleTrack ? hls.subtitleTracks.indexOf(data.subtitleTrack) : -1;
    const id = renditionIds(hls.subtitleTracks)[at];
    if (id === undefined) return;
    for (const cue of cues) read(keyOf({ id, page: null }), cue);
  });
  // Told after a segment's lines, and alone for a segment without any. The segment's `level` is
  // its rendition's place in the list, which hls.js loaded its playlist by: a segment asked for
  // before the viewer chose other subtitles is told with the rendition it belongs to.
  hls.on(Hls.Events.SUBTITLE_FRAG_PROCESSED, (_event, data) => {
    if (released) return;
    const id = renditionIds(hls.subtitleTracks)[data.frag.level];
    if (id === undefined) return;
    if (probing === id) finishProbe();
    if (!data.success) {
      abandon(id);
      return;
    }
    if (wanted?.id === id && selectionTimer) {
      clearTimeout(selectionTimer);
      selectionTimer = null;
    }
    const { start, duration } = data.part ?? data.frag;
    readUntil.set(id, Math.max(readUntil.get(id) ?? 0, start + duration));
    if (wanted?.id === id) loadedListener?.();
  });

  const handle: EngineTracks = {
    onChange(listener) {
      changeListener = listener;
    },
    setAudio(id) {
      const index = renditionIds(hls.audioTracks).indexOf(id);
      if (!released && index !== -1) hls.audioTrack = index;
    },
    setSubtitle(track) {
      if (released) return;
      // Switching away must cancel a pending playlist too, which setting subtitleTrack alone
      // does not abort in hls.js. Video loading resumes with the new choice below.
      const cancelLoading =
        selectionTimer !== null || (probing !== null && track?.format === "text");
      if (cancelLoading) hls.stopLoad();
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
      wanted = track;
      if (track?.format === "text" && (readUntil.get(track.id) ?? 0) <= video.currentTime) {
        selectionTimer = setTimeout(() => abandon(track.id), PROBE_TIMEOUT_MS);
      }
      if (track?.format === "text") stopProbe();
      // Captions chosen before this stream's picture told of them, as when the channel opens
      // again with them: listed all the same, or the player would take the choice for gone.
      if (track?.id === CAPTIONS_ID && track.page !== null && !captions.has(track.page)) {
        captions.set(track.page, null);
        tell();
      }
      assert();
      if (cancelLoading) hls.startLoad(-1);
      discover();
      if (!track || released) return;
      for (const line of lines.get(keyOf(track))?.values() ?? []) {
        if (line.end > video.currentTime) lineListener?.(line);
      }
      // Captions are read from the picture, so the stream has none left to load for them.
      const read = track.format === "text" ? (readUntil.get(track.id) ?? 0) : Infinity;
      if (read > video.currentTime) loadedListener?.();
    },
    onLine(listener) {
      lineListener = listener;
    },
    onSubtitleLoaded(listener) {
      loadedListener = listener;
    },
    onSubtitleUnavailable(listener) {
      unavailableListener = listener;
    },
    onSubtitleAvailable(listener, language, known) {
      availableListener = listener;
      preferredLanguage = language ?? null;
      for (const track of known ?? []) proven.add(keyOf(track));
      for (const track of listed().subtitles) {
        if (proven.has(keyOf(track))) listener(track);
      }
      discover();
    },
  };

  return {
    handle,
    subtitleError,
    release(): void {
      released = true;
      if (probeTimer) clearTimeout(probeTimer);
      if (nextProbe) clearTimeout(nextProbe);
      if (selectionTimer) clearTimeout(selectionTimer);
      unavailableListener = null;
      probeTimer = nextProbe = null;
      availableListener = null;
      changeListener = null;
      lineListener = null;
      loadedListener = null;
      lines.clear();
    },
  };
}

/**
 * Numbers renditions by what they are: the name, language and marks that hls.js itself matches
 * a rendition by when it looks one up in another group. A rendition's number is worked out from
 * those alone, so its counterpart has the same one in another group, and in another stream of the
 * channel, in whatever order either lists them; two that read the same are told apart by their
 * order.
 */
function renditionIds(renditions: readonly MediaPlaylist[]): number[] {
  const seen = new Map<string, number>();
  return renditions.map((rendition) => {
    const { name, lang = "", assocLang = "", characteristics = "", forced } = rendition;
    const identity = JSON.stringify([name, lang, assocLang, characteristics, forced]);
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    return hashed(`${identity}#${nth}`);
  });
}

/**
 * A stable unsigned 32-bit rendition id using FNV-1a, separate from `CAPTIONS_ID`.
 */
function hashed(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  }
  return hash >>> 0;
}

/** What the playlist declares about a rendition, or about a caption channel if anything. */
function facts(rendition: MediaPlaylist | null, id: number) {
  const marks = rendition?.characteristics ?? "";
  return {
    id,
    name: rendition?.name ?? null,
    language: rendition?.lang ?? null,
    default: rendition?.default ?? false,
    forced: rendition?.forced ?? false,
    accessible: /describes-(video|music-and-sound)|transcribes-spoken-dialog/.test(marks),
  };
}

/** The caption channel hls.js names "textTrack1" to "textTrack4", or null for anything else. */
function captionChannel(name: string | undefined): number | null {
  const channel = /^textTrack([1-4])$/.exec(name ?? "")?.[1];
  return channel ? Number(channel) : null;
}

/** The cues hls.js parsed, which it types loosely, as lines; whatever isn't a cue is left out. */
function cuesOf(parsed: unknown): Cue[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((cue: unknown): Cue[] => {
    if (typeof cue !== "object" || cue === null) return [];
    if (!("startTime" in cue) || !("endTime" in cue) || !("text" in cue)) return [];
    const { startTime: start, endTime: end, text } = cue;
    return typeof start === "number" && typeof end === "number" && typeof text === "string" && text
      ? [{ start, end, text }]
      : [];
  });
}
