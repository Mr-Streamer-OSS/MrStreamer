import {
  DEFAULT_SUBTITLE_TIMING,
  SavedSubtitle,
  SubtitleTiming,
  type DownloadedSubtitle,
} from "@mrstreamer/contracts/online-subtitles";
import { type } from "arktype";
import { Directory, File, Paths } from "expo-file-system";
import { readJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// Downloaded subtitles kept on this phone, one per exact movie or episode version with its timing,
// so it shows again when that version or a downloaded copy of it plays, offline too.
// `online-subtitles.ts` finds and downloads them. The playback owner tells this one which version
// each play is of (`playSubtitles`), and asks it whether a downloaded subtitle shows over it, to
// turn the file's own off meanwhile. What was asked for one play can't change another.

/** What a search asks for: a movie, or an episode by its series and number. */
type TitleQuery = {
  readonly tmdbId?: number;
  readonly title?: string;
  readonly year?: number;
} & (
  | { readonly kind: "movie" }
  | { readonly kind: "episode"; readonly season: number; readonly episode: number }
);

/**
 * One play of a movie or episode version, as online subtitles know it. Each play makes its own,
 * so what was asked for one play can't reach another, a later play of the same version included.
 */
export interface SubtitleTitle {
  /** The version's subscription, whose history removal takes what was kept for it. */
  readonly subscriptionId: string;
  /** The exact version in that subscription: "movie|<id>" or "episode|<id>". */
  readonly version: string;
  readonly query: TitleQuery;
}

/** The subtitle identity of a movie or episode version, for its play. */
export function subtitleTitle(version: {
  readonly subscriptionId: string;
  readonly id: string;
  readonly tmdbId: string | null;
  readonly title: string;
  readonly year: number | null;
  readonly episode?: { readonly season: number; readonly number: number };
}): SubtitleTitle {
  const tmdbId =
    version.tmdbId && /^[1-9]\d{0,9}$/.test(version.tmdbId) ? Number(version.tmdbId) : null;
  const known = {
    ...(tmdbId !== null ? { tmdbId } : { title: version.title }),
    // A series' year is when it began, which no episode search needs.
    ...(version.year !== null && !version.episode ? { year: version.year } : {}),
  };
  return {
    subscriptionId: version.subscriptionId,
    version: `${version.episode ? "episode" : "movie"}|${version.id}`,
    query: version.episode
      ? {
          ...known,
          kind: "episode",
          season: version.episode.season,
          episode: version.episode.number,
        }
      : { ...known, kind: "movie" },
  };
}

/** A downloaded subtitle over the play it shows for, with its timing. */
export interface ShownSubtitle {
  readonly title: SubtitleTitle;
  readonly subtitle: DownloadedSubtitle;
  readonly timing: SubtitleTiming;
}

/** What one version keeps: the result chosen last, whether it shows by itself, and its timing. */
interface Kept {
  readonly shown: boolean;
  readonly timing: SubtitleTiming;
  readonly subtitle: DownloadedSubtitle;
}

/** What `title`'s version keeps, as it shows over that play. */
const shownOf = (title: SubtitleTitle, { subtitle, timing }: Kept): ShownSubtitle => ({
  title,
  subtitle,
  timing,
});

const shown = store<ShownSubtitle | null>(null);
/** The downloaded subtitle showing over what plays, for Watch to draw; null for none. */
export const useShownSubtitle = (): ShownSubtitle | null => useStore(shown);
/** The same, for the playback owner. */
export const shownSubtitle = (): ShownSubtitle | null => shown.get();
export const onShownSubtitle = (listener: () => void): (() => void) => shown.subscribe(listener);

/** The play subtitles are asked for now; null while no movie or episode plays. */
let playing: SubtitleTitle | null = null;
/**
 * Aborted once another play begins, or the viewer chose subtitles anew for this one, ending a
 * search or download asked before.
 */
let play = new AbortController();

/** Ends what was asked of the current play so far: a newer choice or an erasure stands. */
function renew() {
  play.abort();
  play = new AbortController();
}

/**
 * A play begins, of `title` or of something without one, or nothing plays any more. What its
 * version keeps showing shows again; a search or download for the play before ends.
 */
export function playSubtitles(title: SubtitleTitle | null) {
  if (title === playing) return;
  playing = title;
  renew();
  const kept = title ? keptOf(title) : null;
  shown.set(title && kept?.shown ? shownOf(title, kept) : null);
}

/**
 * The play `title` is of, while it stands: aborted once another begins or the viewer chooses its
 * subtitles anew. Null for another play.
 */
export function playOf(title: SubtitleTitle): AbortSignal | null {
  return title === playing ? play.signal : null;
}

/** What `title`'s version keeps, shown or not, while `title` plays; null for nothing. */
export function keptSubtitle(title: SubtitleTitle): ShownSubtitle | null {
  if (title !== playing) return null;
  const showing = shown.get();
  if (showing?.title === title) return showing;
  const kept = keptOf(title);
  return kept && shownOf(title, kept);
}

/** Shows what `title`'s version keeps again, after a file track or Off took its place. */
export function showKeptSubtitle(title: SubtitleTitle): boolean {
  if (title !== playing) return false;
  const kept = keptOf(title);
  if (!kept) return false;
  if (!kept.shown && !keep(title, { ...kept, shown: true })) return false;
  renew();
  shown.set(shownOf(title, kept));
  return true;
}

/** The viewer is choosing `title`'s subtitles anew: a search or download under way ends. */
export function endSubtitleWork(title: SubtitleTitle) {
  if (title === playing) renew();
}

/**
 * The viewer chose one of the file's own tracks, or Off, for `title`'s play: a download under way
 * ends, and the downloaded subtitle showing stays kept, with its timing, but no longer shows by
 * itself when the version plays again. Shown no more now, also when the disk refuses to note that.
 */
export function hideSubtitle(title: SubtitleTitle) {
  if (title !== playing) return;
  renew();
  if (shown.get()?.title !== title) return;
  const kept = keptOf(title);
  if (kept?.shown) keep(title, { ...kept, shown: false });
  shown.set(null);
}

/**
 * Moves the downloaded subtitle showing over `title`: its clock times `speed`, then `offset`
 * seconds later. False keeps the timing as it was: out of range, nothing showing or a refused save.
 */
export function retimeSubtitle(title: SubtitleTitle, timing: SubtitleTiming): boolean {
  const showing = shown.get();
  if (title !== playing || showing?.title !== title) return false;
  const checked = SubtitleTiming()(timing);
  if (checked instanceof type.errors) return false;
  if (!keep(title, { shown: true, timing: checked, subtitle: showing.subtitle })) return false;
  shown.set({ ...showing, timing: checked });
  return true;
}

/**
 * The cue lines to show at `seconds` of the picture, after the timing: the subtitle's clock is the
 * picture's less `offset`, divided by `speed`. Empty between cues.
 */
export function cuesAt({ subtitle, timing }: ShownSubtitle, seconds: number): readonly string[] {
  const at = (seconds - timing.offset) / timing.speed;
  return subtitle.cues.filter((cue) => cue.start <= at && at < cue.end).map((cue) => cue.text);
}

/**
 * The picture's next second at which the cues `cuesAt` answers change, after `seconds`; null when
 * none does.
 */
export function nextCueChange({ subtitle, timing }: ShownSubtitle, seconds: number): number | null {
  const at = (seconds - timing.offset) / timing.speed;
  let next = Infinity;
  for (const cue of subtitle.cues) {
    if (cue.start > at) next = Math.min(next, cue.start);
    else if (cue.end > at) next = Math.min(next, cue.end);
  }
  return Number.isFinite(next) ? next * timing.speed + timing.offset : null;
}

/**
 * Keeps `subtitle`, just downloaded for `title`, for its version with no timing change, and shows
 * it. False when the disk refuses, or another play began.
 */
export function showDownloaded(title: SubtitleTitle, subtitle: DownloadedSubtitle): boolean {
  if (title !== playing) return false;
  const kept = { shown: true, timing: DEFAULT_SUBTITLE_TIMING, subtitle };
  if (!keep(title, kept)) return false;
  shown.set(shownOf(title, kept));
  return true;
}

// What each version keeps, as its own JSON file in one folder, named by its subscription and then
// its version so that removing a subscription's history finds them. At most KEPT_FILES are kept;
// the least recently changed go first.

const FOLDER = "online-subtitles";
const KEPT_FILES = 100;

/** Letters, digits and "-" as they are; every other UTF-16 unit "_" and four hex digits. */
const encoded = (text: string) =>
  text.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
const nameOf = (title: SubtitleTitle) =>
  `${FOLDER}/${encoded(title.subscriptionId)}.${encoded(title.version)}.json`;

function keptOf(title: SubtitleTitle): Kept | null {
  const saved = SavedSubtitle()(readJson(nameOf(title)));
  if (saved instanceof type.errors || !saved.subtitle) return null;
  return { shown: saved.shown ?? true, timing: saved.timing, subtitle: saved.subtitle };
}

/** Writes what `title`'s version keeps. False when the disk refuses. */
function keep(title: SubtitleTitle, kept: Kept): boolean {
  const folder = new Directory(Paths.document, FOLDER);
  const file = new File(Paths.document, nameOf(title));
  let before: string | null = null;
  try {
    if (!folder.exists) folder.create();
    before = file.exists ? file.textSync() : null;
    writeJson(nameOf(title), kept);
  } catch {
    // A refused write can leave its proposal beside the file, which a read would take instead,
    // and the move that refused may already have deleted the file: what it held goes back.
    try {
      const pending = new File(Paths.document, `${nameOf(title)}.next`);
      if (pending.exists) pending.delete();
      if (before !== null && !file.exists) {
        file.create();
        file.writeSync(before);
      }
    } catch {
      // The disk refused that too.
    }
    return false;
  }
  try {
    const files = folder
      .list()
      .filter((each): each is File => each instanceof File && each.name.endsWith(".json"));
    const oldest = files.toSorted((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
    for (const file of oldest.slice(0, Math.max(0, files.length - KEPT_FILES))) file.delete();
  } catch {
    // Kept anyway; the next write tries again.
  }
  return true;
}

/**
 * Deletes what every version of subscription `id` keeps, as erasing its history does. Throws when
 * one stays, for the next launch to try again.
 */
export function eraseSubtitles(id: string) {
  // A download under way for a copy of it, which plays on without its provider, can't keep it again.
  if (playing?.subscriptionId === id) renew();
  const folder = new Directory(Paths.document, FOLDER);
  if (!folder.exists) return;
  const prefix = `${encoded(id)}.`;
  for (const each of folder.list()) {
    if (each instanceof File && each.name.startsWith(prefix)) each.delete();
  }
  if (shown.get()?.title.subscriptionId === id) shown.set(null);
}
