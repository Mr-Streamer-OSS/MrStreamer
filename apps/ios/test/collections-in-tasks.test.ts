import type { CollectionId, Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { TitleMetadata } from "@mrstreamer/core/metadata/tmdb";
import { indexCatalogue, kindOf, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import {
  collectionRows,
  collections,
  collectionSteps,
  type Collections,
  type CollectionSource,
  type ServiceTitles,
} from "@mrstreamer/core/ondemand/collections";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inTasks } from "../src/library.ts";

// The collections Movies, Series, Home and details show, made in short tasks: worked out between
// other tasks they hold what making them at once gives, with TMDB's metadata or without. The app's
// owner (titles.ts) makes them after the lists are indexed and whenever the metadata changes what
// they show, never while a screen draws: none until the first for the lists that show are made,
// the last made kept until newer ones are, and none made for lists that no longer show. Both
// paths agree on how long collections hold: until a title passes New's 7 or 30 days, metadata
// expires, the year turns or the clock goes back; the owner then makes them again. The
// subscriptions and TMDB's metadata store stand in at the owner's edges; tasks run as the app
// runs them.

const edges = vi.hoisted(() => ({
  members: [] as Array<{
    entry: { id: string };
    needsSecret: boolean;
    titles: { kind: "ready"; value: OnDemandCatalogue; took: number };
  }>,
  roster: new Set<() => void>(),
  /** What the metadata store answers: TMDB's metadata of each title, by kind and TMDB id. */
  known: null as ((kind: string, id: string) => TitleMetadata) | null,
  services: [] as ServiceTitles[],
  /** When the metadata store says each title's metadata, or the services without an id, expires. */
  expiry: null as ((kind: string, id?: string) => number) | null,
  /** The owner's notices of what the metadata store learned. */
  notify: null as ((change: { content: boolean }) => void) | null,
}));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: { cache: "/cache" } }));
vi.mock("../src/account.ts", () => ({
  members: () => edges.members,
  onRoster: (listener: () => void) => {
    edges.roster.add(listener);
    return () => edges.roster.delete(listener);
  },
  shownOf: (titles: { kind: string; value?: unknown }) =>
    titles.kind === "ready" ? titles.value : null,
}));
vi.mock("../src/sources.ts", () => ({ currentSource: () => undefined, sourceOf: () => null }));
vi.mock("../src/viewing.ts", () => ({ serveViewing: () => undefined }));
vi.mock("../src/watchlist.ts", () => ({ alignWatchlist: () => undefined }));
vi.mock("@mrstreamer/core/metadata/store", () => ({
  metadataStore: (deps: { onChange: (change: { content: boolean }) => void }) => {
    edges.notify = deps.onChange;
    return {
      get: (kind: string, id: string) => edges.known?.(kind, id) ?? null,
      name: () => null,
      searchName: () => "",
      services: () => edges.services,
      expiresAt: (kind: string, id?: string) => edges.expiry?.(kind, id) ?? Infinity,
      searchAliases: () => [],
      want: () => undefined,
      status: () => null,
    };
  },
}));

/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
interface FakeProvider {
  readonly url: string;
  readonly titles: unknown;
  serveTitles(select: (all: unknown) => unknown): void;
  close(): Promise<void>;
}
const { startFakeProvider, measurementTitles } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly titles: number;
  }): Promise<FakeProvider>;
  measurementTitles(all: unknown, anchor: number): { readonly titles: unknown };
};

/**
 * TMDB's metadata as the fake TMDB would give it: genres, popularity and a rating that follow
 * from the id, every third made in Dutch; `round` shifts popularity, as later answers change it.
 */
function tmdbOf(round: number) {
  return (_kind: string, id: string): TitleMetadata => {
    const n = Number(id);
    return {
      genres: [[28, 35], [35], [18, 80], [99]][n % 4] ?? [],
      language: n % 3 === 0 ? "nl" : "en",
      popularity: ((n * 7 + round * 13) % 100) + 1,
      rating: 5 + (n % 5),
      votes: n % 2 === 0 ? 200 : 10,
      collection: null,
      backdrop: null,
    };
  };
}

/** A streaming service that streams every fifth title of each kind's TMDB ids. */
const servicesOf = (index: IndexedCatalogue, kind: TitleKind): ServiceTitles[] => [
  {
    id: 8,
    name: "Netflix",
    ids: new Set(
      kindOf(index, kind).titles.flatMap((title, at) =>
        title.tmdbId && at % 5 === 0 ? [title.tmdbId] : [],
      ),
    ),
  },
];

