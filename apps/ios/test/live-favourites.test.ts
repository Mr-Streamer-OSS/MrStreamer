import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Live favourites as the app's own owners keep them: account.ts with its registry and Keychain,
// the viewing record in viewing.json, and the favourites as Live, Home and Watch read them
// (favourites.ts). Two of the desktop tests' fake Xtream panels answer over HTTP, the second
// numbering its channels as the first does, and each lists one channel in three qualities
// (stream ids QUALITY_STREAM_IDS to + 2). A test changes what a panel lists and reloads, as a
// provider changing its list does. Documents and the Keychain are kept in memory across launches,
// which re-import the app's modules; the native player records what it is given.

const memory = vi.hoisted(() => ({
  files: new Map<string, string>(),
  keychain: new Map<string, string>(),
  /** Documents whose write fails. */
  full: new Set<string>(),
  /** What the player was given, in order. */
  played: [] as string[],
}));

vi.mock("react-native", () => ({ Alert: { alert: () => undefined } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async (source: { uri: string } | null) => {
      if (source) memory.played.push(source.uri);
    },
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-file-system", () => {
  const pathOf = (parent: string | { readonly path: string }, name: string) =>
    `${typeof parent === "string" ? parent : parent.path}/${name}`;
  class Directory {
    readonly path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      const within = `${this.path}/`;
      return [...memory.files.keys()]
        .filter((path) => path.startsWith(within) && !path.slice(within.length).includes("/"))
        .map((path) => new File(this, path.slice(within.length)));
    }
  }
  class File {
    path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get name() {
      return this.path.slice(this.path.lastIndexOf("/") + 1);
    }
    get exists() {
      return memory.files.has(this.path);
    }
    get size() {
      return memory.files.get(this.path)?.length ?? 0;
    }
    get modificationTime() {
      return 0;
    }
    create() {
      if (!this.exists) memory.files.set(this.path, "");
    }
    textSync() {
      const text = memory.files.get(this.path);
      if (text === undefined) throw new Error("No such file");
      return text;
    }
    async text() {
      return this.textSync();
    }
    writeSync(text: string) {
      if ([...memory.full].some((name) => this.path.endsWith(`/${name}.next`))) {
        throw new Error("The disk is full");
      }
      memory.files.set(this.path, text);
    }
    async write(text: string) {
      memory.files.set(this.path, text);
    }
    moveSync(to: File) {
      memory.files.set(to.path, this.textSync());
      memory.files.delete(this.path);
    }
    async move(to: File) {
      this.moveSync(to);
      this.path = to.path;
    }
    delete() {
      memory.files.delete(this.path);
    }
  }
  return { File, Directory, Paths: { document: "/documents", cache: "/cache" } };
});
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void memory.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void memory.keychain.delete(key),
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

/** What these tests use of the desktop tests' fake panel. */
interface FakeChannel {
  readonly streamId: number;
}
interface FakeProvider {
  readonly url: string;
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  failCatalogue(status: number | null): void;
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, QUALITY_STREAM_IDS } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
    readonly second?: boolean;
  }): Promise<FakeProvider>;
  QUALITY_STREAM_IDS: number;
};
/** The channel in Full HD, HD and SD, by its streams' ids. */
const [FHD, HD, SD] = [0, 1, 2].map((at) => String(QUALITY_STREAM_IDS + at)) as [
  string,
  string,
  string,
];

