import type { SeriesDetails, Title, TitleDetails } from "@mrstreamer/contracts/ondemand";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Title and season details a launch shows from the phone: titles.ts and the records it saves in
// Caches/details, over real files (`native-files.ts`). The desktop tests' fake Xtream panel and
// fake TMDB answer over HTTP; a panel's details can be held or rewritten on their way, as a slow
// provider or one that sends other text would. The Keychain is kept in memory across launches,
// which re-import the app's modules as a relaunch starts them.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** Each request to a panel: its `action`, or "login" for the login check. */
  requests: [] as string[],
  /** Details requests held until a test lets them through. */
  heldDetails: [] as Array<() => void>,
  holdDetails: false,
  /** Changes a details answer on its way to the app. */
  details: null as null | ((body: Record<string, unknown>) => Record<string, unknown>),
  /** Passwords a panel takes for its own, as one whose password was changed. */
  aliases: [] as Array<readonly [alias: string, password: string]>,
  /** Details requests whose address holds this answer 503, as for a login the panel refuses. */
  failing: null as string | null,
  /** TMDB's address: its requests pass untouched. */
  tmdb: "",
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void memory.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void memory.keychain.delete(key),
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

const DETAILS = new Set(["get_vod_info", "get_series_info"]);
const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  if (memory.tmdb && input.startsWith(memory.tmdb)) return passThrough(input, init);
  const url = memory.aliases.reduce(
    (each, [alias, password]) =>
      each.replaceAll(encodeURIComponent(alias), encodeURIComponent(password)),
    input,
  );
  const action = new URL(url).searchParams.get("action") ?? "login";
  memory.requests.push(action);
  if (!DETAILS.has(action)) return passThrough(url, init);
  if (memory.holdDetails) await new Promise<void>((go) => memory.heldDetails.push(go));
  if (memory.failing && input.includes(memory.failing)) return new Response(null, { status: 503 });
  const response = await passThrough(url, init);
  const rewrite = memory.details;
  if (!rewrite || !response.ok) return response;
  return Response.json(rewrite((await response.json()) as Record<string, unknown>));
});

const { native } = await import("./native-files.ts");

