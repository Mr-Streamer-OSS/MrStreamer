import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy } from "@mrstreamer/contracts/lazy";
import type {
  DownloadedSubtitle,
  SubtitleServiceFailure,
} from "@mrstreamer/contracts/online-subtitles";
import { SUBTITLE_TEXT_LIMIT, subtitleTextFile } from "@mrstreamer/core/subtitles/text-file";
import { type } from "arktype";
import { unzipSync } from "fflate";
import { playOf, showDownloaded, type SubtitleTitle } from "./downloaded-subtitles.ts";
import { effectiveTitleLanguage, getMediaPreferences } from "./media-preferences.ts";
import { keychainSecrets } from "./secrets.ts";
import { store, useStore } from "./store.ts";

// Online subtitles: SubDL searched with the viewer's own API key for the movie or episode playing,
// and the result chosen downloaded, for `downloaded-subtitles.ts` to keep and show. The key stays
// in the Keychain. A search sends only the title's TMDB identity, or its title and year, an
// episode's season and number and the languages; never a provider's name, login or address.
// Official API: subdl.com/api-doc. Searches and downloads are for the play they were asked for:
// another play ends them.

/** One result of a search, as the sheet lists it. */
export interface FoundSubtitle {
  readonly id: string;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
}

type Failed = { readonly kind: "failed"; readonly reason: SubtitleServiceFailure };

export type Found = { readonly kind: "found"; readonly results: readonly FoundSubtitle[] } | Failed;

/**
 * Searches SubDL for `title` in the viewer's languages: their subtitle language, the language of
 * titles and English. Null when another play, search or download began meanwhile.
 */
export function findSubtitles(title: SubtitleTitle): Promise<Found | null> {
  found = null;
  const search = ++searches;
  return forPlay<Found>(title, async (signal) => {
    const key = await subdlKey();
    if (signal.aborted) return null;
    if (!key) return { kind: "failed", reason: "not-configured" };
    const candidates = await subdlSearch(key, { ...title.query, languages: languages() }, signal);
    if (signal.aborted) return null;
    found = { title, search, candidates };
    return {
      kind: "found",
      results: candidates.map(({ language, release, hearingImpaired }, i) => ({
        id: `${search}.${i}`,
        language,
        release,
        hearingImpaired,
      })),
    };
  });
}

export type Chosen =
  | { readonly kind: "shown" }
  | { readonly kind: "failed"; readonly reason: SubtitleServiceFailure | "not-saved" };

/**
 * Downloads result `id` of the latest search for `title`, keeps it for the version with no timing
 * change and shows it. Null when another play, search or download began meanwhile.
 */
export async function chooseSubtitle(title: SubtitleTitle, id: string): Promise<Chosen | null> {
  const [search, index] = id.split(".").map(Number);
  const candidate =
    found?.title === title && found.search === search ? found.candidates[index ?? -1] : undefined;
  if (!candidate) return null;
  return forPlay<Chosen>(title, async (signal) => {
    const subtitle = await subdlDownload(candidate, signal);
    if (signal.aborted) return null;
    return showDownloaded(title, subtitle)
      ? { kind: "shown" }
      : { kind: "failed", reason: "not-saved" };
  });
}

/** The search or download under way, which a newer one, or another play, ends. */
let work: AbortController | null = null;
/** Searches begun, which number their results' ids so one search's can't pick another's. */
let searches = 0;
/** The latest search's results, for its play: "<search>.<position>" is the id the sheet shows. */
let found: {
  readonly title: SubtitleTitle;
  readonly search: number;
  readonly candidates: readonly Candidate[];
} | null = null;

/**
 * Runs `task` for `title`'s play, ending the search or download under way. Null when it isn't
 * playing, or once another play, search or download began; a failure as its reason only.
 */
async function forPlay<T>(
  title: SubtitleTitle,
  task: (signal: AbortSignal) => Promise<T | null>,
): Promise<T | Failed | null> {
  const play = playOf(title);
  if (!play) return null;
  work?.abort();
  const controller = new AbortController();
  play.addEventListener("abort", () => controller.abort(), { once: true });
  work = controller;
  try {
    return await task(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted) return null;
    return {
      kind: "failed",
      reason: cause instanceof SubtitleFailure ? cause.reason : "unavailable",
    };
  } finally {
    if (work === controller) work = null;
  }
}

/** The viewer's subtitle language, then the language of titles, then English. */
function languages(): string[] {
  const { subtitles } = getMediaPreferences();
  const wanted = [
    subtitles.kind === "language" ? subtitles.language : null,
    effectiveTitleLanguage(),
    "en",
  ];
  return [...new Set(wanted.filter((code): code is string => !!code && /^[a-z]{2,3}$/.test(code)))];
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

/** A result with its file, kept here: the sheet sees only its id. */
interface Candidate extends Omit<FoundSubtitle, "id"> {
  readonly url: string;
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

const JSON_LIMIT = 2 * 1024 * 1024;

async function subdlSearch(
  key: string,
  query: SubtitleTitle["query"] & { readonly languages: readonly string[] },
  signal: AbortSignal,
): Promise<readonly Candidate[]> {
  if (query.languages.length === 0) throw new SubtitleFailure("unsupported");
  const kind = query.kind === "movie" ? "movie" : "tv";
  const url = new URL("https://api.subdl.com/api/v1/subtitles");
  url.search = new URLSearchParams({
    api_key: key,
    ...(query.tmdbId !== undefined
      ? { tmdb_id: String(query.tmdbId) }
      : { film_name: query.title ?? "" }),
    ...(query.year !== undefined ? { year: String(query.year) } : {}),
    type: kind,
    languages: query.languages.join(",").toUpperCase(),
    subs_per_page: "30",
    unpack: "1",
    client: "custom_integration",
    ...(query.kind === "episode"
      ? { season_number: String(query.season), episode_number: String(query.episode) }
      : {}),
  }).toString();
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await request(url, { headers: { Accept: "application/json" } }, timeout);
  // An answer from where a redirect led, not SubDL's own API, isn't taken.
  if (response.url && new URL(response.url).origin !== url.origin)
    throw new SubtitleFailure("unavailable");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await body(response, JSON_LIMIT, timeout),
  );
  const reply = SubDLReply()(JSON.parse(text));
  if (reply instanceof type.errors || !reply.status) throw new SubtitleFailure("unavailable");
  // SubDL may broaden an unsuccessful match. Do not import another title's results.
  if (
    (query.tmdbId !== undefined && reply.results?.[0]?.tmdb_id !== query.tmdbId) ||
    reply.results?.[0]?.type !== kind
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
  const text = textOf(await body(response, SUBTITLE_TEXT_LIMIT, timeout));
  try {
    return {
      service: "subdl",
      language: candidate.language,
      release: candidate.release.slice(0, 1024),
      cues: [...subtitleTextFile(new TextDecoder("utf-8", { fatal: true }).decode(text))],
    };
  } catch {
    throw new SubtitleFailure("unsupported");
  }
}

async function request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
      headers: { "Cache-Control": "no-store", ...init.headers },
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