let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 40, titles: 4 }),
    startFakeProvider({
      username: "two",
      password: "two+Pw@2",
      channels: 40,
      titles: 4,
      second: true,
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  vi.resetModules();
  const account = await import("../src/account.ts");
  const viewing = await import("../src/viewing.ts");
  const favourites = await import("../src/favourites.ts");
  await account.restore();
  return { ...viewing, ...favourites, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

/** The favourites as Live, Home and Watch read them now. */
const listOf = (app: App) =>
  app.favouriteList(app.currentViewing(), app.currentCatalogue(), app.members());
/** The keys of the favourites that open, in order. */
const shown = (app: App) => listOf(app)?.shown.map(({ channel }) => channel.key) ?? [];
const hidden = (app: App) =>
  listOf(app)?.hidden.map(({ subscriptionId, why, count }) => ({ subscriptionId, why, count }));
/** The stream ids a subscription's record keeps as favourites, as viewing.json holds them. */
const stored = (id: string): readonly string[] =>
  JSON.parse(memory.files.get("/documents/viewing.json") ?? "{}").accounts?.[id]?.state
    ?.favourites ?? [];

/** One of `subscriptionId`'s channels as Live lists it, by any of its streams' ids. */
function channelOf(app: App, subscriptionId: string, id: string) {
  const now = app.currentCatalogue();
  const channel =
    now.kind === "ready" ? now.library.byKey.get(`${subscriptionId}:${id}`) : undefined;
  if (!channel) throw new Error(`No channel ${id} from ${subscriptionId}`);
  return channel;
}
const listsBoth = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready" && now.library.labels.size === 2;
};

/** A launch with both panels saved and their channels shown. */
async function twoProviders() {
  const app = await launch();
  const a = await app.add({ server: one.url, ...ONE });
  const b = await app.add({ server: two.url, ...TWO, name: "Cabin" });
  if (!a || !b) throw new Error("An add was cancelled");
  await until(() => listsBoth(app), "both channel lists");
  return { app, a, b };
}

/** Stars or unstars a channel as a row or Watch does; resolves once the record is read again. */
async function star(app: App, channel: OwnedId, favourite = true) {
  await app.setFavourite(channel, favourite);
}

const libraryOf = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready" ? now.library : null;
};

/**
 * Has `panel` list only the streams `listed` keeps, then reloads `id`'s channels and waits for
 * Live to show them.
 */
async function relist(app: App, id: string, panel: FakeProvider, listed: (id: string) => boolean) {
  panel.serveChannels((all) => all.filter((each) => listed(String(each.streamId))));
  const before = libraryOf(app);
  app.reloadChannels(id);
  await until(() => libraryOf(app) !== before && app.channelsWorkedOut(), "the new list");
}
const without =
  (...ids: string[]) =>
  (id: string) =>
    !ids.includes(id);

beforeEach(() => {
  memory.files.clear();
  memory.keychain.clear();
  memory.full.clear();
  memory.played.length = 0;
  for (const panel of [one, two]) {
    panel.serveChannels((all) => all);
    panel.failCatalogue(null);
  }
});

describe("starring channels", () => {
  it("keeps one favourite per channel and provider, in the order starred, after a relaunch", async () => {
    const { app, a, b } = await twoProviders();
    const quality = channelOf(app, a, HD);
    // Starred through its HD stream: the one channel, with every quality it lists.
    await star(app, { subscriptionId: a, id: HD });
    // The other provider's channel under the very same stream ids is a favourite of its own.
    await star(app, channelOf(app, b, FHD));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 3, "three favourites");
    expect(shown(app)).toEqual([quality.key, `${b}:${FHD}`, `${a}:1000`]);
    expect(quality.key).toBe(`${a}:${FHD}`);
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);
    expect(stored(b)).toEqual([FHD, HD, SD]);
    expect(memory.played).toEqual([]);

    const again = await launch();
    await until(() => listsBoth(again) && shown(again).length === 3, "the favourites again");
    expect(shown(again)).toEqual([`${a}:${FHD}`, `${b}:${FHD}`, `${a}:1000`]);

    await star(again, channelOf(again, b, SD), false);
    await until(() => shown(again).length === 2, "one fewer");
    expect(shown(again)).toEqual([`${a}:${FHD}`, `${a}:1000`]);
    expect(stored(b)).toEqual([]);
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);
  });

  it("leaves the record as it was when viewing.json won't take a change", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 1, "the favourite");
    const before = memory.files.get("/documents/viewing.json");
    memory.full.add("viewing.json");
    await expect(star(app, channelOf(app, a, "1001"))).rejects.toThrow();
    await expect(star(app, channelOf(app, a, "1000"), false)).rejects.toThrow();
    expect(memory.files.get("/documents/viewing.json")).toBe(before);
    expect(shown(app)).toEqual([`${a}:1000`]);

    memory.full.clear();
    const again = await launch();
    await until(() => shown(again).length === 1, "the favourite after a relaunch");
    expect(shown(again)).toEqual([`${a}:1000`]);
  });
});

