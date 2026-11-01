import { keychain } from "./keychain.ts";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { AboutStanding } from "../src/titles.ts";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

// TMDB's part of the catalogue as the viewer can mend it: their own key in the Keychain before
// the app's, what Settings and details say when TMDB has no key, refuses it or stops answering,
// asking again once it can, and the diagnostics the viewer may share. The real account and
// titles owners run over real files against the desktop tests' fake Xtream panel and fake TMDB;
// the Keychain is kept in memory across launches.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** TMDB's address: its requests are seen here first. */
  tmdb: "",
  /** Every key TMDB was asked with, in order. */
  keys: [] as string[],
  /** The keys details asked TMDB about a title with, in order. */
  abouts: [] as string[],
  /** No TMDB request reaches it, as when it is down or the iPhone is offline. */
  offline: false,
  /** TMDB doesn't know these ids. */
  unknown: new Set<string>(),
  /** No provider request reaches its panel. */
  panelDown: false,
  /** The viewer's TMDB key won't be read, as before the first unlock. */
  locked: false,
  /** A Keychain read that waits for the device to answer. */
  readKey: null as (() => Promise<void>) | null,
  /** A replacement password the fake panel accepts as its original one. */
  password: "",
  /** TMDB's answers for `key`, to details or to the catalogue, wait for `until` (`hold`). */
  holds: [] as {
    readonly key: string;
    readonly to: "details" | "catalogue";
    readonly until: Promise<void>;
  }[],
  /** The Keychain won't write its index of ids, as when it fails partway through a change. */
  indexFails: false,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "0.2.0" }, platform: { ios: { buildNumber: "21" } } },
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-secure-store", () => {
  const items = keychain(() => memory.keychain);
  return {
    ...items,
    getItemAsync: async (key: string) => {
      if (key === "s.metadata.tmdb") await memory.readKey?.();
      if (memory.locked && key === "s.metadata.tmdb")
        throw new Error("User interaction is not allowed.");
      return items.getItemAsync(key);
    },
    setItemAsync: async (key: string, value: string) => {
      if (memory.indexFails && key === "index") throw new Error("The Keychain failed.");
      return items.setItemAsync(key, value);
    },
  };
});
vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.1" } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

const REFUSED_KEY = "refused-key";
const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  if (!memory.tmdb || !input.startsWith(memory.tmdb)) {
    if (memory.panelDown) throw new TypeError(`Network request to ${input} failed`);
    const url = new URL(input);
    if (memory.password && url.searchParams.get("password") === memory.password)
      url.searchParams.set("password", LOGIN.password);
    return passThrough(url, init);
  }
  const url = new URL(input);
  const key = url.searchParams.get("api_key") ?? "";
  memory.keys.push(key);
  // Only details ask for a title's credits with it.
  const to = url.searchParams.has("append_to_response") ? "details" : "catalogue";
  if (to === "details") memory.abouts.push(key);
  if (memory.offline) throw new TypeError("Network request failed");
  for (const held of memory.holds) if (held.key === key && held.to === to) await held.until;
  if (key === REFUSED_KEY) return Response.json({ status_code: 7 }, { status: 401 });
  const id = /^\/3\/(?:movie|tv)\/(\d+)$/.exec(url.pathname)?.[1];
  if (id && memory.unknown.has(id)) return Response.json({ status_code: 34 }, { status: 404 });
  return passThrough(input, init);
});

const { native } = await import("./native-files.ts");

interface FakeProvider {
  readonly url: string;
  close(): Promise<void>;
}
interface FakeTmdb {
  readonly url: string;
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
    readonly titlesOf?: <
      T extends { readonly movies: readonly object[]; readonly series: readonly object[] },
    >(
      built: T,
    ) => T;
  }): Promise<FakeProvider>;
};
const { startFakeTmdb } = (await import(FAKE_TMDB)) as { startFakeTmdb(): Promise<FakeTmdb> };

const LOGIN = { username: "canaryuser", password: "canary+Pw@1" };
let panel: FakeProvider;
let tmdb: FakeTmdb;
beforeAll(async () => {
  [panel, tmdb] = await Promise.all([
    startFakeProvider({ ...LOGIN, channels: 4, titles: 12 }),
    startFakeTmdb(),
  ]);
});
afterAll(async () => {
  await Promise.all([panel.close(), tmdb.close()]);
});