/** What screens read of collections: every list, its name and size, rows, genres and services. */
function shown(made: Collections, like: Title | undefined) {
  const liked = like ? (`like:${ownedKey(like)}` as const) : null;
  const ids: CollectionId[] = [
    "all",
    "4k",
    "adult",
    "new-week",
    "new-month",
    "recent",
    "popular",
    "top-rated",
    ...made.genres().map((genre) => `genre:${genre.name}` as const),
    ...made.services().map((service) => `service:${service.id}` as const),
    ...(liked ? [liked] : []),
  ];
  return {
    lists: ids.map((id) => ({
      id,
      name: made.name(id),
      size: made.size(id),
      titles: made.list(id).map((title) => `${ownedKey(title)} ${title.title}`),
    })),
    byTitle: made.list("all", "title").map(ownedKey),
    forYou: collectionRows(made, "for-you", like ?? null),
    fresh: collectionRows(made, "new", null),
    genres: made.genres(),
    services: made.services(),
  };
}

let provider: FakeProvider;
let catalogue: OnDemandCatalogue;
beforeAll(async () => {
  provider = await startFakeProvider({ username: "fixture", password: "pass", titles: 6000 });
  // Added in the last days, so New this week and this month hold titles by the clock now.
  const { titles } = measurementTitles(provider.titles, Math.floor(Date.now() / 1000) - 3600);
  provider.serveTitles(() => titles);
  catalogue = await xtreamProvider(
    { server: provider.url, username: "fixture", password: "pass" },
    { userAgent: "fixture" },
  ).onDemandCatalogue();
});
afterAll(() => provider.close());

