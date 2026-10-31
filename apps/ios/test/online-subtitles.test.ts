import type { ObservedSubtitleTrack, ObservedTrackSnapshot } from "expo-video";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keychain as keychainStore } from "./keychain.ts";
import { nativePlayer } from "./native-player.ts";
import type { SubtitleTitle } from "../src/downloaded-subtitles.ts";

// The real online-subtitle and playback owners against a SubDL stand-in: what a search sends, what
// a chosen result keeps and shows, which play it belongs to, and the file's own tracks around it.
const port = nativePlayer();
const keychain = new Map<string, string>();
let locked = false;
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
vi.mock("expo-secure-store", () =>
  keychainStore(() => {
    if (locked) throw new Error("The Keychain is locked");
    return keychain;
  }),
);
const { native } = await import("./native-files.ts");
const { File, Directory, Paths } = await import("expo-file-system");
const online = {
  ...(await import("../src/downloaded-subtitles.ts")),
  ...(await import("../src/online-subtitles.ts")),
};
const { play, stop, trackChoices } = await import("../src/playback.ts");
const preferences = await import("../src/media-preferences.ts");

const SRT =
  "1\n00:00:01,000 --> 00:00:04,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,000\nGoodbye\n";
const requests: URL[] = [];
let answer: (url: URL) => Response | Promise<Response>;

const searchReply = (tmdbId: number, kind: "movie" | "tv", subtitles: unknown[]) =>
  Response.json({ status: true, results: [{ tmdb_id: tmdbId, type: kind }], subtitles });
const movieResult = {
  language: "EN",
  release_name: "Movie.2001.1080p",
  url: "/subtitle/1-2.zip",
  hi: true,
};

const movie = () =>
  online.subtitleTitle({
    subscriptionId: "sub-1",
    id: "m1",
    tmdbId: "550",
    title: "Movie",
    year: 2001,
  });
const item = (subtitles = movie()) => ({
  id: "sub-1:m1",
  subscriptionId: "sub-1",
  title: "Movie",
  place: "2001",
  live: false,
  next: false,
  versions: false,
  subtitles,
});
const open = (playing: ReturnType<typeof item>) =>
  play(
    playing,
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "file:movie.mp4", container: "mp4" }),
    },
    { watch: true, login: ["provider-password"] },
  );

/** Searches and chooses the first result for `title`, as Watch's sheets would. */
async function chooseFirst(title: SubtitleTitle) {
  const found = await online.findSubtitles(title);
  if (found?.kind !== "found") throw new Error(`Search: ${JSON.stringify(found)}`);
  return online.chooseSubtitle(title, found.results[0]!.id);
}

beforeEach(async () => {
  await stop();
  keychain.clear();
  requests.length = 0;
  const folder = new Directory(Paths.document, "online-subtitles");
  if (folder.exists) folder.delete();
  preferences.updateMediaPreferences("titleLanguage", "nl");
  preferences.updateMediaPreferences("subtitles", { kind: "forced-only" });
  answer = (url) =>
    url.hostname === "api.subdl.com"
      ? searchReply(550, "movie", [movieResult])
      : new Response(zipSync({ "Movie.2001.srt": strToU8(SRT), "readme.txt": strToU8("hi") }));
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(input);
    requests.push(url);
    return answer(url);
  });
  await online.saveSubtitleKey(" my-key ");
});
afterEach(() => {
  vi.unstubAllGlobals();
  native.sync = null;
  locked = false;
  return stop();
});