beforeEach(async () => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  rmSync(join(native.root, "cache"), { recursive: true, force: true });
  const { Directory, Paths } = await import("./native-files.ts");
  for (const each of [Paths.document, Paths.cache])
    new Directory(each).create({ idempotent: true });
  memory.keychain.clear();
  memory.tmdb = tmdb.url;
  memory.keys.length = 0;
  memory.abouts.length = 0;
  memory.offline = false;
  memory.unknown.clear();
  memory.panelDown = false;
  memory.locked = false;
  memory.readKey = null;
  memory.password = "";
  memory.holds.length = 0;
  memory.indexFails = false;
});
afterEach(async () => {
  await drained();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Holds TMDB's answers for `key`, to details or to the catalogue, until the returned release. */
function hold(key: string, to: "details" | "catalogue") {
  let release = () => {};
  memory.holds.push({ key, to, until: new Promise<void>((done) => (release = done)) });
  return () => release();
}

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what = "the condition", limit = 8_000) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > limit) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Every launch's app, whose metadata stops fetching before another launch or test. */
const launched: App[] = [];
/** Resolves once no launch's metadata is fetching, so none writes into the next. */
async function drained() {
  for (const app of launched.splice(0)) {
    await until(() => app.metadataStanding().kind !== "fetching", "metadata to stop", 20_000);
  }
}

/** The app as a launch starts it, with the app's own TMDB key or none. */
async function launch({ appKey = "" } = {}): Promise<App> {
  await drained();
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TMDB_KEY", appKey);
  vi.stubEnv("EXPO_PUBLIC_TMDB_API", tmdb.url);
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const diagnostics = await import("../src/diagnostics.ts");
  await account.restore();
  const app = { ...account, ...titles, ...diagnostics };
  launched.push(app);
  return app;
}
type App = typeof import("../src/account.ts") &
  typeof import("../src/titles.ts") &
  typeof import("../src/diagnostics.ts");

/** Adds the panel's account and waits for its movie and series lists. */
async function added(app: App) {
  await app.add({ server: panel.url, ...LOGIN });
  await until(() => app.titleLists().kind === "ready", "the movie and series lists");
}

/** The first movie the lists show with a TMDB id. */
function firstMovie(app: App): Title {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No lists");
  const found = kindOf(lists.index, "movie").titles.find((title) => title.tmdbId && !title.adult);
  if (!found) throw new Error("No movie");
  return found;
}

const settled = (app: App, kind: string, limit?: number) =>
  until(() => app.metadataStanding().kind === kind, `TMDB ${kind}`, limit);

it("asks TMDB with the viewer's own key, kept in the Keychain through a relaunch, and the app's again once it is removed", async () => {
  let app = await launch();
  await added(app);
  // Without a key, browsing still works from the provider's facts, and details say why.
  await settled(app, "no-key");
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "no-key", savedAt: null });
  expect(memory.keys).toEqual([]);

  await app.saveTmdbKey("  viewer-key  ");
  await settled(app, "answered");
  expect(app.metadataStanding()).toMatchObject({ key: "yours" });
  expect(new Set(memory.keys)).toEqual(new Set(["viewer-key"]));
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "tmdb" });
  // Only the Keychain holds it.
  expect([...memory.keychain.values()]).toContain("viewer-key");

  app = await launch({ appKey: "app-key" });
  await until(() => app.titleLists().kind === "ready", "the saved lists");
  await settled(app, "answered");
  expect(app.metadataStanding()).toMatchObject({ key: "yours" });

  await app.removeTmdbKey();
  expect(app.metadataStanding()).toMatchObject({ key: "app" });
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "tmdb" });
  expect([...memory.keychain.values()]).not.toContain("viewer-key");
});

it("says a refused key apart and starts again with a key that works, the lists browsing throughout", async () => {
  const app = await launch({ appKey: REFUSED_KEY });
  await added(app);
  await settled(app, "refused");
  expect(app.metadataStanding()).toMatchObject({ key: "app" });
  expect(app.titleLists().kind).toBe("ready");
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "refused", savedAt: null });

  await app.saveTmdbKey("viewer-key");
  await settled(app, "answered");
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "tmdb" });
});