interface FakeProvider {
  readonly url: string;
  readonly titles: FakeTitles;
  detailRequests(): number;
  failDetails(status: number | null): void;
  serveTitles(select: (all: FakeTitles) => FakeTitles): void;
  close(): Promise<void>;
}
interface FakeTitles {
  readonly series: readonly {
    readonly id: number;
    readonly seasons: readonly (readonly { readonly container: string }[])[];
  }[];
}
interface FakeTmdb {
  readonly url: string;
  aboutRequests(): number;
  seasonRequests(): readonly string[];
  failSeasons(answer: number | "hold" | null): void;
  refuse(refused: boolean): void;
  close(): Promise<void>;
}
/** The fakes are typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const FAKE_TMDB = "../../desktop/test/fake-tmdb.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
  }): Promise<FakeProvider>;
};
const { startFakeTmdb } = (await import(FAKE_TMDB)) as { startFakeTmdb(): Promise<FakeTmdb> };

const ONE = { username: "canaryuser", password: "canary+Pw@1" };
let panel: FakeProvider;
let tmdb: FakeTmdb;
beforeAll(async () => {
  [panel, tmdb] = await Promise.all([
    startFakeProvider({ ...ONE, channels: 4, titles: 12 }),
    startFakeTmdb(),
  ]);
});
afterAll(async () => {
  await Promise.all([panel.close(), tmdb.close()]);
});

const folder = join(native.root, "cache", "details");
/** Every record saved, by its path under Caches/details. */
function records(at = folder, under = ""): string[] {
  if (!existsSync(at)) return [];
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? records(join(at, entry.name), `${under}${entry.name}/`)
      : [`${under}${entry.name}`],
  );
}
const providerRecords = () => records().filter((path) => path.startsWith("providers/"));
const textOf = (path: string) => readFileSync(join(folder, path), "utf8");
const settle = (ms = 100) => new Promise((done) => setTimeout(done, ms));
const detailsAskedSince = (from: number) =>
  memory.requests.slice(from).filter((action) => DETAILS.has(action)).length;

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what = "the condition") {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it, with TMDB or without: fresh modules over the same files. */
async function launch({ withTmdb = false } = {}) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TMDB_KEY", withTmdb ? "test-key" : "");
  vi.stubEnv("EXPO_PUBLIC_TMDB_API", tmdb.url);
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  await account.restore();
  return { ...titles, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

/** Waits for the movie and series lists, then answers the first of `kind` TMDB knows. */
async function first(app: App, kind: "movie" | "series"): Promise<Title> {
  await until(() => app.titleLists().kind === "ready", "the movie and series lists");
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No lists");
  const found = kindOf(lists.index, kind).titles.find((title) => title.tmdbId && !title.adult);
  if (!found) throw new Error(`No ${kind}`);
  return found;
}

const seriesOf = (details: TitleDetails): SeriesDetails => {
  if (details.kind !== "series") throw new Error("Not a series");
  return details;
};

/** Adds the panel's account and waits for its lists. */
async function added(app: App) {
  const id = await app.add({ server: panel.url, ...ONE });
  if (!id) throw new Error("The add was cancelled");
  await until(() => app.titleLists().kind === "ready", "the movie and series lists");
  return id;
}

/** Opens `title`'s details and waits until its provider record is saved. */
async function opened(app: App, title: Title) {
  const details = await app.detailsOf(title);
  await until(
    () => providerRecords().some((path) => path.endsWith(`/${title.kind}.${title.id}.json`)),
    "the saved record",
  );
  return details;
}

const plotOf = (body: Record<string, unknown>, plot: string) => ({
  ...body,
  info: { ...(body["info"] as Record<string, unknown>), plot },
});

beforeEach(() => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  rmSync(join(native.root, "cache"), { recursive: true, force: true });
  native.gate = null;
  native.undeletable = null;
  native.sizeOf = null;
  memory.aliases = [];
  memory.keychain.clear();
  memory.requests.length = 0;
  memory.holdDetails = false;
  memory.details = null;
  memory.failing = null;
  memory.tmdb = tmdb.url;
  panel.failDetails(null);
  panel.serveTitles((all) => all);
  tmdb.failSeasons(null);
  tmdb.refuse(false);
});
beforeEach(async () => {
  const { Directory, Paths } = await import("./native-files.ts");
  for (const each of [Paths.document, Paths.cache])
    new Directory(each).create({ idempotent: true });
});
afterEach(() => {
  for (const go of memory.heldDetails.splice(0)) go();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("details saved on the phone", () => {
  it("show again after a restart without asking the provider or TMDB", async () => {
    const app = await launch({ withTmdb: true });
    await added(app);
    const movie = await first(app, "movie");
    const series = await first(app, "series");
    const shownMovie = await opened(app, movie);
    const shownSeries = seriesOf(await opened(app, series));
    const [season] = shownSeries.seasons;
    if (!season) throw new Error("No season");
    const episodes = await app.episodesOf(series, season);
    await until(() => records().some((path) => path.startsWith("tmdb/season.")), "the season");
    expect(shownMovie.plot).toMatch(/^TMDB's story of/u);
    expect(episodes.some((episode) => episode.plot?.startsWith("TMDB's story"))).toBe(true);

    const fromPanel = memory.requests.length;
    const abouts = tmdb.aboutRequests();
    const seasonsAsked = tmdb.seasonRequests().length;
    panel.failDetails(503);
    const again = await launch({ withTmdb: true });
    const movieAgain = await first(again, "movie");
    const seriesAgain = await first(again, "series");
    expect(await again.detailsOf(movieAgain)).toMatchObject({ plot: shownMovie.plot });
    const seasonAgain = seriesOf(await again.detailsOf(seriesAgain)).seasons[0];
    if (!seasonAgain) throw new Error("No season");
    expect(seasonAgain.episodes.map((each) => each.id)).toEqual(
      season.episodes.map((each) => each.id),
    );
    expect(await again.episodesOf(seriesAgain, seasonAgain)).toEqual(episodes);
    expect(detailsAskedSince(fromPanel)).toBe(0);
    expect(tmdb.aboutRequests()).toBe(abouts);
    expect(tmdb.seasonRequests().length).toBe(seasonsAsked);
  });

  it("ask the provider again after a day, keeping the saved facts when it fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const app = await launch();
    await added(app);
    memory.details = (body) => plotOf(body, "Saved story.");
    await opened(app, await first(app, "movie"));

    vi.setSystemTime(start + 25 * 60 * 60 * 1000);
    panel.failDetails(503);
    const later = await launch();
    const movie = await first(later, "movie");
    const from = memory.requests.length;
    expect(await later.detailsOf(movie)).toMatchObject({ plot: "Saved story." });
    expect(detailsAskedSince(from)).toBe(1);

    // The next open asks again, and the provider's answer replaces the saved one.
    panel.failDetails(null);
    memory.details = (body) => plotOf(body, "New story.");
    expect(await later.detailsOf(movie)).toMatchObject({ plot: "New story." });
    expect(detailsAskedSince(from)).toBe(2);
    await until(
      () => providerRecords().some((path) => textOf(path).includes("New story.")),
      "the new answer saved",
    );
  });

  it("ask TMDB again at the next open after a season or about failed", async () => {
    const app = await launch({ withTmdb: true });
    await added(app);
    const series = await first(app, "series");
    tmdb.refuse(true);
    // The provider's facts show when TMDB doesn't answer.
    expect(await app.detailsOf(series)).toMatchObject({
      plot: expect.stringMatching(/^All about/u),
    });
    tmdb.refuse(false);
    const known = seriesOf(await app.detailsOf(series));
    expect(known.plot).toMatch(/^TMDB's story of/u);

    const [season] = known.seasons;
    if (!season) throw new Error("No season");
    tmdb.failSeasons(503);
    const plain = await app.episodesOf(series, season);
    tmdb.failSeasons(null);
    const told = await app.episodesOf(series, season);
    expect(told).not.toEqual(plain);
    expect(told.some((episode) => episode.plot?.startsWith("TMDB's story"))).toBe(true);
  });

  it("never save the password, nor artwork addresses that carry the login", async () => {
    const app = await launch();
    await added(app);
    const movie = await first(app, "movie");
    const series = await first(app, "series");
    memory.details = (body) =>
      "movie_data" in body ? plotOf(body, `Login ${ONE.password} inside.`) : body;
    await app.detailsOf(movie);
    memory.details = (body) => ({
      ...body,
      episodes: Object.fromEntries(
        Object.entries(body["episodes"] as Record<string, Record<string, unknown>[]>).map(
          ([season, episodes]) => [
            season,
            episodes.map((episode) => ({
              ...episode,
              info: {
                ...(episode["info"] as Record<string, unknown>),
                movie_image: `${panel.url}/still.php?username=${ONE.username}&password=${encodeURIComponent(ONE.password)}`,
              },
            })),
          ],
        ),
      ),
    });
    await opened(app, series);
    await settle();

    expect(providerRecords().some((path) => path.endsWith(`/movie.${movie.id}.json`))).toBe(false);
    const [saved] = providerRecords();
    if (!saved) throw new Error("Nothing saved");
    const record = JSON.parse(textOf(saved)) as {
      value: { episodes: { stillUrl: string | null }[] };
    };
    expect(record.value.episodes.length).toBeGreaterThan(0);
    expect(record.value.episodes.every((episode) => episode.stillUrl === null)).toBe(true);
    for (const path of records()) {
      const text = textOf(path);
      for (const canary of [ONE.username, ONE.password, encodeURIComponent(ONE.password)]) {
        expect(text).not.toContain(canary);
      }
    }
  });
});

describe("playback", () => {
  it("asks the provider where an episode streams from, never a saved record", async () => {
    const app = await launch();
    await added(app);
    const series = await first(app, "series");
    const [episode] = seriesOf(await opened(app, series)).seasons[0]?.episodes ?? [];
    if (!episode) throw new Error("No episode");
    const listed = panel.titles.series.find((each) => String(each.id) === series.id);
    const before = listed?.seasons[0]?.[0]?.container;
    const other = before === "mkv" ? "avi" : "mkv";
    panel.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) =>
        each.id === listed?.id
          ? {
              ...each,
              seasons: each.seasons.map((s) => s.map((file) => ({ ...file, container: other }))),
            }
          : each,
      ),
    }));

    const again = await launch();
    const shown = await again.detailsOf(await first(again, "series"));
    const from = memory.requests.length;
    expect(seriesOf(shown).seasons[0]?.episodes[0]?.id).toBe(episode.id);
    expect(detailsAskedSince(from)).toBe(0);
    const ref = {
      kind: "episode" as const,
      subscriptionId: episode.subscriptionId,
      id: episode.id,
      seriesId: episode.seriesId,
      season: episode.season,
      episode: episode.number,
    };
    const file = await again.titleFile(ref, AbortSignal.timeout(5_000));
    expect(detailsAskedSince(from)).toBe(1);
    expect(file.url.endsWith(`.${other}`)).toBe(true);
  });
});

