import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy } from "@mrstreamer/contracts/lazy";
import {
  DEFAULT_SUBTITLE_TIMING,
  SavedSubtitle,
  SubtitleTiming,
  type DownloadedSubtitle,
  type SubtitleServiceFailure,
} from "@mrstreamer/contracts/online-subtitles";
import { SUBTITLE_TEXT_LIMIT, subtitleTextFile } from "@mrstreamer/core/subtitles/text-file";
import { type } from "arktype";
import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { unzipSync } from "fflate";
import { readJson, writeJson } from "./files.ts";
import { effectiveTitleLanguage, getMediaPreferences } from "./media-preferences.ts";
import { keychainSecrets } from "./secrets.ts";
import { store, useStore } from "./store.ts";

// Online subtitles: SubDL searched with the viewer's own API key for the movie or episode playing,
// and the result chosen for each exact version kept on this phone with its timing, so it shows
// again when that version or a downloaded copy of it plays, offline too. The key stays in the
// Keychain. A search sends only the title's TMDB identity, or its title and year, an episode's
// season and number and the languages; never a provider's name, login or address. Official API:
// subdl.com/api-doc.
//
// The playback owner tells this one which version each play is of (`playSubtitles`), and asks it
// whether a downloaded subtitle shows over it, to turn the file's own off meanwhile. Searches,
// downloads and changes are for the play they were asked for: another play ends them.

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
  const tmdbId = version.tmdbId && /^[1-9]\d{0,9}$/.test(version.tmdbId) ? Number(version.tmdbId) : null;
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

const shown = store<ShownSubtitle | null>(null);
/** The downloaded subtitle showing over what plays, for Watch to draw; null for none. */
export const useShownSubtitle = (): ShownSubtitle | null => useStore(shown);
/** The same, for the playback owner. */
export const shownSubtitle = (): ShownSubtitle | null => shown.get();
export const onShownSubtitle = (listener: () => void): (() => void) => shown.subscribe(listener);

/** The play subtitles are asked for now; null while no movie or episode plays. */
let playing: SubtitleTitle | null = null;
/** The search or download under way for it, which a newer one, or another play, ends. */
let work: AbortController | null = null;
/** The current search's results, by the id the sheet shows them under. */
let found = new Map<string, Candidate>();

/**
 * A play begins, of `title` or of something without one, or nothing plays any more. What its
 * version keeps showing shows again; a search or download for the play before ends.
 */
export function playSubtitles(title: SubtitleTitle | null) {
  if (title === playing) return;
  playing = title;
  work?.abort();
  work = null;
  found = new Map();
  const kept = title ? keptOf(title) : null;
  shown.set(title && kept?.shown ? { title, subtitle: kept.subtitle, timing: kept.timing } : null);
}

/** What `title`'s version keeps, shown or not, while `title` plays; null for nothing. */
export function keptSubtitle(title: SubtitleTitle): ShownSubtitle | null {
  if (title !== playing) return null;
  const showing = shown.get();
  if (showing?.title === title) return showing;
  const kept = keptOf(title);
  return kept && { title, subtitle: kept.subtitle, timing: kept.timing };
}

/** One result of a search, as the sheet lists it. */
export interface FoundSubtitle {
  readonly id: string;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
}

export type Found =
  | { readonly kind: "found"; readonly results: readonly FoundSubtitle[] }
  | { readonly kind: "failed"; readonly reason: SubtitleServiceFailure };

/**
 * Searches SubDL for `title` in the viewer's languages: their subtitle language, the language of
 * titles and English. Null when another play, search or download began meanwhile.
 */
export async function findSubtitles(title: SubtitleTitle): Promise<Found | null> {
  if (title !== playing) return null;
  const controller = begin();
  try {
    const key = await subdlKey();
    if (controller.signal.aborted) return null;
    if (!key) return { kind: "failed", reason: "not-configured" };
    const candidates = await subdlSearch(key, { ...title.query, languages: languages() }, controller.signal);
    if (controller.signal.aborted) return null;
    found = new Map(candidates.map((candidate, i) => [String(i), candidate]));
    return {
      kind: "found",
      results: candidates.map(({ language, release, hearingImpaired }, i) => ({
        id: String(i),
        language,
        release,
        hearingImpaired,
      })),
    };
  } catch (cause) {
    if (controller.signal.aborted) return null;
    return { kind: "failed", reason: reasonOf(cause) };
  } finally {
    if (work === controller) work = null;
  }
}

