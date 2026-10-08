// Stands in for hls.js in the renderer's tests: happy-dom has no Media Source Extensions, so the
// real one plays nothing there. It loads and plays nothing either. It keeps what hls.js 1.7
// promises about a stream's tracks, as its track controllers do it:
//
// - A stream's renditions are those of the group the playing variant uses, numbered by their
//   place in it. Moving to a variant with another group numbers them again, tells of the new
//   lists, and then looks up the tracks that played among them.
// - The stream's default sound plays at first, else its first, unless a listener to the new list
//   sets another there and then. Setting one tells of the switch at once, and of its end a
//   moment later. Once one played, a group without its counterpart plays its first.
// - Until a subtitle track is set, the stream's default subtitles are selected. Selecting one, or
//   none after one, tells of the switch, and then loads the playlist of whichever rendition is
//   selected once the listeners have heard. A new list selects the counterpart of the one that
//   showed, and tells of that; without a counterpart none is selected, and nothing is told.
// - A subtitle rendition is read a segment at a time, from the one at the element's position on,
//   and from there again after a new list.
//   Each tells its lines once, even when it has none, and then that it was read, as a fragment
//   whose level is the rendition's place in the list. One that can't be read tells only that it
//   failed. A segment asked for before another rendition was selected still tells both when it
//   comes.
// - Caption lines are told for every channel the picture carries, each channel announced at its
//   first line.
//
// A test plays the stream's part through `streams.latest()`.
import type Hls from "hls.js";

/** A rendition as a multivariant playlist declares it. */
export interface Rendition {
  readonly name: string;
  readonly lang?: string;
  readonly default?: boolean;
  readonly forced?: boolean;
  readonly characteristics?: string;
  /** "CC1" for a caption channel. */
  readonly instreamId?: string;
}

/** A rendition with its place in the playing group, as hls.js numbers it. */
type Listed = Rendition & { default: boolean; forced: boolean; id: number };

type Listener = (event: string, data: unknown) => void;

/** How long a subtitle segment lasts. */
const SEGMENT_S = 6;

/** One stream the player opened, for the test to play its part. */
export interface Stream {
  readonly destroyed: boolean;
  readonly loading: boolean;
  /** Emits an error after the internal error controller may have stopped all loading. */
  error(
    target: "subtitle-playlist" | "subtitle-segment" | "video" | "audio",
    fatal?: boolean,
    of?: string,
  ): void;
  /** An internal subtitle-fragment abort caused by a choice change. */
  subtitleAborted(of: string): void;
  /** A parsed playlist supplies its segment cadence. */
  subtitlePlaylist(seconds: number): void;
  /** A parser may defer a fragment without an error, including after IMSC fallback. */
  subtitleDeferred(afterSuccess?: boolean): void;
  /** hls.js rejects queued VTT when its picture timestamp domain has not arrived. */
  subtitleDiscontinuityMismatch(): void;
  /** The place in its list of the sound track selected, or -1. */
  readonly audioTrack: number;
  /** The place in its list of the subtitle rendition selected, or -1 for none. */
  readonly subtitleTrack: number;
  /** The subtitle renditions whose playlists it loaded, by name, in order. */
  readonly subtitlesLoaded: readonly string[];
  /** The playlist loaded, declaring these caption channels. */
  manifest(captions: readonly Rendition[]): void;
  /** The stream goes to a variant whose groups have these renditions. */
  variant(groups: { audio?: readonly Rendition[]; subtitles?: readonly Rendition[] }): void;
  /**
   * The next segment of a subtitle rendition was read, with these lines or none: the selected
   * rendition's, or that of the one named `of`, as hls.js asked for it before another was picked.
   */
  subtitleLines(lines: readonly { start: number; end: number; text: string }[], of?: string): void;
  /** The next segment of the selected subtitle rendition came, and couldn't be read. */
  subtitleUnreadable(): void;
  /** A screen of captions was read on `channel`, a cue for each of its rows. */
  captionLines(channel: number, start: number, end: number, rows: readonly string[]): void;
}

const opened: Stream[] = [];

export const streams = {
  /** The stream the player opened last. */
  latest(): Stream {
    const stream = opened.at(-1);
    if (!stream) throw new Error("The player opened no HLS stream.");
    return stream;
  },
  /** How many streams the player opened so far. */
  count: (): number => opened.length,
};