describe("a login replaced or removed", () => {
  it("never shows or saves what the old password read once a new one is saved", async () => {
    const NEW = "canaryNew9";
    memory.aliases = [[NEW, ONE.password]];
    const app = await launch();
    const id = await added(app);
    const series = await first(app, "series");
    memory.holdDetails = true;
    memory.details = (body) => plotOf(body, "Old login's story.");
    const reading = app.detailsOf(series);
    await until(() => memory.heldDetails.length === 1, "the details request");

    await app.update(id, { password: NEW });
    // The new login's read fails: only the old one's answer could show or be saved.
    memory.failing = encodeURIComponent(NEW);
    memory.holdDetails = false;
    for (const go of memory.heldDetails.splice(0)) go();
    await expect(reading).rejects.toBeDefined();
    await settle();
    expect(providerRecords()).toEqual([]);
  });

  it("never shows, saves or plays from a read under the old password", async () => {
    const NEW = "canaryNew9";
    memory.aliases = [[NEW, ONE.password]];
    const app = await launch();
    const id = await added(app);
    const series = await first(app, "series");
    memory.holdDetails = true;
    memory.details = (body) => plotOf(body, "Old login's story.");
    const reading = app.detailsOf(series);
    await until(() => memory.heldDetails.length === 1, "the details request");

    await app.update(id, { password: NEW });
    // The new login's lists, saved, before the read under the old one answers.
    await until(
      () => app.members()[0]?.titles.kind === "ready" && app.members()[0]?.account !== null,
      "the new login's lists",
    );
    await settle();
    memory.details = null;
    memory.holdDetails = false;
    for (const go of memory.heldDetails.splice(0)) go();
    const shown = seriesOf(await reading);
    expect(shown.plot).not.toBe("Old login's story.");
    await until(() => providerRecords().length === 1, "the new login's record");
    await settle();
    expect(providerRecords().every((path) => !textOf(path).includes("Old login"))).toBe(true);

    const [episode] = shown.seasons[0]?.episodes ?? [];
    if (!episode) throw new Error("No episode");
    const file = await app.titleFile(
      {
        kind: "episode",
        subscriptionId: id,
        id: episode.id,
        seriesId: episode.seriesId,
        season: episode.season,
        episode: episode.number,
      },
      AbortSignal.timeout(5_000),
    );
    expect(file.url).toContain(encodeURIComponent(NEW));
    expect(file.url).not.toContain(encodeURIComponent(ONE.password));

    const again = await launch();
    const from = memory.requests.length;
    expect(await again.detailsOf(await first(again, "series"))).toMatchObject({ plot: shown.plot });
    expect(detailsAskedSince(from)).toBe(0);
  });

  it("keeps the old password when its saved details can't be deleted", async () => {
    memory.aliases = [["canaryNew9", ONE.password]];
    const app = await launch();
    const id = await added(app);
    await opened(app, await first(app, "movie"));
    native.undeletable = (path) => path.includes(`${join("details", "providers")}`);
    await expect(app.update(id, { password: "canaryNew9" })).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(memory.keychain.get(`s.${id}`)).toBe(ONE.password);
  });

  for (const keepHistory of [true, false]) {
    it(`deletes its details when removed ${keepHistory ? "with" : "without"} its history`, async () => {
      const app = await launch({ withTmdb: true });
      const id = await added(app);
      await opened(app, await first(app, "movie"));
      const series = await first(app, "series");
      memory.holdDetails = true;
      const late = app.detailsOf(series);
      await until(() => memory.heldDetails.length === 1, "the details request");

      await app.remove(id, { keepHistory });
      memory.holdDetails = false;
      for (const go of memory.heldDetails.splice(0)) go();
      await expect(late).rejects.toBeDefined();
      await settle();
      expect(providerRecords()).toEqual([]);
      // TMDB's answers are shared by every subscription, as its list metadata is.
      expect(records().some((path) => path.startsWith("tmdb/about."))).toBe(true);
    });
  }
});