export type Chosen =
  | { readonly kind: "shown" }
  | { readonly kind: "failed"; readonly reason: SubtitleServiceFailure | "not-saved" };

/**
 * Downloads result `id` of the latest search for `title`, keeps it for the version with no timing
 * change and shows it. Null when another play, search or download began meanwhile.
 */
export async function chooseSubtitle(title: SubtitleTitle, id: string): Promise<Chosen | null> {
  const candidate = found.get(id);
  if (title !== playing || !candidate) return null;
  const controller = begin();
  try {
    const subtitle = await subdlDownload(candidate, controller.signal);
    if (controller.signal.aborted) return null;
    const kept = { shown: true, timing: DEFAULT_SUBTITLE_TIMING, subtitle };
    if (!keep(title, kept)) return { kind: "failed", reason: "not-saved" };
    shown.set({ title, subtitle, timing: kept.timing });
    return { kind: "shown" };
  } catch (cause) {
    if (controller.signal.aborted) return null;
    return { kind: "failed", reason: reasonOf(cause) };
  } finally {
    if (work === controller) work = null;
  }
}

/** Shows what `title`'s version keeps again, after a file track or Off took its place. */
export function showKeptSubtitle(title: SubtitleTitle): boolean {
  if (title !== playing) return false;
  const kept = keptOf(title);
  if (!kept) return false;
  if (!kept.shown && !keep(title, { ...kept, shown: true })) return false;
  shown.set({ title, subtitle: kept.subtitle, timing: kept.timing });
  return true;
}

/**
 * The viewer chose one of the file's own tracks, or Off, over the downloaded subtitle: it stays
 * kept, with its timing, but no longer shows by itself when the version plays again. Shown no more
 * now, also when the disk refuses to note that.
 */
export function hideSubtitle(title: SubtitleTitle) {
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

/** Ends the search or download under way and starts the next. */
function begin(): AbortController {
  work?.abort();
  work = new AbortController();
  return work;
}

/** The viewer's subtitle language, then the language of titles, then English. */
function languages(): string[] {
  const { subtitles } = getMediaPreferences();
  const wanted = [
    subtitles.kind === "language" ? subtitles.language : null,
    effectiveTitleLanguage(),
    "en",
  ];
  return [
    ...new Set(wanted.filter((code): code is string => !!code && /^[a-z]{2,3}$/.test(code))),
  ];
}

const reasonOf = (cause: unknown): SubtitleServiceFailure =>
  cause instanceof SubtitleFailure ? cause.reason : "unavailable";

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
  try {
    const folder = new Directory(Paths.document, FOLDER);
    if (!folder.exists) folder.create();
    writeJson(nameOf(title), kept);
  } catch {
    return false;
  }
  try {
    const files = new Directory(Paths.document, FOLDER)
      .list()
      .filter((each): each is File => each instanceof File && each.name.endsWith(".json"));
    const oldest = files.toSorted(
      (a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0),
    );
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
  const folder = new Directory(Paths.document, FOLDER);
  if (!folder.exists) return;
  const prefix = `${encoded(id)}.`;
  for (const each of folder.list()) {
    if (each instanceof File && each.name.startsWith(prefix)) each.delete();
  }
  const showing = shown.get();
  if (showing?.title.subscriptionId === id) shown.set(null);
}

// The viewer's SubDL API key, in the Keychain. Settings sees only whether one is saved.

const KEY = "online-subtitles.subdl";
/** Whether a key is saved; null until the Keychain answered. */
const keySaved = store<boolean | null>(null);
let keyRead: Promise<void> | null = null;

/** Whether a SubDL key is saved; null while the Keychain is still asked. */
export function useSubtitleKey(): boolean | null {
  keyRead ??= keychainSecrets
    .read(KEY)
    .then((key) => keySaved.set(!!key))
    .catch(() => keySaved.set(false));
  return useStore(keySaved);
}

const subdlKey = () =>
  keychainSecrets.read(KEY).catch(() => {
    throw new SubtitleFailure("credentials");
  });

/** Saves `key` as the SubDL key. Throws `keychain-refused` when the Keychain won't keep it. */
export async function saveSubtitleKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 4096) throw new AppFailure({ kind: "keychain-refused" });
  await keychainSecrets.write(KEY, trimmed);
  keySaved.set(true);
}