/** The stand-in, with the real one's event and error names. */
export function standIn(real: typeof Hls) {
  const { Events } = real;
  return class StandIn implements Stream {
    static isSupported = () => true;
    static Events = Events;
    static ErrorTypes = real.ErrorTypes;
    static ErrorDetails = real.ErrorDetails;

    destroyed = false;
    loading = true;
    levels: never[] = [];
    currentLevel = -1;
    audioTracks: Listed[] = [];
    subtitleTracks: Listed[] = [];
    subtitlesLoaded: string[] = [];
    #audio = -1;
    #subtitle = -1;
    /** Cleared once a sound track played: the stream's default is no longer looked for. */
    #defaultSound = true;
    /** Cleared once a subtitle track is set: the stream's default no longer comes on. */
    #defaultSubtitles = true;
    #announced = new Set<number>();
    #listeners = new Map<string, Listener[]>();
    #media: HTMLMediaElement | null = null;
    /** Where the last segment read of each subtitle rendition ends, by its place in the list. */
    #readUntil = new Map<number, number>();

    constructor() {
      opened.push(this);
    }

    on(event: string, listener: Listener): void {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    }

    #tell(event: string, data: unknown = {}): void {
      for (const listener of this.#listeners.get(event) ?? []) listener(event, data);
    }

    loadSource(): void {}
    stopLoad(): void {
      this.loading = false;
    }
    startLoad(): void {
      this.loading = true;
    }
    error(
      target: "subtitle-playlist" | "subtitle-segment" | "video" | "audio",
      fatal = true,
      of?: string,
    ): void {
      const index = of
        ? this.subtitleTracks.findIndex((track) => track.name === of)
        : this.#subtitle;
      if (fatal) this.stopLoad();
      this.#tell(Events.ERROR, {
        fatal,
        type: real.ErrorTypes.NETWORK_ERROR,
        details:
          target === "subtitle-playlist"
            ? real.ErrorDetails.SUBTITLE_LOAD_ERROR
            : real.ErrorDetails.FRAG_LOAD_ERROR,
        context: target === "subtitle-playlist" ? { type: "subtitleTrack", id: index } : undefined,
        frag:
          target === "subtitle-segment"
            ? { type: "subtitle", level: index }
            : target === "video" || target === "audio"
              ? { type: target === "video" ? "main" : "audio" }
              : undefined,
        error: new Error("Fixture request failed"),
      });
    }

    subtitleAborted(of: string): void {
      this.#tell(Events.ERROR, {
        fatal: false,
        type: real.ErrorTypes.NETWORK_ERROR,
        details: real.ErrorDetails.INTERNAL_ABORTED,
        frag: {
          type: "subtitle",
          level: this.subtitleTracks.findIndex((track) => track.name === of),
        },
      });
    }
    subtitlePlaylist(seconds: number): void {
      this.#tell(Events.SUBTITLE_TRACK_LOADED, {
        id: this.#subtitle,
        details: { targetduration: seconds, live: true },
      });
    }
    subtitleDeferred(afterSuccess = false): void {
      const frag = this.#nextSegment(this.#subtitle);
      if (afterSuccess) frag.start -= SEGMENT_S;
      this.#tell(Events.SUBTITLE_FRAG_PROCESSED, {
        success: false,
        frag,
        part: null,
        ...(afterSuccess
          ? { error: new Error("WebVTT failed before successful IMSC fallback") }
          : {}),
      });
    }

    subtitleDiscontinuityMismatch(): void {
      this.#tell(Events.SUBTITLE_FRAG_PROCESSED, {
        success: false,
        frag: this.#nextSegment(this.#subtitle),
        part: null,
        error: new Error("Subtitle discontinuity domain does not match main"),
      });
    }

    attachMedia(media: HTMLMediaElement): void {
      this.#media = media;
    }

    destroy(): void {
      this.destroyed = true;
      this.#listeners.clear();
    }

    get audioTrack(): number {
      return this.#audio;
    }

    set audioTrack(index: number) {
      const track = this.audioTracks[index];
      if (!track || index === this.#audio) return;
      this.#audio = index;
      this.#defaultSound = false;
      this.#tell(Events.AUDIO_TRACK_SWITCHING, track);
      setTimeout(() => this.#tell(Events.AUDIO_TRACK_SWITCHED, track));
    }

    get subtitleTrack(): number {
      return this.#subtitle;
    }

    set subtitleTrack(index: number) {
      this.#defaultSubtitles = false;
      this.#selectSubtitles(index);
    }

    #selectSubtitles(index: number): void {
      if (index < -1 || index >= this.subtitleTracks.length) return;
      const before = this.#subtitle;
      this.#subtitle = index;
      if (index === -1 && before === -1) return;
      this.#tell(Events.SUBTITLE_TRACK_SWITCH, { id: index });
      if (index !== -1) this.#loadSubtitles();
    }

    /** Loads the playlist of the rendition selected by now, which a listener may have changed. */
    #loadSubtitles(): void {
      const selected = this.subtitleTracks[this.#subtitle];
      if (selected) this.subtitlesLoaded.push(selected.name);
    }

    manifest(captions: readonly Rendition[]): void {
      this.#tell(Events.MANIFEST_LOADED, { captions });
    }

    variant(groups: { audio?: readonly Rendition[]; subtitles?: readonly Rendition[] }): void {
      const playing = this.audioTracks[this.#audio];
      this.audioTracks = numbered(groups.audio ?? []);
      this.#audio = -1;
      if (this.audioTracks.length > 0 || playing) {
        this.#tell(Events.AUDIO_TRACKS_UPDATED, { audioTracks: this.audioTracks });
        // Unless a listener picked one just now.
        if (this.#audio === -1) {
          const again = playing ? this.audioTracks.findIndex(same(playing)) : -1;
          const preset = this.#defaultSound
            ? this.audioTracks.findIndex((track) => track.default)
            : -1;
          this.audioTrack = again !== -1 ? again : Math.max(preset, 0);
        }
      }
      const shown = this.subtitleTracks[this.#subtitle];
      const before = this.subtitleTracks;
      this.subtitleTracks = numbered(groups.subtitles ?? []);
      this.#readUntil.clear();
      if (this.subtitleTracks.length > 0 || before.length > 0) {
        this.#subtitle = -1;
        this.#tell(Events.SUBTITLE_TRACKS_UPDATED, { subtitleTracks: this.subtitleTracks });
        const again = shown ? this.subtitleTracks.findIndex(same(shown)) : -1;
        const preset = this.#defaultSubtitles
          ? this.subtitleTracks.findIndex((track) => track.default)
          : -1;
        const next = again !== -1 ? again : preset;
        if (next !== -1) {
          this.#subtitle = next;
          this.#tell(Events.SUBTITLE_TRACK_SWITCH, { id: next });
          this.#loadSubtitles();
        }
      }
      this.#tell(Events.LEVEL_SWITCHING, { level: 0 });
    }

    /** The segment to read next of the rendition at `level`: at the position, or after the last. */
    #nextSegment(level: number) {
      const position = this.#media?.currentTime ?? 0;
      const start = Math.max(
        this.#readUntil.get(level) ?? 0,
        Math.floor(position / SEGMENT_S) * SEGMENT_S,
      );
      return { level, start, duration: SEGMENT_S };
    }

    subtitleLines(
      lines: readonly { start: number; end: number; text: string }[],
      of?: string,
    ): void {
      const level = of
        ? this.subtitleTracks.findIndex((track) => track.name === of)
        : this.#subtitle;
      const subtitleTrack = this.subtitleTracks[level];
      if (!subtitleTrack) return;
      const frag = this.#nextSegment(level);
      this.#readUntil.set(level, frag.start + frag.duration);
      this.#tell(Events.CUES_PARSED, {
        type: "subtitles",
        track: subtitleTrack.default ? "default" : `subtitles${level}`,
        subtitleTrack,
        cues: lines.map((line) => new VTTCue(line.start, line.end, line.text)),
      });
      this.#tell(Events.SUBTITLE_FRAG_PROCESSED, { success: true, frag, part: null });
    }

    subtitleUnreadable(): void {
      if (!this.subtitleTracks[this.#subtitle]) return;
      this.#tell(Events.SUBTITLE_FRAG_PROCESSED, {
        success: false,
        frag: this.#nextSegment(this.#subtitle),
        part: null,
        error: new Error("Empty subtitle payload"),
      });
    }

    captionLines(channel: number, start: number, end: number, rows: readonly string[]): void {
      const track = `textTrack${channel}`;
      if (!this.#announced.has(channel)) {
        this.#announced.add(channel);
        this.#tell(Events.NON_NATIVE_TEXT_TRACKS_FOUND, {
          tracks: [{ _id: track, label: "", kind: "captions", default: false }],
        });
      }
      this.#tell(Events.CUES_PARSED, {
        type: "captions",
        track,
        cues: rows.map((row) => new VTTCue(start, end, row)),
      });
    }
  };
}

function numbered(renditions: readonly Rendition[]): Listed[] {
  return renditions.map((rendition, id) => ({ default: false, forced: false, ...rendition, id }));
}

/** Whether a rendition of another group is `track`'s counterpart: the same name and language. */
function same(track: Rendition): (other: Rendition) => boolean {
  return (other) => other.name === track.name && other.lang === track.lang;
}