describe("searching SubDL", () => {
  it("sends the key, TMDB identity and languages only, and lists matching results", async () => {
    // Only the play the search is for finds anything: an identity of another play finds nothing.
    const playing = await openTitle();
    expect(await online.findSubtitles(movie())).toBeNull();
    const results = await online.findSubtitles(playing);
    expect(results).toEqual({
      kind: "found",
      results: [
        {
          id: expect.any(String),
          language: "en",
          release: "Movie.2001.1080p",
          hearingImpaired: true,
        },
      ],
    });
    const search = requests.at(-1)!;
    expect(search.origin + search.pathname).toBe("https://api.subdl.com/api/v1/subtitles");
    expect(Object.fromEntries(search.searchParams)).toEqual({
      api_key: "my-key",
      tmdb_id: "550",
      year: "2001",
      type: "movie",
      languages: "NL,EN",
      subs_per_page: "30",
      unpack: "1",
      client: "custom_integration",
    });
    expect(search.href).not.toContain("provider-password");
  });

  it("asks by title and year without a TMDB id, in the viewer's subtitle language first", async () => {
    preferences.updateMediaPreferences("subtitles", { kind: "language", language: "de" });
    const untitled = online.subtitleTitle({
      subscriptionId: "sub-1",
      id: "m9",
      tmdbId: null,
      title: "Some Movie",
      year: 1999,
    });
    const titled = (name?: string, year?: number) => () =>
      Response.json({
        status: true,
        results: [{ type: "movie", name, year }],
        subtitles: [{ ...movieResult, language: "DE" }],
      });
    answer = titled("Some movie", 1999);
    await open({ ...item(untitled), id: "sub-1:m9" });
    const found = await online.findSubtitles(untitled);
    expect(found?.kind === "found" && found.results.map((each) => each.language)).toEqual(["de"]);
    const search = requests.at(-1)!.searchParams;
    expect(search.get("film_name")).toBe("Some Movie");
    expect(search.get("year")).toBe("1999");
    expect(search.has("tmdb_id")).toBe(false);
    expect(search.get("languages")).toBe("DE,NL,EN");
    // SubDL broadens a title it can't match: another title, year or none is another movie's.
    for (const broadened of [
      titled("Some Other Movie", 1999),
      titled("Some Movie", 2000),
      titled("Some Movie"),
      titled(),
    ]) {
      answer = broadened;
      expect(await online.findSubtitles(untitled)).toEqual({ kind: "found", results: [] });
    }
  });

  it("asks for an episode by its series, season and number, and keeps only that episode", async () => {
    const episode = online.subtitleTitle({
      subscriptionId: "sub-1",
      id: "e9",
      tmdbId: "1399",
      title: "Series",
      year: null,
      episode: { season: 2, number: 3 },
    });
    answer = () =>
      searchReply(1399, "tv", [
        {
          language: "EN",
          url: "/subtitle/pack.zip",
          full_season: true,
          unpack_files: [
            {
              language: "EN",
              name: "S02E03.srt",
              season: 2,
              episode: 3,
              format: "srt",
              url: "/s/23.srt",
            },
            {
              language: "EN",
              name: "S02E03.elsewhere.srt",
              season: 2,
              episode: 3,
              format: "srt",
              url: "https://elsewhere.example/s/23.srt",
            },
            {
              language: "EN",
              name: "S02E04.srt",
              season: 2,
              episode: 4,
              format: "srt",
              url: "/s/24.srt",
            },
          ],
        },
      ]);
    await open({ ...item(episode), id: "sub-1:e9" });
    const found = await online.findSubtitles(episode);
    expect(found?.kind === "found" && found.results.map((each) => each.release)).toEqual([
      "S02E03.srt",
    ]);
    expect(requests.at(-1)!.searchParams.get("season_number")).toBe("2");
    expect(requests.at(-1)!.searchParams.get("episode_number")).toBe("3");
    // Without a TMDB id the series is known by its name alone, whatever year SubDL gives it.
    const untitled = online.subtitleTitle({
      subscriptionId: "sub-1",
      id: "e8",
      tmdbId: null,
      title: "Series",
      year: 2011,
      episode: { season: 2, number: 3 },
    });
    answer = () =>
      Response.json({
        status: true,
        results: [{ type: "tv", name: "Series", year: 2015 }],
        subtitles: [{ ...movieResult, season: 2, episode: 3 }],
      });
    await open({ ...item(untitled), id: "sub-1:e8" });
    const named = await online.findSubtitles(untitled);
    expect(named?.kind === "found" && named.results.length).toBe(1);
    expect(requests.at(-1)!.searchParams.has("year")).toBe(false);
  });

  it("names each service failure without its message, and asks for nothing without a key", async () => {
    const playing = await openTitle();
    for (const [status, reason] of [
      [403, "credentials"],
      [429, "quota"],
      [500, "unavailable"],
    ] as const) {
      answer = () => new Response("https://api.subdl.com/?api_key=my-key", { status });
      expect(await online.findSubtitles(playing)).toEqual({ kind: "failed", reason });
    }
    answer = () =>
      Response.json({
        status: true,
        results: [{ tmdb_id: 551, type: "movie" }],
        subtitles: [movieResult],
      });
    expect(await online.findSubtitles(playing)).toEqual({ kind: "found", results: [] });
    await online.removeSubtitleKey();
    const before = requests.length;
    expect(await online.findSubtitles(playing)).toEqual({
      kind: "failed",
      reason: "not-configured",
    });
    expect(requests.length).toBe(before);
  });

  it("says when the Keychain won't give the key, and takes nothing a redirect led elsewhere", async () => {
    const playing = await openTitle();
    locked = true;
    expect(await online.findSubtitles(playing)).toEqual({ kind: "failed", reason: "keychain" });
    locked = false;
    const from = (where: string, response: Response) =>
      Object.defineProperty(response, "url", { value: where });
    answer = () => from("https://elsewhere.example/api", searchReply(550, "movie", [movieResult]));
    expect(await online.findSubtitles(playing)).toEqual({ kind: "failed", reason: "unavailable" });
    answer = (url) =>
      url.hostname === "api.subdl.com"
        ? searchReply(550, "movie", [movieResult])
        : from("https://elsewhere.example/1.srt", new Response(SRT));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    expect(online.shownSubtitle()).toBeNull();
  });

  it("ends a search when another play begins, and its results can't be chosen for the next", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = await openTitle();
    vi.stubGlobal("fetch", async (input: URL | string) => {
      await held;
      return answer(new URL(input));
    });
    const searching = online.findSubtitles(first);
    const second = await openTitle();
    release();
    expect(await searching).toBeNull();
    expect(await online.chooseSubtitle(second, "1.0")).toBeNull();
    expect(online.shownSubtitle()).toBeNull();
  });

  it("chooses only from the latest search, whatever an older one numbered", async () => {
    const playing = await openTitle();
    const older = await online.findSubtitles(playing);
    await online.findSubtitles(playing);
    const id = older?.kind === "found" ? older.results[0]!.id : "";
    expect(await online.chooseSubtitle(playing, id)).toBeNull();
    expect(online.shownSubtitle()).toBeNull();
  });
});