describe("collections made in tasks", () => {
  it("hold what making them at once gives, with TMDB's metadata or without, in any language", async () => {
    for (const language of ["en", "nl"]) {
      const index = indexCatalogue([{ subscriptionId: "a", catalogue }], language);
      for (const known of [null, tmdbOf(0)]) {
        for (const kind of ["movie", "series"] as const) {
          const source: CollectionSource = {
            kind,
            titles: kindOf(index, kind).titles,
            language,
            metadata: (id) => known?.(kind, id) ?? null,
            names: () => null,
            services: known ? servicesOf(index, kind) : [],
            now: Date.now(),
          };
          const made = await inTasks(collectionSteps(source), () => true);
          if (!made) throw new Error("Stopped");
          const like = kindOf(index, kind).titles.find((title) => title.tmdbId && !title.adult);
          const atOnce = shown(collections(source), like);
          expect(shown(made, like)).toEqual(atOnce);
          expect(atOnce.lists.every((list) => list.size === list.titles.length)).toBe(true);
          expect(atOnce.lists.find((list) => list.id === "4k")?.size).toBeGreaterThan(0);
          expect(atOnce.fresh.length).toBeGreaterThan(0);
          if (known) expect(atOnce.genres.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("hold for as long as making them at once holds: New's cutoffs, the year, expiry and the clock", async () => {
    const DAY = 86_400_000;
    const index = indexCatalogue([{ subscriptionId: "a", catalogue }], "en");
    const now = Date.now();
    const titles = kindOf(index, "movie").titles;
    // A few titles' metadata expires soon, and once already; the services in a while.
    const ids = titles.flatMap((title) => (title.tmdbId ? [title.tmdbId] : []));
    const soon = new Map(ids.slice(0, 5).map((id, at) => [id, now + (at + 1) * 60_000]));
    soon.set(ids[5] ?? "", now - 1);
    for (const expiresAt of [
      undefined,
      (id?: string) => (id ? (soon.get(id) ?? Infinity) : now + 3 * DAY),
    ]) {
      const source: CollectionSource = {
        kind: "movie",
        titles,
        language: "en",
        metadata: tmdbOf(0).bind(null, "movie"),
        names: () => null,
        services: servicesOf(index, "movie"),
        now,
        ...(expiresAt ? { expiresAt } : {}),
      };
      const made = await inTasks(collectionSteps(source), () => true);
      if (!made) throw new Error("Stopped");
      const atOnce = collections(source);
      const year = Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1);
      const cutoffs = titles
        .flatMap((title) =>
          title.addedAt ? [title.addedAt + 7 * DAY, title.addedAt + 30 * DAY] : [],
        )
        .filter((at) => at > now)
        .sort((a, b) => a - b)
        .slice(0, 3);
      const probes = [now - 1, now, now + 3 * DAY, year, ...cutoffs, ...soon.values()].flatMap(
        (at) => [at - 1, at, at + 1],
      );
      expect(probes.map((at) => made.validAt(at))).toEqual(probes.map((at) => atOnce.validAt(at)));
      expect(made.validAt(now)).toBe(true);
      expect(made.validAt(now - 1)).toBe(false);
      // The earliest of what it was made with, past or absent expiries left out.
      const earliest = Math.min(year, ...cutoffs, ...(expiresAt ? [now + 60_000] : []));
      expect([made.validAt(earliest - 1), made.validAt(earliest)]).toEqual([true, false]);
    }
  });
});

describe("the collections Movies, Series, Home and details show", () => {
  type Owner = typeof import("../src/titles.ts");
  let titles: Owner;

  /** The app's owner as a launch starts it, with no subscriptions yet. */
  /** How far the clock is moved from the real one. */
  let shift = 0;
  beforeEach(async () => {
    vi.resetModules();
    edges.members = [];
    edges.roster.clear();
    edges.known = null;
    edges.services = [];
    edges.expiry = null;
    shift = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
    titles = await import("../src/titles.ts");
  });
  afterEach(() => vi.restoreAllMocks());

  const subscribe = (...ids: string[]) => {
    edges.members = ids.map((id) => ({
      entry: { id },
      needsSecret: false,
      titles: { kind: "ready", value: catalogue, took: 1 },
    }));
    for (const listener of edges.roster) listener();
  };
  const indexed = () => {
    const lists = titles.titleLists();
    return lists.kind === "ready" ? lists.index : null;
  };
  /** Resolves once `ready` holds, checking after each task; fails after a few seconds. */
  async function until(ready: () => boolean, what: string) {
    for (let waited = 0; !ready(); waited += 1) {
      if (waited > 4000) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 1));
    }
  }
  /** What making `kind`'s collections at once gives for the lists that show and metadata now. */
  const atOnce = (kind: TitleKind, index: IndexedCatalogue) =>
    collections({
      kind,
      titles: kindOf(index, kind).titles,
      language: titles.language,
      metadata: (id) => edges.known?.(kind === "movie" ? "movie" : "tv", id) ?? null,
      names: () => null,
      services: edges.services,
      expiresAt: (id) => edges.expiry?.(kind === "movie" ? "movie" : "tv", id) ?? Infinity,
      now: Date.now(),
    });
  const seedOf = (index: IndexedCatalogue) =>
    kindOf(index, "movie").titles.find((title) => title.tmdbId && !title.adult);
  /**
   * Resolves once `kind`'s collections show what making them at once now gives, comparing each
   * collections the owner holds once.
   */
  async function latest(kind: TitleKind, index: IndexedCatalogue, like?: Title) {
    const expected = JSON.stringify(shown(atOnce(kind, index), like));
    let checked: Collections | null = null;
    await until(() => {
      const made = titles.collectionsOf(kind);
      if (!made || made === checked) return false;
      checked = made;
      return JSON.stringify(shown(made, like)) === expected;
    }, "the latest collections");
  }
  /** The metadata store learned something lists show, and says so. */
  const learn = (round: number) => {
    edges.known = tmdbOf(round);
    edges.notify?.({ content: true });
  };

  it("are none until the first are made for the lists that show, then what making them at once gives", async () => {
    // At the moment the lists show, neither kind has collections: screens show Loading and never
    // make any while they draw.
    const atShow: Array<Collections | null> = [];
    titles.onTitleLists(() => {
      if (indexed()) atShow.push(titles.collectionsOf("movie"), titles.collectionsOf("series"));
    });
    subscribe("a");
    await until(() => indexed() !== null, "the lists");
    expect(atShow).toEqual([null, null]);
    await until(
      () => titles.collectionsOf("movie") !== null && titles.collectionsOf("series") !== null,
      "the collections",
    );
    const index = indexed();
    if (!index) throw new Error("No lists");
    for (const kind of ["movie", "series"] as const) {
      const made = titles.collectionsOf(kind);
      if (!made) throw new Error("No collections");
      expect(shown(made, undefined)).toEqual(shown(atOnce(kind, index), undefined));
    }
  });

  it("keep the last made while newer metadata's are made, then show the latest, with no screen open", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const first = titles.collectionsOf("movie");
    const index = indexed();
    if (!index) throw new Error("No lists");
    // Metadata arrives three times in a row, then again once collections are being made.
    learn(1);
    learn(2);
    learn(3);
    expect(titles.collectionsOf("movie")).toBe(first);
    await new Promise((done) => setTimeout(done, 0));
    expect(titles.collectionsOf("movie")).toBe(first);
    edges.services = servicesOf(index, "movie");
    learn(4);
    // However often it changed, what shows at last is made of the metadata as it stands now.
    const seed = seedOf(index);
    if (!seed) throw new Error("No seed");
    await latest("movie", index, seed);
    // More like this, as details show it while Movies isn't the open tab, has titles.
    expect(titles.collectionsOf("movie")?.list(`like:${ownedKey(seed)}`).length).toBeGreaterThan(0);
  });

  it("are none once no subscription lists titles, and those being made then never show", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    learn(1);
    await new Promise((done) => setTimeout(done, 0));
    edges.members = [];
    for (const listener of edges.roster) listener();
    expect(titles.collectionsOf("movie")).toBeNull();
    expect(titles.collectionsOf("series")).toBeNull();
    for (let task = 0; task < 200; task++) await new Promise((done) => setTimeout(done, 1));
    expect(titles.collectionsOf("movie")).toBeNull();
    expect(titles.collectionsOf("series")).toBeNull();
  });

  it("are of the new lists once they show, and those being made for the old never show", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const before = indexed();
    const first = titles.collectionsOf("movie");
    // Another subscription's lists are indexed while metadata changes the old lists' collections.
    subscribe("a", "b");
    learn(1);
    expect(indexed()).toBe(before);
    expect(titles.collectionsOf("movie")).toBe(first);
    const atShow: Array<Collections | null> = [];
    titles.onTitleLists(() => atShow.push(titles.collectionsOf("movie")));
    /** Each collections the owner held once the new lists showed. */
    const seen = new Set<Collections>();
    await until(() => {
      const made = titles.collectionsOf("movie");
      if (indexed() !== before && made) seen.add(made);
      return seen.size > 0 && titles.collectionsOf("series") !== null;
    }, "the new lists' collections");
    expect(atShow).toEqual([null]);
    const index = indexed();
    if (!index) throw new Error("No lists");
    const fromB = (made: Collections) =>
      made.list("all").some((title) => title.versions.some((each) => each.subscriptionId === "b"));
    for (const made of seen) expect(fromB(made)).toBe(true);
    await latest("movie", index);
  });

  it("are made again once time passes what they hold, the last made showing meanwhile", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const index = indexed();
    const first = titles.collectionsOf("movie");
    if (!index || !first) throw new Error("No collections");
    expect(first.size("new-week")).toBeGreaterThan(0);
    // Six days on, what was new this week no longer is.
    shift = 6 * 86_400_000;
    expect(titles.collectionsOf("movie")).toBe(first);
    await latest("movie", index);
    expect(titles.collectionsOf("movie")?.size("new-week")).toBe(0);
    // The clock goes back a day: what was made for later is made again for now.
    const later = titles.collectionsOf("movie");
    shift = -86_400_000;
    expect(titles.collectionsOf("movie")).toBe(later);
    await until(() => titles.collectionsOf("movie") !== later, "collections for now");
    await latest("movie", index);
    expect(titles.collectionsOf("movie")?.size("new-week")).toBeGreaterThan(0);
  });

  it("are made again once the metadata they were made with expires, and then hold", async () => {
    const made = Date.now();
    edges.known = tmdbOf(0);
    edges.expiry = () => made + 5_000;
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const index = indexed();
    const first = titles.collectionsOf("movie");
    if (!index || !first) throw new Error("No collections");
    expect(first.validAt(made + 4_000)).toBe(true);
    shift = 6_000;
    expect(titles.collectionsOf("movie")).toBe(first);
    await until(() => titles.collectionsOf("movie") !== first, "collections made again");
    // Expired metadata doesn't make them again on every read.
    const again = titles.collectionsOf("movie");
    for (let task = 0; task < 100; task++) await new Promise((done) => setTimeout(done, 1));
    expect(titles.collectionsOf("movie")).toBe(again);
  });
});