it(
  "shows TMDB's saved answer, dated, when it stops answering, and asks again on Try again",
  { timeout: 30_000 },
  async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let app = await launch({ appKey: "app-key" });
    await added(app);
    const movie = firstMovie(app);
    const answered = await app.detailsOf(movie);
    expect(answered.about).toEqual({ kind: "tmdb" });
    const savedAt = Date.now();

    // 151 days on, past TMDB's refresh but within what may be kept, and TMDB doesn't answer.
    vi.setSystemTime(savedAt + 151 * 24 * 60 * 60 * 1000);
    memory.offline = true;
    app = await launch({ appKey: "app-key" });
    await until(() => app.titleLists().kind === "ready", "the lists");
    const early: (AboutStanding | undefined)[] = [];
    const stale = await app.detailsOf(firstMovie(app), ({ about }) => early.push(about));
    expect(stale.about).toEqual({ kind: "unavailable", savedAt: expect.any(Number) });
    // While TMDB is asked, the saved answer shows dated from the first.
    expect(early[0]).toEqual({
      kind: "asking",
      savedAt: (stale.about as { savedAt: number }).savedAt,
    });
    expect((stale.about as { savedAt: number }).savedAt).toBeLessThanOrEqual(savedAt);
    expect(stale.plot).toBe(answered.plot);
    // Browsing goes on without it, and Settings says TMDB isn't answering.
    expect(app.titleLists().kind).toBe("ready");
    // Core's store retries each title with backoff before it gives up on TMDB.
    await settled(app, "unavailable", 20_000);

    memory.offline = false;
    app.retryMetadata();
    await settled(app, "answered");
    expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "tmdb" });
  },
);

it("keeps TMDB's saved facts once the only key is removed", async () => {
  const app = await launch();
  await added(app);
  await app.saveTmdbKey("viewer-key");
  await settled(app, "answered");
  const answered = await app.detailsOf(firstMovie(app));

  await app.removeTmdbKey();
  await settled(app, "no-key");
  const kept = await app.detailsOf(firstMovie(app));
  expect(kept.plot).toBe(answered.plot);
  expect(kept.about).toEqual({ kind: "tmdb" });
});

it("removes the key once the Keychain has let it go, though its index of ids failed", async () => {
  const app = await launch({ appKey: "app-key" });
  await added(app);
  await app.saveTmdbKey("viewer-key");
  await settled(app, "answered");

  memory.indexFails = true;
  await app.removeTmdbKey();
  expect(app.metadataStanding()).toMatchObject({ key: "app" });
  expect([...memory.keychain.values()]).not.toContain("viewer-key");
});

it("finds the viewer's saved key once a locked Keychain answers, without a relaunch", async () => {
  memory.keychain.set("s.metadata.tmdb", "viewer-key");
  memory.locked = true;
  const app = await launch({ appKey: "app-key" });
  await added(app);
  await settled(app, "answered");
  expect(app.metadataStanding()).toMatchObject({ key: "app" });

  // Opening a title's details reads the Keychain again.
  memory.locked = false;
  await app.detailsOf(firstMovie(app));
  await until(() => {
    const standing = app.metadataStanding();
    return "key" in standing && standing.key === "yours";
  }, "the viewer's key");
  await settled(app, "answered");
  expect(new Set(memory.keys)).toContain("viewer-key");
});

it("shows no old season when its login changes while the Keychain answers", async () => {
  memory.locked = true;
  const app = await launch({ appKey: "app-key" });
  await added(app);
  await settled(app, "answered");
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No lists");
  const series = kindOf(lists.index, "series").titles.find((title) => title.tmdbId && !title.adult);
  if (!series) throw new Error("No series");
  const details = await app.detailsOf(series);
  if (details.kind !== "series") throw new Error("Not a series");
  const [season] = details.seasons;
  if (!season) throw new Error("No season");
  expect(season.episodes.length).toBeGreaterThan(0);

  let release = () => {};
  let held = false;
  const untilReleased = new Promise<void>((done) => (release = done));
  memory.locked = false;
  memory.readKey = async () => {
    held = true;
    await untilReleased;
  };
  const shown: unknown[] = [];
  const reading = app.episodesOf(series, season, (episodes) => shown.push(episodes));
  const result = reading.catch((cause: unknown) => cause);
  try {
    await until(() => held, "the Keychain read");
    memory.password = "changed-password";
    await app.update(series.subscriptionId, { password: memory.password });
    await until(() => app.titleLists().kind === "ready", "the new login's lists");
  } finally {
    memory.readKey = null;
    release();
  }
  expect(await result).toMatchObject({ error: { kind: "no-subscription" } });
  expect(shown).toEqual([]);

  const current = await app.detailsOf(series);
  if (current.kind !== "series" || !current.seasons[0]) throw new Error("No current season");
  expect((await app.episodesOf(series, current.seasons[0])).length).toBeGreaterThan(0);
});

it("lets go of details asked with a key that was replaced", async () => {
  const app = await launch({ appKey: REFUSED_KEY });
  await added(app);
  await settled(app, "refused");
  const release = hold(REFUSED_KEY, "details");
  const before = memory.keys.length;
  const asked = app.detailsOf(firstMovie(app));
  await until(() => memory.keys.length > before, "the held ask");

  await app.saveTmdbKey("viewer-key");
  expect((await app.detailsOf(firstMovie(app))).about).toEqual({ kind: "tmdb" });
  release();
  expect((await asked).about).toEqual({ kind: "refused", savedAt: null });
});