describe("the records", () => {
  it("treat a corrupt record as missing, and delete it", async () => {
    const app = await launch();
    await added(app);
    const movie = await first(app, "movie");
    await opened(app, movie);
    const [path] = providerRecords();
    if (!path) throw new Error("Nothing saved");
    writeFileSync(join(folder, path), "{not json");

    const again = await launch();
    const from = memory.requests.length;
    panel.failDetails(503);
    await expect(again.detailsOf(await first(again, "movie"))).rejects.toBeDefined();
    expect(detailsAskedSince(from)).toBe(1);
    expect(providerRecords()).toEqual([]);
  });

  it("stay within their budget, the least recently written going first", async () => {
    const app = await launch();
    await added(app);
    await until(() => app.titleLists().kind === "ready", "the lists");
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No lists");
    const movies = kindOf(lists.index, "movie").titles.slice(0, 9);
    expect(movies).toHaveLength(9);
    // Each provider record reports 8 MiB: eight fill the 64 MiB the records may take.
    native.sizeOf = (path) =>
      path.includes(join("details", "providers")) ? 8 * 1024 * 1024 : undefined;
    const written: string[] = [];
    for (const [at, movie] of movies.entries()) {
      await opened(app, movie);
      const path = providerRecords().find((each) => each.endsWith(`/movie.${movie.id}.json`));
      if (!path) throw new Error("Not saved");
      written.push(path);
      const time = new Date(Date.now() - (movies.length - at) * 60_000);
      utimesSync(join(folder, path), time, time);
    }
    expect(providerRecords().toSorted()).toEqual(written.slice(1).toSorted());
  });
});
