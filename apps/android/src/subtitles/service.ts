import { lazy } from "@mrstreamer/contracts/lazy";
import type {
  DownloadedSubtitle,
  SubtitleServiceFailure,
} from "@mrstreamer/contracts/online-subtitles";
import { SUBTITLE_TEXT_LIMIT, subtitleTextBytes } from "@mrstreamer/core/subtitles/text-file";
import { normalize } from "@mrstreamer/core/text";
import { defined } from "@mrstreamer/core/defined";
import { type } from "arktype";

export type SubtitleFailureReason =
  | SubtitleServiceFailure
  | "keychain"
  | "read"
  | "not-saved"
  | "timing"
  | "timing-limit"
  | "selection-save";

export interface FoundSubtitle {
  readonly id: string;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
  readonly format: "SubRip" | "WebVTT" | "Text";
}

export type SubtitleQuery = {
  readonly tmdbId?: number;
  readonly title?: string;
  readonly year?: number;
} & (
  | { readonly kind: "movie" }
  | { readonly kind: "episode"; readonly season: number; readonly episode: number }
);

export class SubtitleFailure extends Error {
  readonly reason: SubtitleFailureReason;
  constructor(reason: SubtitleFailureReason) {
    super(`Subtitle service: ${reason}.`);
    this.reason = reason;
  }
}

/** A result with its file, kept here: the sheet sees only its id. */
export interface Candidate extends Omit<FoundSubtitle, "id"> {
  readonly url: string;
}