describe("a chosen result", () => {
  it("shows the one subtitle of a ZIP file, timed as moved, and again for the next play of that version", async () => {
    const playing = await openTitle();
    expect(await chooseFirst(playing)).toEqual({ kind: "shown" });
    const shown = online.shownSubtitle()!;
    expect(shown.subtitle.release).toBe("Movie.2001.1080p");
    expect(requests.at(-1)!.href).toBe("https://dl.subdl.com/subtitle/1-2.zip");
    expect(online.cuesAt(shown, 2)).toEqual(["Hello there"]);
    expect(online.cuesAt(shown, 4.5)).toEqual([]);
    expect(online.nextCueChange(shown, 4.5)).toBe(5);

    expect(online.retimeSubtitle(playing, { offset: 1.5, speed: 1 })).toBe(true);
    expect(online.retimeSubtitle(playing, { offset: 900, speed: 1 })).toBe(false);
    const moved = online.shownSubtitle()!;
    expect(online.cuesAt(moved, 2)).toEqual([]);
    expect(online.cuesAt(moved, 3)).toEqual(["Hello there"]);
    expect(online.nextCueChange(moved, 3)).toBe(5.5);

    // Offline, with nothing asked of SubDL: the next play of the version shows it as timed.
    const asked = requests.length;
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    await stop();
    expect(online.shownSubtitle()).toBeNull();
    const again = await openTitle();
    expect(online.shownSubtitle()).toMatchObject({
      title: again,
      timing: { offset: 1.5, speed: 1 },
    });
    expect(requests.length).toBe(asked);
    // A downloaded copy of the version is the same version.
    const copy = online.subtitleTitle({
      subscriptionId: "sub-1",
      id: "m1",
      tmdbId: null,
      title: "Movie",
      year: 2001,
    });
    await open({ ...item(copy), id: "copy:7", subscriptionId: null as never });
    expect(online.shownSubtitle()?.title).toBe(copy);
  });

  it("belongs to its exact version only, and converts its frame rate as timed", async () => {
    const playing = await openTitle();
    await chooseFirst(playing);
    const ratio = 25 / 23.976;
    expect(online.retimeSubtitle(playing, { offset: 0, speed: ratio })).toBe(true);
    const converted = online.shownSubtitle()!;
    expect(online.cuesAt(converted, 1.03)).toEqual([]);
    expect(online.cuesAt(converted, 1.05)).toEqual(["Hello there"]);
    expect(online.nextCueChange(converted, 0)).toBeCloseTo(ratio);

    const other = online.subtitleTitle({
      subscriptionId: "sub-1",
      id: "m2",
      tmdbId: "550",
      title: "Movie",
      year: 2001,
    });
    await open({ ...item(other), id: "sub-1:m2" });
    expect(online.shownSubtitle()).toBeNull();
    expect(online.keptSubtitle(other)).toBeNull();
  });

  it("takes WebVTT as it is, and refuses an empty, crowded or oversized download", async () => {
    const playing = await openTitle();
    const serving = (file: () => Response) => {
      answer = (url) =>
        url.hostname === "api.subdl.com" ? searchReply(550, "movie", [movieResult]) : file();
    };
    serving(() => new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n"));
    expect(await chooseFirst(playing)).toEqual({ kind: "shown" });
    serving(() => new Response(zipSync({ "readme.txt": strToU8("none") })));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    const crowded = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`${i}.txt`, strToU8("x")]),
    );
    serving(() => new Response(zipSync({ ...crowded, "a.srt": strToU8(SRT) })));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    serving(() => new Response(SRT, { headers: { "content-length": String(11 * 1024 * 1024) } }));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    // A small ZIP file whose one subtitle unpacks past the limit.
    const huge = `1\n00:00:01,000 --> 00:00:02,000\n${"a".repeat(11 * 1024 * 1024)}\n`;
    serving(() => new Response(zipSync({ "big.srt": strToU8(huge) })));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    // Text with no subtitle in it, and a search answer that isn't JSON.
    serving(() => new Response("just words"));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    answer = () => new Response("<html>busy</html>");
    expect(await online.findSubtitles(playing)).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("refuses a ZIP file with several subtitles and a file from another host", async () => {
    const playing = await openTitle();
    answer = (url) =>
      url.hostname === "api.subdl.com"
        ? searchReply(550, "movie", [movieResult])
        : new Response(zipSync({ "a.srt": strToU8(SRT), "b.srt": strToU8(SRT) }));
    expect(await chooseFirst(playing)).toEqual({ kind: "failed", reason: "unsupported" });
    // A file elsewhere, or with no address at all, isn't listed; the search keeps the rest.
    answer = () =>
      searchReply(550, "movie", [
        { ...movieResult, url: "https://elsewhere.example/1.zip" },
        { ...movieResult, url: "https://dl.subdl.com:8443/1.zip" },
        { ...movieResult, url: "http://[" },
        { ...movieResult, release_name: "Movie.2001.720p", url: "/subtitle/3-4.zip" },
      ]);
    const found = await online.findSubtitles(playing);
    expect(found?.kind === "found" && found.results.map((each) => each.release)).toEqual([
      "Movie.2001.720p",
    ]);
    expect(online.shownSubtitle()).toBeNull();
  });
});