/** Removes the SubDL key. Throws `keychain-refused` when the Keychain won't. */
export async function removeSubtitleKey() {
  await keychainSecrets.remove(KEY);
  keySaved.set(false);
}

// SubDL, as the desktop app asks it (apps/desktop/src/main/subtitles/service-client.ts). Its errors
// are only a reason: a fetch error's message can hold the address with the key.

class SubtitleFailure extends Error {
  readonly reason: SubtitleServiceFailure;
  constructor(reason: SubtitleServiceFailure) {
    super(`Subtitle service: ${reason}.`);
    this.reason = reason;
  }
}

/** A result's file, kept here: the sheet sees only its id. */
interface Candidate {
  readonly url: string;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
}

const SubDLReply = lazy(() =>
  type({
    status: "boolean",
    "results?": type({ "tmdb_id?": "number | null", type: "'movie' | 'tv'" })
      .array()
      .atMostLength(100),
    "subtitles?": type({
      "language?": "string <= 64",
      "lang?": "string <= 64",
      "release_name?": "string <= 1024",
      "name?": "string <= 1024",
      url: "string <= 8192",
      "hi?": "boolean",
      "full_season?": "boolean",
      "season?": "number | null",
      "episode?": "number | null",
      "unpack_files?": type({
        language: "string <= 64",
        name: "string <= 1024",
        "release_name?": "string <= 1024",
        season: "number",
        episode: "number",
        format: "string <= 16",
        url: "string <= 8192",
        "hi?": "boolean",
      })
        .array()
        .atMostLength(1000),
    })
      .array()
      .atMostLength(100),
  }),
);

const USER_AGENT = `MrStreamer/${Constants.expoConfig?.version ?? "0.0.0"} (iOS)`;
const JSON_LIMIT = 2 * 1024 * 1024;

async function subdlSearch(
  key: string,
  query: TitleQuery & { readonly languages: readonly string[] },
  signal: AbortSignal,
): Promise<readonly Candidate[]> {
  if (query.languages.length === 0) throw new SubtitleFailure("unsupported");
  const url = new URL("https://api.subdl.com/api/v1/subtitles");
  url.search = new URLSearchParams({
    api_key: key,
    ...(query.tmdbId !== undefined
      ? { tmdb_id: String(query.tmdbId) }
      : { film_name: query.title ?? "" }),
    ...(query.year !== undefined ? { year: String(query.year) } : {}),
    type: query.kind === "movie" ? "movie" : "tv",
    languages: query.languages.join(",").toUpperCase(),
    subs_per_page: "30",
    hi: "1",
    unpack: "1",
    client: "custom_integration",
    ...(query.kind === "episode"
      ? { season_number: String(query.season), episode_number: String(query.episode) }
      : {}),
  }).toString();
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await request(url, { headers: { Accept: "application/json" } }, timeout);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await body(response, JSON_LIMIT, timeout),
  );
  const reply = SubDLReply()(JSON.parse(text));
  if (reply instanceof type.errors || !reply.status) throw new SubtitleFailure("unavailable");
  // SubDL may broaden an unsuccessful match. Do not import another title's results.
  if (
    (query.tmdbId !== undefined && reply.results?.[0]?.tmdb_id !== query.tmdbId) ||
    reply.results?.[0]?.type !== (query.kind === "movie" ? "movie" : "tv")
  )
    return [];
  const results: Candidate[] = [];
  for (const sub of reply.subtitles ?? []) {
    const files = sub.unpack_files?.filter(
      (file) =>
        query.kind === "episode" &&
        file.season === query.season &&
        file.episode === query.episode &&
        /^(srt|vtt)$/i.test(file.format),
    );
    if (files?.length) {
      for (const file of files)
        results.push({
          url: downloadURL(file.url).href,
          language: requestedLanguage(file.language, query.languages),
          release: file.release_name ?? file.name,
          hearingImpaired: file.hi ?? false,
        });
    } else if (
      !sub.full_season &&
      (sub.language || sub.lang) &&
      (query.kind === "movie" || (sub.season === query.season && sub.episode === query.episode))
    ) {
      results.push({
        url: downloadURL(sub.url).href,
        language: requestedLanguage(sub.language ?? sub.lang ?? "", query.languages),
        release: sub.release_name ?? sub.name ?? "",
        hearingImpaired: sub.hi ?? false,
      });
    }
  }
  return results.filter((sub) => query.languages.includes(sub.language)).slice(0, 100);
}