const SubDLReply = lazy(() =>
  type({
    status: "boolean",
    "results?": type({
      "tmdb_id?": "number | null",
      type: "'movie' | 'tv'",
      "name?": "string <= 1024",
      "year?": "number | null",
    })
      .array()
      .atMostLength(100),
    "subtitles?": type({
      "language?": "string <= 64",
      "lang?": "string <= 64",
      "release_name?": "string <= 1024",
      "name?": "string <= 1024",
      url: "string <= 8192",
      "hi?": "boolean",
      "format?": "string <= 16",
      "full_season?": "boolean",
      "season?": "number | null",
      "episode?": "number | null",
      "unpack_files?": type({
        language: "string <= 64",
        name: "string <= 1024",
        "release_name?": "string <= 1024",
        "season?": "number",
        "episode?": "number",
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

export async function subdlSearch(
  key: string,
  query: SubtitleQuery & { readonly languages: readonly string[] },
  signal: AbortSignal,
): Promise<{ candidates: readonly Candidate[]; unsupported: readonly string[] }> {
  if (query.languages.length === 0) throw new SubtitleFailure("unsupported");
  const kind = query.kind === "movie" ? "movie" : "tv";
  const url = new URL("https://api.subdl.com/api/v1/subtitles");

  const params = new URLSearchParams({
    api_key: key,
    ...(query.tmdbId !== undefined
      ? { tmdb_id: String(query.tmdbId) }
      : { film_name: query.title ?? "" }),
    ...defined({ year: query.year !== undefined ? String(query.year) : undefined }),
    type: kind,
    languages: query.languages.join(",").toUpperCase(),
    subs_per_page: "30",
    unpack: "1",
    client: "custom_integration",
  });

  if (query.kind === "episode") {
    params.set("season_number", String(query.season));
    params.set("episode_number", String(query.episode));
  }

  url.search = params.toString();
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await request(url, { headers: { Accept: "application/json" } }, timeout);

  // An answer from where a redirect led, not SubDL's own API, isn't taken.
  if (response.url && new URL(response.url).origin !== url.origin) refuse(response, "unavailable");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await body(response, JSON_LIMIT, timeout),
  );

  const reply = SubDLReply()(JSON.parse(text));

  if (reply instanceof type.errors || !reply.status) throw new SubtitleFailure("unavailable");
  // SubDL may broaden an unsuccessful match, and its subtitles are for its first result. Without
  // a TMDB id, that result must name the title asked for, and the year when one was asked.
  const first = reply.results?.[0];
  const asked = normalize(query.title ?? "");

  if (
    first?.type !== kind ||
    (query.tmdbId !== undefined
      ? first.tmdb_id !== query.tmdbId
      : !asked ||
        normalize(first.name ?? "") !== asked ||
        (query.year !== undefined && first.year !== query.year))
  )
    return { candidates: [], unsupported: [] };
  const results: Candidate[] = [];
  const unsupported: string[] = [];

  for (const sub of reply.subtitles ?? []) {
    const files = sub.unpack_files?.filter(
      (file) =>
        query.kind === "movie" || (file.season === query.season && file.episode === query.episode),
    );

    if (files?.length) {
      for (const file of files) {
        if (!requestedLanguage(file.language, query.languages)) continue;

        if (!/^(srt|vtt)$/i.test(file.format)) {
          unsupported.push(file.format);
          continue;
        }

        results.push({
          format: file.format.toLowerCase() === "srt" ? "SubRip" : "WebVTT",
          url: file.url,
          language: requestedLanguage(file.language, query.languages),
          release: file.release_name ?? file.name,
          hearingImpaired: file.hi ?? false,
        });
      }
    } else if (
      !sub.full_season &&
      (sub.language || sub.lang) &&
      (query.kind === "movie" || (sub.season === query.season && sub.episode === query.episode))
    ) {
      if (!requestedLanguage(sub.language ?? sub.lang ?? "", query.languages)) continue;

      const format =
        sub.format?.toLowerCase() ??
        [sub.release_name, sub.name, sub.url].flatMap((name) => {
          const match = /\.(srt|vtt|ass|ssa|sub|idx|ttml)(?:\.zip)?$/i.exec(
            (name ?? "").replace(/\.zip$/i, ""),
          );

          return match ? [match[1]!.toLowerCase()] : [];
        })[0];

      if (format && !/^(srt|vtt)$/.test(format)) {
        unsupported.push(format);
        continue;
      }

      results.push({
        format: format === "srt" ? "SubRip" : format === "vtt" ? "WebVTT" : "Text",
        url: sub.url,
        language: requestedLanguage(sub.language ?? sub.lang ?? "", query.languages),
        release: sub.release_name ?? sub.name ?? "",
        hearingImpaired: sub.hi ?? false,
      });
    }
  }

  // A file anywhere but SubDL's download host isn't listed; the other results still are.
  return {
    unsupported,
    candidates: results
      .flatMap((sub) => {
        const url = query.languages.includes(sub.language) && listedURL(sub.url);

        return url ? [{ ...sub, url }] : [];
      })
      .slice(0, 100),
  };
}

/** `value` as a SubDL file address, or null when `downloadURL` refuses it. */
function listedURL(value: string): string | null {
  try {
    return downloadURL(value).href;
  } catch {
    return null;
  }
}

export async function subdlDownload(
  candidate: Candidate,
  signal: AbortSignal,
  unpack: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<DownloadedSubtitle> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await request(downloadURL(candidate.url), {}, timeout);

  // A redirect followed elsewhere ends on a file SubDL didn't serve.
  try {
    if (response.url) downloadURL(response.url);
  } catch {
    refuse(response, "unsupported");
  }

  const text = new Uint8Array(await unpack(await body(response, SUBTITLE_TEXT_LIMIT, timeout)));

  try {
    return {
      service: "subdl",
      language: candidate.language,
      release: candidate.release.slice(0, 1024),
      hearingImpaired: candidate.hearingImpaired,
      cues: [...subtitleTextBytes(text, candidate.language)],
    };
  } catch {
    throw new SubtitleFailure("unsupported");
  }
}

/** Leaves `response` unread and fails with `reason`. */
function refuse(response: Response, reason: SubtitleFailureReason): never {
  void response.body?.cancel().catch(() => {});
  throw new SubtitleFailure(reason);
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