describe("the file's own subtitles", () => {
  let tracks: ObservedTrackSnapshot;
  const english = { kind: "language", language: "en" } as const;
  beforeEach(() => {
    preferences.updateMediaPreferences("subtitles", english);
    port.selectObservedTrackAsync.mockReset();
    port.selectObservedTrackAsync.mockImplementation(async (_expected, _revision, choice) => {
      if (choice.kind === "subtitles")
        tracks = { ...tracks, selectedSubtitleId: choice.track?.id ?? null };
      port.tracks = tracks;
      return { kind: "requested" };
    });
  });
  const withTracks = async () => {
    const playing = await openTitle();
    const identity = port.identity();
    const subtitles: ObservedSubtitleTrack[] = [0, 1].map((i) => ({
      ...identity,
      revision: 1,
      id: String(i),
      group: "subtitles",
      language: i === 0 ? "en" : "de",
      label: i === 0 ? "English" : "German",
      isDefault: false,
      isPlayable: true,
      forcedOnly: false,
    }));
    tracks = {
      ...identity,
      revision: 1,
      audio: { state: "absent", options: [] },
      subtitles: { state: "ready", options: subtitles },
      subtitleOffAllowed: true,
      selectedAudioId: null,
      selectedSubtitleId: "1",
    };
    port.tracks = tracks;
    await vi.waitFor(async () => expect(await checked()).toEqual(["English"]));
    return playing;
  };
  const checked = async () =>
    ((await trackChoices("subtitles")) ?? [])
      .filter((each) => each.selected)
      .map((each) => each.label);

  it("turn off while a downloaded one shows, and chosen over it hide it for the version, the preference untouched", async () => {
    const playing = await withTracks();
    await chooseFirst(playing);
    await vi.waitFor(async () => expect(await checked()).toEqual(["Off"]));
    expect(preferences.getMediaPreferences().subtitles).toEqual(english);
    await ((await trackChoices("subtitles")) ?? [])
      .find((each) => each.label === "German")
      ?.choose();
    await vi.waitFor(async () => expect(await checked()).toEqual(["German"]));
    expect(online.shownSubtitle()).toBeNull();
    expect(preferences.getMediaPreferences().subtitles).toEqual(english);

    const again = await openTitle();
    expect(online.shownSubtitle()).toBeNull();
    expect(online.keptSubtitle(again)?.subtitle.release).toBe("Movie.2001.1080p");
    expect(online.showKeptSubtitle(again)).toBe(true);
    expect(online.shownSubtitle()?.title).toBe(again);
  });

  it("chosen while a download runs stay chosen when the download ends before the native pick", async () => {
    const playing = await withTracks();
    const found = await online.findSubtitles(playing);
    const release = holdDownloads();
    const choosing = online.chooseSubtitle(
      playing,
      found?.kind === "found" ? found.results[0]!.id : "",
    );
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => (acknowledge = resolve));
    const select = port.selectObservedTrackAsync.getMockImplementation()!;
    port.selectObservedTrackAsync.mockImplementationOnce(async (...args) => {
      await acknowledged;
      return select(...args);
    });
    const picking = ((await trackChoices("subtitles")) ?? [])
      .find((each) => each.label === "German")
      ?.choose();
    release();
    expect(await choosing).toBeNull();
    acknowledge();
    await picking;
    await vi.waitFor(async () => expect(await checked()).toEqual(["German"]));
    expect(online.shownSubtitle()).toBeNull();
  });

  it("refused by the native player leave the downloaded one showing", async () => {
    const playing = await withTracks();
    await chooseFirst(playing);
    await vi.waitFor(async () => expect(await checked()).toEqual(["Off"]));
    port.selectObservedTrackAsync.mockImplementationOnce(async () => ({ kind: "stale" }));
    await ((await trackChoices("subtitles")) ?? [])
      .find((each) => each.label === "German")
      ?.choose();
    expect(online.shownSubtitle()?.title).toBe(playing);
    expect(online.keptSubtitle(playing)).not.toBeNull();
  });

  it("shown again from what was kept end a download under way", async () => {
    const playing = await withTracks();
    await chooseFirst(playing);
    await ((await trackChoices("subtitles")) ?? [])
      .find((each) => each.label === "German")
      ?.choose();
    await vi.waitFor(async () => expect(await checked()).toEqual(["German"]));
    answer = (url) =>
      url.hostname === "api.subdl.com"
        ? searchReply(550, "movie", [{ ...movieResult, release_name: "Other.Release" }])
        : new Response(SRT);
    const found = await online.findSubtitles(playing);
    const release = holdDownloads();
    const choosing = online.chooseSubtitle(
      playing,
      found?.kind === "found" ? found.results[0]!.id : "",
    );
    expect(online.showKeptSubtitle(playing)).toBe(true);
    release();
    expect(await choosing).toBeNull();
    expect(online.shownSubtitle()?.subtitle.release).toBe("Movie.2001.1080p");
  });

  it("chosen while a download runs end it, so it neither shows nor keeps", async () => {
    const playing = await withTracks();
    const found = await online.findSubtitles(playing);
    const release = holdDownloads();
    const choosing = online.chooseSubtitle(
      playing,
      found?.kind === "found" ? found.results[0]!.id : "",
    );
    await ((await trackChoices("subtitles")) ?? [])
      .find((each) => each.label === "German")
      ?.choose();
    await vi.waitFor(async () => expect(await checked()).toEqual(["German"]));
    release();
    expect(await choosing).toBeNull();
    expect(online.shownSubtitle()).toBeNull();
    expect(online.keptSubtitle(playing)).toBeNull();
  });
});