it("asks details with the new key, an answer still asked with the replaced one kept nowhere", async () => {
  const app = await launch({ appKey: "app-key" });
  await added(app);
  await settled(app, "answered");
  const release = hold("app-key", "details");
  const movie = firstMovie(app);
  const asked = app.detailsOf(movie);
  await until(() => memory.abouts.includes("app-key"), "the held ask");

  await app.saveTmdbKey("viewer-key");
  release();
  expect((await asked).about).toEqual({ kind: "tmdb" });
  expect((await app.detailsOf(movie)).about).toEqual({ kind: "tmdb" });
  expect(memory.abouts).toEqual(["app-key", "viewer-key"]);
});

it("saves no details answer that arrives while a key change waits for the old store", async () => {
  const releaseCatalogue = hold("app-key", "catalogue");
  const app = await launch({ appKey: "app-key" });
  await added(app);
  await settled(app, "fetching");
  const releaseDetails = hold("app-key", "details");
  const movie = firstMovie(app);
  const asked = app.detailsOf(movie);
  await until(() => memory.abouts.includes("app-key"), "the held ask");

  // The old store closes once its held catalogue answers come, the key change waiting for it.
  const saving = app.saveTmdbKey("viewer-key");
  await until(() => [...memory.keychain.values()].includes("viewer-key"), "the saved key");
  releaseDetails();
  expect((await asked).about).toEqual({ kind: "tmdb" });
  releaseCatalogue();
  await saving;
  expect((await app.detailsOf(movie)).about).toEqual({ kind: "tmdb" });
  expect(memory.abouts).toEqual(["app-key", "viewer-key"]);
});

it("says when no listed title has a TMDB id", { timeout: 20_000 }, async () => {
  // A TMDB id of "0" is none, as panels list it.
  const unlinked = <A extends object>(titles: readonly A[]) =>
    titles.map((title) => ({ ...title, tmdb: "0" }));
  const bare = await startFakeProvider({
    ...LOGIN,
    channels: 2,
    titles: 6,
    titlesOf: (built) => ({
      ...built,
      movies: unlinked(built.movies),
      series: unlinked(built.series),
    }),
  });
  try {
    const app = await launch({ appKey: "app-key" });
    await app.add({ server: bare.url, ...LOGIN });
    await until(() => app.titleLists().kind === "ready", "the lists");
    await app.saveTmdbKey("viewer-key");
    await settled(app, "unlinked");
    expect(app.diagnosticsText()).toContain("  Status: no titles with a TMDB id\n");
  } finally {
    await bare.close();
  }
});

it("says when TMDB doesn't know a title", async () => {
  const app = await launch({ appKey: "app-key" });
  await added(app);
  const movie = firstMovie(app);
  memory.unknown.add(movie.tmdbId ?? "");
  expect((await app.detailsOf(movie)).about).toEqual({ kind: "missing" });
});

it("shares diagnostics of kinds and counts alone: no address, login, name or failure text", async () => {
  const app = await launch({ appKey: REFUSED_KEY });
  await added(app);
  await settled(app, "refused");
  // Its panel stops answering: the failure's own words carry its address and login.
  memory.panelDown = true;
  const [member] = app.members();
  if (!member) throw new Error("No provider");
  app.reloadChannels(member.entry.id);
  await until(() => app.members()[0]?.live.kind === "failed", "the failed reload");
  const text = app.diagnosticsText();

  expect(text).toContain("Mr. Streamer 0.2.0 (21)\niOS 26.1\nProviders: 1 Xtream\n");
  expect(text).toContain(
    [
      "Provider 1, Xtream",
      "  Channels: failed (unreachable), saved copy shown",
      "  Movies and series: loaded",
      "  Account: active",
    ].join("\n"),
  );
  expect(text).toContain("TMDB\n  Key: the app's\n  Status: refused the key\n  Titles: 0 of ");
  expect(text).toMatch(/\nMade .+, .+\n/);
  expect(text).toContain(
    "Addresses, logins, provider and title names, viewing history and file paths are left out.",
  );
  for (const secret of [
    panel.url,
    new URL(panel.url).host,
    LOGIN.username,
    LOGIN.password,
    encodeURIComponent(LOGIN.password),
    REFUSED_KEY,
    native.root,
    "file://",
  ]) {
    expect(text).not.toContain(secret);
  }
  for (const member of app.members()) expect(text).not.toContain(member.label);
});