async function subdlDownload(
  candidate: Candidate,
  signal: AbortSignal,
): Promise<DownloadedSubtitle> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await request(downloadURL(candidate.url), {}, timeout);
  // A redirect followed elsewhere ends on a file SubDL didn't serve.
  if (response.url) downloadURL(response.url);
  const data = await body(response, SUBTITLE_TEXT_LIMIT, timeout);
  let cues: ReturnType<typeof subtitleTextFile>;
  try {
    cues = subtitleTextFile(new TextDecoder("utf-8", { fatal: true }).decode(textOf(data)));
  } catch (cause) {
    throw cause instanceof SubtitleFailure ? cause : new SubtitleFailure("unsupported");
  }
  return {
    service: "subdl",
    language: candidate.language,
    release: candidate.release.slice(0, 1024),
    cues: [...cues],
  };
}

async function request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
      headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-store", ...init.headers },
    });
  } catch {
    throw new SubtitleFailure("unavailable");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SubtitleFailure(
      response.status === 401 || response.status === 403
        ? "credentials"
        : response.status === 402 || response.status === 429
          ? "quota"
          : "unavailable",
    );
  }
  return response;
}

/** The whole body, refused once it passes `limit` bytes. */
async function body(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new SubtitleFailure("unsupported");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SubtitleFailure("unsupported");
      chunks.push(value);
    }
  } catch (cause) {
    void reader.cancel().catch(() => {});
    throw cause instanceof SubtitleFailure ? cause : new SubtitleFailure("unavailable");
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}

/**
 * The subtitle text of a download: the file itself, or the one SRT or WebVTT file of a ZIP file.
 * A ZIP file with none, several, more than 64 entries or one larger than the text limit is
 * refused; a dishonest size inflates no further than the size it claims.
 */
function textOf(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x50 || data[1] !== 0x4b) return data;
  let entries = 0;
  let picked = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: ({ name, originalSize }) => {
        if (++entries > 64) throw new SubtitleFailure("unsupported");
        const base = name.split("/").at(-1) ?? "";
        if (name.startsWith("__MACOSX/") || base.startsWith("._") || !/\.(srt|vtt)$/i.test(base))
          return false;
        if (++picked > 1 || originalSize > SUBTITLE_TEXT_LIMIT)
          throw new SubtitleFailure("unsupported");
        return true;
      },
    });
  } catch {
    throw new SubtitleFailure("unsupported");
  }
  const [only] = Object.values(files);
  if (!only) throw new SubtitleFailure("unsupported");
  return only;
}

/** A SubDL file's address: HTTPS on dl.subdl.com only, without a login or port. */
function downloadURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value, "https://dl.subdl.com");
  } catch {
    throw new SubtitleFailure("unsupported");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== "dl.subdl.com"
  )
    throw new SubtitleFailure("unsupported");
  return url;
}

/** SubDL returns both ISO codes and English language names, depending on the file record. */
function requestedLanguage(value: string, requested: readonly string[]): string {
  const name = value.trim().toLowerCase();
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  return requested.find((code) => code === name || names.of(code)?.toLowerCase() === name) ?? "";
}