describe("keeping", () => {
  it("keeps the 100 versions changed last", async () => {
    const { utimesSync } = await import("node:fs");
    const keep = (id: string) => {
      const title = online.subtitleTitle({
        subscriptionId: "sub-1",
        id,
        tmdbId: null,
        title: "M",
        year: null,
      });
      online.playSubtitles(title);
      online.showDownloaded(title, {
        service: "subdl",
        language: "en",
        release: id,
        cues: [{ start: 1, end: 2, text: "x" }],
      });
      return title;
    };
    const first = keep("v0");
    const folder = new Directory(Paths.document, "online-subtitles");
    const [oldest] = folder.list();
    utimesSync(oldest!.uri.replace("file://", ""), new Date(2000, 0, 1), new Date(2000, 0, 1));
    for (let i = 1; i <= 100; i++) keep(`v${i}`);
    expect(folder.list()).toHaveLength(100);
    online.playSubtitles(first);
    expect(online.keptSubtitle(first)).toBeNull();
  });
});

describe("privacy", () => {
  it("keeps the key in the Keychain only, and erases a subscription's results with its history", async () => {
    const playing = await openTitle();
    await chooseFirst(playing);
    const folder = new Directory(Paths.document, "online-subtitles");
    const written = folder.list().map((each) => (each instanceof File ? each.textSync() : ""));
    expect(written).toHaveLength(1);
    expect(written.join()).not.toContain("my-key");
    expect([...keychain.values()]).toContain("my-key");
    // A reinstall clears every Keychain item the app wrote, this key with them.
    const { keychainSecrets } = await import("../src/secrets.ts");
    await keychainSecrets.clear();
    expect([...keychain.values()]).not.toContain("my-key");

    online.eraseSubtitles("sub-2");
    expect(folder.list()).toHaveLength(1);
    online.eraseSubtitles("sub-1");
    expect(folder.list()).toHaveLength(0);
    expect(online.shownSubtitle()).toBeNull();

    // A download under way, as for a copy that plays on without its provider, keeps nothing.
    const found = await online.findSubtitles(playing);
    const release = holdDownloads();
    const choosing = online.chooseSubtitle(
      playing,
      found?.kind === "found" ? found.results[0]!.id : "",
    );
    online.eraseSubtitles("sub-1");
    release();
    expect(await choosing).toBeNull();
    expect(folder.list()).toHaveLength(0);
  });
});

describe("a refused save", () => {
  it("keeps what was saved before, not the refused change, for the next play", async () => {
    const playing = await openTitle();
    await chooseFirst(playing);
    // The disk takes the new file, deletes the old one, then refuses the move.
    native.sync = (operation, path) => {
      if (operation === "move-after-delete" && path.includes("online-subtitles"))
        throw new Error("Disk full");
    };
    expect(online.retimeSubtitle(playing, { offset: 5, speed: 1 })).toBe(false);
    expect(online.shownSubtitle()?.timing.offset).toBe(0);
    native.sync = null;
    await openTitle();
    expect(online.shownSubtitle()).toMatchObject({
      timing: { offset: 0, speed: 1 },
      subtitle: { release: "Movie.2001.1080p" },
    });
  });
});

/** Holds SubDL's file answers until the returned function is called. */
function holdDownloads() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const answering = answer;
  answer = (url) =>
    url.hostname === "dl.subdl.com" ? held.then(() => answering(url)) : answering(url);
  return release;
}

/** Plays the movie anew, as each tap of Play does: a play of its own. */
async function openTitle() {
  const playing = item();
  await open(playing);
  return playing.subtitles;
}