describe("a provider listing its channels otherwise", () => {
  it("keeps a channel one favourite as its qualities come and go", async () => {
    const { app, a } = await twoProviders();
    // Starred while the provider listed only HD and SD.
    await relist(app, a, one, without(FHD));
    await star(app, channelOf(app, a, SD));
    await until(() => shown(app).length === 1, "the favourite");
    expect(shown(app)).toEqual([`${a}:${HD}`]);
    expect(stored(a)).toEqual([HD, SD]);

    // Full HD listed again: the same favourite, now by the channel's lowest stream.
    await relist(app, a, one, () => true);
    await until(() => shown(app)[0] === `${a}:${FHD}`, "the channel with Full HD");
    expect(shown(app)).toEqual([`${a}:${FHD}`]);
    expect(hidden(app)).toEqual([]);

    // HD gone: the channel shows by its other streams, the stream saved stays saved.
    await relist(app, a, one, without(HD));
    await until(() => (hidden(app)?.length ?? 0) > 0, "the stream not listed");
    expect(shown(app)).toEqual([`${a}:${FHD}`]);
    expect(hidden(app)).toEqual([{ subscriptionId: a, why: "not-listed", count: null }]);
    expect(stored(a)).toEqual([HD, SD]);
  });

  it("keeps favourites no list shows in their places while the rest are rearranged", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 3, "three favourites");

    await relist(app, a, one, without(FHD, HD, SD));
    await until(() => shown(app).length === 2, "the channel gone");
    expect(hidden(app)).toEqual([{ subscriptionId: a, why: "not-listed", count: null }]);
    // A failed reload keeps the list that showed, and the favourites with it.
    one.failCatalogue(503);
    app.reloadChannels(a);
    await until(() => app.members()[0]?.live.kind === "failed", "the failure");
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`]);

    const list = listOf(app);
    if (!list) throw new Error("No favourites");
    await app.reorderFavourites({
      original: list.original,
      order: list.shown.map((each) => each.saved).toReversed(),
    });
    await until(() => shown(app)[0] === `${b}:1000`, "the new order");
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);

    one.failCatalogue(null);
    await relist(app, a, one, () => true);
    await until(() => shown(app).length === 3, "the channel back");
    expect(shown(app)).toEqual([`${a}:${FHD}`, `${b}:1000`, `${a}:1000`]);
    expect(memory.played).toEqual([]);
  });

  it("refuses an order made from favourites that changed since, moving nothing", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 2, "two favourites");
    const list = listOf(app);
    if (!list) throw new Error("No favourites");
    await star(app, channelOf(app, a, "1001"));
    await expect(
      app.reorderFavourites({
        original: list.original,
        order: list.shown.map((each) => each.saved).toReversed(),
      }),
    ).rejects.toMatchObject({ error: { kind: "favourites-changed" } });
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`, `${a}:1001`]);

    // And one viewing.json won't take leaves the order as it was.
    memory.full.add("viewing.json");
    const now = listOf(app);
    if (!now) throw new Error("No favourites");
    await expect(
      app.reorderFavourites({
        original: now.original,
        order: now.shown.map((each) => each.saved).toReversed(),
      }),
    ).rejects.toThrow();
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`, `${a}:1001`]);
  });
});

describe("a provider's favourites as it comes and goes", () => {
  it("opens none of a provider that needs its password, keeping them and their places", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 2, "two favourites");
    memory.keychain.delete(`s.${a}`);

    const again = await launch();
    await until(
      () => again.members()[0]?.needsSecret === true && shown(again).length === 1,
      "the password asked for",
    );
    expect(shown(again)).toEqual([`${b}:1000`]);
    expect(hidden(again)).toEqual([{ subscriptionId: a, why: "needs-secret", count: null }]);
    expect(stored(a)).toEqual(["1000"]);
    expect(memory.played).toEqual([]);
  });

  it("brings a provider's favourites back with it when removed with its history kept", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, b, "1000"));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 2, "two favourites");

    await app.remove(b, { keepHistory: true });
    await until(() => shown(app).length === 1, "the other's favourites");
    expect(shown(app)).toEqual([`${a}:1000`]);
    expect(stored(b)).toEqual(["1000"]);

    const back = await app.add({ server: two.url, ...TWO });
    expect(back).toBe(b);
    await until(() => listsBoth(app) && shown(app).length === 2, "its favourites back");
    expect(shown(app)).toEqual([`${b}:1000`, `${a}:1000`]);
  });

  it("erases only that provider's favourites when its history goes with it", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, b, "1000"));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 2, "two favourites");

    await app.remove(b, { keepHistory: false });
    await until(() => shown(app).length === 1, "the other's favourites");
    expect(stored(b)).toEqual([]);
    expect(stored(a)).toEqual(["1000"]);

    const back = await app.add({ server: two.url, ...TWO });
    if (!back) throw new Error("The add was cancelled");
    await until(() => listsBoth(app), "both lists");
    expect(shown(app)).toEqual([`${a}:1000`]);
  });
});
