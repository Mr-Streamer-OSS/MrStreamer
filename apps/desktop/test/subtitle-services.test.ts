import { describe, expect, it, vi } from "vitest";
import { strToU8, Zip, ZipDeflate, zipSync } from "fflate";
import {
  subtitleServiceClient,
  type SubtitleCandidate,
} from "../src/main/subtitles/service-client.ts";

const keys = {
  subdl: { apiKey: "private-subdl-key" },
  opensubtitles: { apiKey: "private-open-key", username: "private-user", password: "private-pass" },
};
const signal = () => new AbortController().signal;
const srt = "1\n00:00:10,000 --> 00:00:12,000\nHallo\n\n";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const candidate: SubtitleCandidate = {
  service: "subdl",
  url: "https://dl.subdl.com/subtitle/file.zip",
  language: "nl",
  release: "Movie.1080p",
  hearingImpaired: false,
  downloads: null,
};

describe("online subtitle service ports", () => {
  it("SubDL searches by exact TMDB movie identity, normalizes service language names and downloads only a chosen result", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "dl.subdl.com") {
        expect(new Headers(init?.headers).has("Api-Key")).toBe(false);
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        expect(url.search).toBe("");
        return new Response(zipSync({ "movie.srt": strToU8(srt), "info.txt": strToU8("ignored") }));
      }
      expect(url.pathname).toBe("/api/v1/subtitles");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        api_key: keys.subdl.apiKey,
        tmdb_id: "123",
        type: "movie",
        languages: "EN,NL",
        unpack: "1",
      });
      expect(url.searchParams.has("file_name")).toBe(false);
      expect(url.searchParams.has("film_name")).toBe(false);
      return json({
        status: true,
        results: [{ tmdb_id: 123, type: "movie" }],
        subtitles: [
          { language: "Dutch", release_name: "Movie.1080p", url: "/subtitle/file.zip", hi: true },
          { lang: "EN", release_name: "Movie.WEB", url: "/subtitle/english.zip" },
          { language: "German", url: "/subtitle/other.zip" },
        ],
      });
    });
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    expect(request).not.toHaveBeenCalled();
    const results = await client.subdlSearch(
      keys.subdl,
      {
        kind: "movie",
        tmdbId: 123,
        languages: ["nl", "en", "nl"],
      },
      signal(),
    );
    expect(results.map(({ language }) => language)).toEqual(["nl", "en"]);
    expect(request).toHaveBeenCalledTimes(1);
    const downloaded = await client.download(results[0]!, keys, signal());
    expect(downloaded).toEqual({
      subtitle: {
        service: "subdl",
        language: "nl",
        release: "Movie.1080p",
        cues: [{ start: 10, end: 12, text: "Hallo" }],
      },
      quota: null,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses exact episode coordinates including specials and selects the episode file inside a season pack", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        type: "tv",
        tmdb_id: "456",
        season_number: "0",
        episode_number: "2",
      });
      return json({
        status: true,
        results: [{ tmdb_id: 456, type: "tv" }],
        subtitles: [
          {
            url: "/subtitle/pack.zip",
            full_season: true,
            unpack_files: [
              {
                name: "Special.1.srt",
                season: 0,
                episode: 1,
                format: "srt",
                language: "EN",
                url: "/subtitle/pack/one",
              },
              {
                name: "Special.2.srt",
                season: 0,
                episode: 2,
                format: "srt",
                language: "EN",
                url: "/subtitle/pack/two",
              },
            ],
          },
          { url: "/subtitle/wrong.zip", language: "EN", season: 1, episode: 2 },
        ],
      });
    });
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    expect(
      await client.subdlSearch(
        keys.subdl,
        {
          kind: "episode",
          tmdbId: 456,
          season: 0,
          episode: 2,
          languages: ["en"],
        },
        signal(),
      ),
    ).toEqual([
      {
        service: "subdl",
        language: "en",
        release: "Special.2.srt",
        hearingImpaired: false,
        downloads: null,
        url: "https://dl.subdl.com/subtitle/pack/two",
      },
    ]);
  });

  it("rejects a broadened SubDL title match and invalid queries without a download", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      json({
        status: true,
        results: [{ tmdb_id: 999, type: "movie" }],
        subtitles: [{ language: "EN", url: "/subtitle/wrong.zip" }],
      }),
    );
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    expect(
      await client.subdlSearch(
        keys.subdl,
        { kind: "movie", tmdbId: 123, languages: ["en"] },
        signal(),
      ),
    ).toEqual([]);
    await expect(
      client.subdlSearch(
        keys.subdl,
        { kind: "movie", tmdbId: 123, languages: ["private-name"] },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("OpenSubtitles search does not log in or download; choice logs in once and reports the service's actual remaining quota", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname === "/api/v1/subtitles") {
        expect(url.search).toBe(
          "?episode_number=2&languages=en%2Cnl&parent_tmdb_id=456&season_number=1&type=episode",
        );
        expect(headers.get("Api-Key")).toBe(keys.opensubtitles.apiKey);
        expect(headers.has("Authorization")).toBe(false);
        return json({
          data: [
            {
              attributes: {
                language: "nl",
                release: "Show.S01E02",
                hearing_impaired: true,
                download_count: 7,
                feature_details: { parent_tmdb_id: 456, season_number: 1, episode_number: 2 },
                files: [{ file_id: 10, file_name: "show.srt" }],
              },
            },
            {
              attributes: {
                language: "nl",
                release: "Wrong",
                feature_details: { parent_tmdb_id: 456, season_number: 2, episode_number: 2 },
                files: [{ file_id: 11, file_name: "wrong.srt" }],
              },
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/login") {
        expect(JSON.parse(String(init?.body))).toEqual({
          username: keys.opensubtitles.username,
          password: keys.opensubtitles.password,
        });
        return json({ token: "private-token", base_url: "vip-api.opensubtitles.com" });
      }
      if (url.pathname === "/api/v1/download") {
        expect(url.hostname).toBe("vip-api.opensubtitles.com");
        expect(headers.get("Authorization")).toBe("Bearer private-token");
        expect(JSON.parse(String(init?.body))).toEqual({ file_id: 10, sub_format: "srt" });
        return json({
          link: "https://www.opensubtitles.com/download/private-link",
          remaining: 3,
          reset_time_utc: "2026-10-09T00:00:00Z",
        });
      }
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Api-Key")).toBe(false);
      return new Response(srt);
    });
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    const results = await client.openSearch(
      keys.opensubtitles,
      { kind: "episode", tmdbId: 456, season: 1, episode: 2, languages: ["nl", "en"] },
      signal(),
    );
    expect(results).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    const downloaded = await client.download(results[0]!, keys, signal());
    expect(downloaded.subtitle.cues).toEqual([{ start: 10, end: 12, text: "Hallo" }]);
    expect(downloaded.quota).toEqual({ remaining: 3, resetAt: "2026-10-09T00:00:00Z" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 429])(
    "does not retry authentication or quota failure %s or expose response secrets",
    async (status) => {
      const request = vi.fn<typeof fetch>(
        async () => new Response("private-token private-pass", { status }),
      );
      const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
      await expect(
        client.openSearch(
          keys.opensubtitles,
          { kind: "movie", tmdbId: 123, languages: ["en"] },
          signal(),
        ),
      ).rejects.toMatchObject({ reason: status === 429 ? "quota" : "credentials" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "https://other.test/steal",
    "http://api.opensubtitles.com/api/v1/subtitles",
    "https://private-user:private-pass@api.opensubtitles.com/api/v1/subtitles",
    "https://api.opensubtitles.com:8443/api/v1/subtitles",
    "https://vip-api.opensubtitles.com/api/v1/subtitles",
  ])("refuses search redirects outside its original HTTPS origin: %s", async (location) => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location } });
    });
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    await expect(
      client.openSearch(
        keys.opensubtitles,
        { kind: "movie", tmdbId: 123, languages: ["en"] },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows up to two OpenSubtitles search redirects while keeping one request deadline", async () => {
    const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, signal: init?.signal });
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Api-Key")).toBe(keys.opensubtitles.apiKey);
      if (calls.length < 3)
        return new Response(null, {
          status: 301,
          headers: { location: `/api/v1/subtitles?canonical=${calls.length}` },
        });
      return json({ data: [] });
    });
    const client = subtitleServiceClient({ userAgent: "fixture", fetch: request });
    expect(
      await client.openSearch(
        keys.opensubtitles,
        { kind: "movie", tmdbId: 123, year: 2019, languages: ["nl", "en"] },
        signal(),
      ),
    ).toEqual([]);
    expect(calls.map(({ url }) => new URL(url).search)).toEqual([
      "?languages=en%2Cnl&tmdb_id=123&type=movie&year=2019",
      "?canonical=1",
      "?canonical=2",
    ]);
    expect(calls.every(({ signal }) => signal === calls[0]?.signal)).toBe(true);
  });

  it("stops a third search redirect", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: "/api/v1/subtitles?next=1" } }),
    );
    const client = subtitleServiceClient({ userAgent: "fixture", fetch: request });
    await expect(
      client.openSearch(
        keys.opensubtitles,
        { kind: "movie", tmdbId: 123, languages: ["en"] },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["login", "download"])(
    "does not follow an OpenSubtitles %s POST redirect",
    async (stage) => {
      const request = vi.fn<typeof fetch>(async (input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        if (stage === "download" && new URL(String(input)).pathname.endsWith("/login"))
          return json({ token: "private-token", base_url: "api.opensubtitles.com" });
        return new Response(null, { status: 307, headers: { location: "/api/v1/redirect" } });
      });
      const client = subtitleServiceClient({ userAgent: "fixture", fetch: request });
      await expect(
        client.download({ ...candidate, service: "opensubtitles", fileId: 10 }, keys, signal()),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(request).toHaveBeenCalledTimes(stage === "login" ? 1 : 2);
    },
  );

  it("requests both Portuguese regions and retains each matching service label", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).search).toBe(
        "?languages=en%2Cpt-br%2Cpt-pt&tmdb_id=123&type=movie",
      );
      return json({
        data: ["pt-BR", "pt-PT", "en", "de"].map((language, index) => ({
          attributes: {
            language,
            release: "Cinema cut",
            feature_details: { tmdb_id: 123 },
            files: [{ file_id: index + 1, file_name: "movie.srt" }],
          },
        })),
      });
    });
    const client = subtitleServiceClient({ userAgent: "fixture", fetch: request });
    const results = await client.openSearch(
      keys.opensubtitles,
      { kind: "movie", tmdbId: 123, languages: ["pt", "en"] },
      signal(),
    );
    expect(results.map(({ language }) => language)).toEqual(["pt-BR", "pt-PT", "en"]);
  });

  it("downloads the text from a macOS ZIP without treating resource forks as another subtitle", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          zipSync({
            "movie.srt": strToU8(srt),
            "__MACOSX/._movie.srt": strToU8("resource fork"),
            "._movie.srt": strToU8("resource fork"),
          }),
        ),
    );
    const client = subtitleServiceClient({ userAgent: "fixture", fetch: request });
    expect((await client.download(candidate, keys, signal())).subtitle.cues).toEqual([
      { start: 10, end: 12, text: "Hallo" },
    ]);
  });

  it("refuses unsafe download redirects, oversized streams, ambiguous ZIP files and unsupported text", async () => {
    const replies = [
      new Response(null, { status: 302, headers: { location: "https://other.test/file" } }),
      new Response("ignored", { headers: { "content-length": String(11 * 1024 * 1024) } }),
      new Response(zipSync({ "one.srt": strToU8(srt), "two.srt": strToU8(srt) })),
      new Response(zipSync({ "large.srt": strToU8("x".repeat(11 * 1024 * 1024)) })),
      new Response("Not a subtitle file"),
    ];
    const request = vi.fn<typeof fetch>(async () => replies.shift()!);
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    for (let i = 0; i < 5; i++)
      await expect(client.download(candidate, keys, signal())).rejects.toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("aborts a stalled subtitle body promptly without exposing fetch errors", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let reading: (() => void) | undefined;
    const bodyRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(strToU8("1\n"));
            },
            pull() {
              reading?.();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    const result = client.download(candidate, keys, controller.signal);
    await bodyRead;
    controller.abort(new DOMException("Viewer changed files", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    const bad = subtitleServiceClient({
      userAgent: "Mr. Streamer v0.0.9",
      fetch: async () => {
        throw new Error("private-key private-password https://private.test/file");
      },
    });
    await expect(
      bad.openSearch(
        keys.opensubtitles,
        { kind: "movie", tmdbId: 123, languages: ["en"] },
        signal(),
      ),
    ).rejects.toMatchObject({ message: "Subtitle service: unavailable." });
  });

  it("stops a compressed subtitle pack at the actual text limit even without sizes in its header", async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
    });
    const file = new ZipDeflate("movie.srt");
    zip.add(file);
    file.push(strToU8("x".repeat(11 * 1024 * 1024)), true);
    zip.end();
    const request = vi.fn<typeof fetch>(async () => new Response(Buffer.concat(chunks)));
    const client = subtitleServiceClient({ userAgent: "Mr. Streamer v0.0.9", fetch: request });
    await expect(client.download(candidate, keys, signal())).rejects.toMatchObject({
      reason: "unsupported",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("explicit title search fallback", () => {
  it("uses the title and year without guessing a TMDB id or sending a provider file name", async () => {
    const calls: URL[] = [];
    const client = subtitleServiceClient({
      userAgent: "fixture",
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.hostname === "api.subdl.com")
          return json({
            status: true,
            results: [{ type: "movie" }],
            subtitles: [
              { language: "EN", url: "/subtitle/fallback.srt", release_name: "Night.Harbour" },
            ],
          });
        return json({
          data: [
            {
              attributes: {
                language: "en",
                release: "Night.Harbour",
                feature_details: {},
                files: [{ file_id: 7, file_name: "harbour.srt" }],
              },
            },
          ],
        });
      },
    });
    const query = { kind: "movie" as const, title: "Night Harbour", year: 2019, languages: ["en"] };
    expect(await client.subdlSearch(keys.subdl, query, signal())).toHaveLength(1);
    expect(await client.openSearch(keys.opensubtitles, query, signal())).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.searchParams)).toMatchObject({
      film_name: "Night Harbour",
      year: "2019",
    });
    expect(calls[1]!.search).toBe("?languages=en&query=night+harbour&type=movie&year=2019");
    for (const url of calls) {
      expect(url.searchParams.has("tmdb_id")).toBe(false);
      expect(url.searchParams.has("file_name")).toBe(false);
    }
  });
});
