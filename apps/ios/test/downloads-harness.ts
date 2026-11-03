import { nativePlayer } from "./native-player.ts";
import type { DownloadStatus } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { afterAll, afterEach, beforeAll, onTestFinished, vi } from "vitest";

// Downloads through the app's own owners: the account, its two fake Xtream panels over HTTP (the
// desktop tests' fake provider, one connection each, a closed one freed 300 ms later as its
// default has it), the title lists, the one player and the downloads owner. expo-file-system is
// `native-files.ts`, over real files; the app's native background scheduler is
// `native-downloads.ts`, a model of its contract over real requests that goes on to the next
// authorization by itself. The player asks for an online stream over HTTP, as AVPlayer does, and
// holds it until it is replaced. The Keychain is kept in memory, and a relaunch imports the app's
// modules again over the same Documents, Keychain and native queue, while the last process's
// media requests go on, as a background session's do. The shared download actions answer through
// a recorded system sheet. What only iOS can show (URLSession's own resume data and timing,
// earliestBeginDate, a suspended app's wakes and handler, the Keychain, Swift itself, playing the
// file) is not proved here.
//
// A test file imports this before anything else: its mocks then stand in for the app's native
// modules, and its hooks run around that file's tests. These downloads tests are split across
// five such files so they run side by side; each file starts its own providers and Documents.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** How long the Keychain takes to write a download's resume data. */
  keychainMs: 0,
  /** While true, the Keychain won't read a download's item, as before the first unlock. */
  locked: false,
  /** Holds the Keychain's removal of a download's resume data until `done`, saying when it starts. */
  removal: null as null | { started: () => void; done: Promise<void> },
  /** The last system sheet shown, and how to answer it. */
  sheet: null as null | { options: readonly string[]; pick: (at: number) => void },
  /**
   * What the player was given, how many download requests were still open then, and the HTTP
   * status the provider answered an online stream with, once it did.
   */
  played: [] as { readonly uri: string; readonly downloading: number; status: number | null }[],
  downloading: (): number => 0,
  player: null as ReturnType<typeof nativePlayer> | null,
  appState: "active" as string,
  appListeners: [] as Array<(state: string) => void>,
  /** While set, a series' details reach the app only once `released` settles. */
  details: null as null | { arrived: () => void; released: Promise<void> },
  restricted: null as null | {
    movies: readonly string[];
    series: readonly string[];
    channel: string;
  },
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
/** Set, the viewing record's saves of progress wait for it, as a busy record would. */
const viewingSaves: { hold: Promise<void> | null } = { hold: null };
/**
 * Has the next launch's viewing record hold its saves of progress while `viewingSaves.hold` is
 * set, for the test that asks, until it ends. Other tests run the record as it is: errors from a
 * wrapped record don't pass the app's `instanceof AppFailure` checks.
 */
function holdingViewingSaves() {
  vi.doMock("../src/viewing.ts", async (original) => {
    const viewing = await original<typeof import("../src/viewing.ts")>();
    return {
      ...viewing,
      recordProgress: async (...args: Parameters<typeof viewing.recordProgress>) => {
        await viewingSaves.hold;
        return viewing.recordProgress(...args);
      },
    };
  });
  onTestFinished(() => vi.doUnmock("../src/viewing.ts"));
}
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
  Alert: { alert: () => undefined },
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (at: number) => void,
    ) => {
      memory.sheet = { options, pick };
    },
  },
  AppState: {
    get currentState() {
      return memory.appState;
    },
    addEventListener: (_: "change", listener: (state: string) => void) => {
      memory.appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => {
    if (memory.locked && key.includes("download")) throw new Error("Interaction not allowed");
    return memory.keychain.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (key.includes("download") && memory.keychainMs > 0) {
      await new Promise((done) => setTimeout(done, memory.keychainMs));
    }
    memory.keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    const held = key.includes("download") ? memory.removal : null;
    if (held) {
      held.started();
      await held.done;
    }
    memory.keychain.delete(key);
  },
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => {
    let stream: AbortController | null = null;
    let request = Promise.resolve();
    const player = nativePlayer((source) => {
      const played = {
        uri: source.uri,
        downloading: memory.downloading(),
        status: null as number | null,
      };
      memory.played.push(played);
      if (!source.uri.startsWith("http")) return;
      const controller = new AbortController();
      stream = controller;
      const identity = player.identity();
      request = fetch(source.uri, { signal: controller.signal }).then(
        async (response) => {
          played.status = response.status;
          if (response.ok) return;
          await response.body?.cancel();
          player.observation(
            { kind: "failure", terminal: true, failure: { kind: "unknown", evidence: null } },
            identity,
          );
        },
        () => undefined,
      );
    });
    const detach = player.detachObservedAsync.getMockImplementation()!;
    player.detachObservedAsync.mockImplementation(async (id) => {
      // Aborted only once the provider answered: a request already sent, a redirect's second hop
      // included, still reaches the panel after an abort and holds its connection while the
      // panels look idle.
      await request;
      stream?.abort();
      return detach(id);
    });
    memory.player = player;
    return player;
  },
}));

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const response = await passThrough(input, init);
  const restricted = memory.restricted;
  const action = typeof input === "string" ? new URL(input).searchParams.get("action") : null;
  if (restricted && response.ok && action?.startsWith("get_")) {
    if (action === "get_vod_categories") {
      const categories = (await response.json()) as unknown[];
      return Response.json([
        ...categories,
        { category_id: "excluded", category_name: "XXX Adults" },
      ]);
    }
    if (["get_vod_streams", "get_series", "get_live_streams"].includes(action)) {
      const rows = (await response.json()) as Record<string, unknown>[];
      return Response.json(
        rows.map((row) => {
          const id = String(row["stream_id"] ?? row["series_id"]);
          if (action === "get_vod_streams" && id === restricted.movies[0]) {
            return { ...row, category_id: "excluded", category_ids: ["excluded"] };
          }
          const flagged =
            action === "get_vod_streams"
              ? restricted.movies.includes(id)
              : action === "get_series"
                ? restricted.series.includes(id)
                : id === restricted.channel;
          return flagged ? { ...row, is_adult: 1 } : row;
        }),
      );
    }
  }
  const held = memory.details;
  if (!held || typeof input !== "string" || !input.includes("action=get_series_info")) {
    return response;
  }
  const body = await response.text();
  held.arrived();
  await held.released;
  return new Response(body, { status: response.status, headers: response.headers });
});

const { native, File: DiskFile, Directory: Folder } = await import("./native-files.ts");
const { background } = await import("./native-downloads.ts");

interface FakeTitle {
  readonly id: number;
  readonly name: string;
  readonly fixture: string | null;
}
interface FakeSeries {
  readonly id: number;
  readonly seasons: readonly (readonly (FakeTitle & { readonly number?: number })[])[];
  /** The TMDB id it shares with another version of the series, when it is one. */
  readonly tmdb?: string;
}
interface FakeProvider {
  readonly url: string;
  readonly titles: {
    readonly movies: readonly FakeTitle[];
    readonly series: readonly FakeSeries[];
  };
  activeStreams(): number;
  fileRequests(): number;
  streamRequests(): number;
  mostFilesAtOnce(): number;
  stallMovieFile(movieId: number, at: number, ms: number): void;
  replaceMovieFile(movieId: number, file: string | Buffer): void;
  close(): Promise<void>;
}
/** Typed by Node's own lib, which the app's tsconfig leaves out of the desktop's: by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, fixture } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: Record<string, unknown>): Promise<FakeProvider>;
  fixture(name: string): Buffer;
};

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };
let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ ...ONE, channels: 20, titles: 10 }),
    startFakeProvider({ ...TWO, channels: 20, titles: 10, second: true }),
  ]);
  memory.downloading = () => native.open;
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

/** MP4 films both panels list under the same ids, as the TEST movies are. */
const films = () =>
  one.titles.movies.filter(
    (each) => each.name.startsWith("TEST") && each.fixture?.endsWith(".mp4"),
  );
const movie = () => films()[0]!;
const otherMovie = () =>
  films()[1] ?? one.titles.movies.find((each) => each.fixture && each !== movie())!;
const episode = () => {
  const series = one.titles.series.find((each) => each.seasons[0]?.[0]?.fixture)!;
  const first = series.seasons[0]![0]!;
  return { series, first };
};

afterEach(async () => {
  memory.restricted = null;
  memory.details = null;
  one.stallMovieFile(movie().id, 0, 0);
  one.stallMovieFile(otherMovie().id, 0, 0);
  memory.appState = "active";
  memory.locked = false;
  native.held = null;
  native.leaseDeadlines = null;
  native.sync = null;
  await background.forceQuit();
  // What an earlier launch left streaming ends before the next test asks the panels for files.
  await until(panelsIdle, "the panels to idle");
});

const panelsIdle = () => one.activeStreams() === 0 && two.activeStreams() === 0;

async function until(ready: () => boolean, what: string, ms = 8_000) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/**
 * The app as a launch starts it: the last process ends, its media requests going on as a
 * background session's do, and fresh modules start over the same files, Keychain and native
 * ledger. With none going on, a launch takes longer than the panels take to free a closed
 * connection; the last process writes nothing more.
 */
async function launch() {
  background.die();
  const list = new DiskFile(native.root, "documents", "downloads.json");
  const left = { list: list.exists ? list.textSync() : null, keychain: new Map(memory.keychain) };
  if (background.task === null && background.strays.size === 0) {
    await until(panelsIdle, "the last process's requests to be freed");
  }
  if (left.list === null) {
    if (list.exists) list.delete();
  } else list.writeSync(left.list);
  memory.keychain = left.keychain;
  vi.resetModules();
  memory.appListeners.length = 0;
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const playback = await import("../src/playback.ts");
  const viewing = await import("../src/viewing.ts");
  const downloads = await import("../src/downloads.ts");
  const playTitle = await import("../src/play-title.ts");
  const series = await import("../src/series-download.ts");
  await account.restore();
  downloads.startDownloads();
  // `playback` too, whose `retry` another owner's shadows.
  return {
    ...titles,
    ...playback,
    ...viewing,
    ...downloads,
    ...account,
    ...playTitle,
    ...series,
    playback,
  };
}
type App = Awaited<ReturnType<typeof launch>>;

/** A fresh install: nothing in Documents, the Keychain or the native ledger. */
async function install() {
  await background.forceQuit();
  background.reset();
  const documents = new Folder(native.root, "documents");
  documents.delete();
  documents.create();
  native.free = 64 * 1024 * 1024 * 1024;
  native.requests.length = 0;
  native.pauseMs = 0;
  native.held = null;
  native.leaseDeadlines = null;
  native.sync = null;
  memory.keychain.clear();
  memory.keychainMs = 0;
  memory.removal = null;
  memory.sheet = null;
  memory.played.length = 0;
}

/**
 * A fresh install launched a second ago, so its first request skips the launch's 1s admission
 * wait. Only that timestamp moves: request-close grace, provider release and later launches still
 * use real time. Use when a test needs downloads under way, not that first admission window.
 */
async function installedApp() {
  await install();
  const app = await launch();
  background.launchedAt -= 1_000;
  return app;
}

/**
 * Adds the first provider, and the second when `both`, then waits until the combined index lists
 * the titles the tests ask each for: lists can be ready while the index still is an older one.
 */
async function withProviders(app: App, both = false) {
  const a = await app.add({ server: one.url, ...ONE });
  const b = both ? await app.add({ server: two.url, ...TWO }) : null;
  const listed = () => {
    const lists = app.titleLists();
    if (lists.kind !== "ready") return false;
    const has = (kind: "movie" | "series", subscriptionId: string, id: number) =>
      app.titleOf(lists.index, kind, { subscriptionId, id: String(id) }) !== undefined;
    const films = (subscriptionId: string) =>
      has("movie", subscriptionId, movie().id) && has("movie", subscriptionId, otherMovie().id);
    return films(a!) && has("series", a!, episode().series.id) && (b === null || films(b));
  };
  await until(listed, "the title lists");
  return { a: a!, b };
}

const movieRef = (subscriptionId: string, id = movie().id): TitleRef => ({
  kind: "movie",
  subscriptionId,
  id: String(id),
});
const statusOf = (app: App, id: string): DownloadStatus | undefined =>
  app.downloadList().items.find((item) => item.id === id)?.status;
const isComplete = (app: App, id: string) => statusOf(app, id)?.kind === "complete";
const doc = () => JSON.parse(new DiskFile(native.root, "documents", "downloads.json").textSync());
/** An earlier build's resume data, in the app's own Keychain items. */
const downloadSecrets = () =>
  [...memory.keychain.keys()].filter((key) => key.startsWith("s.download"));
/** Downloads the native side keeps resume data for. */
const nativeSecrets = () => [...background.resume.keys()];
const receivedOf = (app: App, id: string) =>
  (statusOf(app, id) as { received?: number } | undefined)?.received;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const folder = (id: string) => new Folder(native.root, "documents", "downloads", id);
const mediaFile = (id: string) =>
  folder(id)
    .list()
    .filter((entry) => entry instanceof DiskFile)
    .find((entry) => entry.name.startsWith("media."));
/** Everything app storage holds, to look for logins. */
function everythingStored(): string {
  const read = (dir: InstanceType<typeof Folder>): string[] =>
    dir
      .list()
      .flatMap((entry) =>
        entry instanceof Folder
          ? read(entry)
          : entry.name.startsWith("media.") || ["poster", "wide"].includes(entry.name)
            ? []
            : [entry.textSync()],
      );
  return read(new Folder(native.root, "documents")).join("\n");
}

/** Plays a film of `subscriptionId` in Watch, online, as its details' Play does. */
function playFilm(app: App, subscriptionId: string, id: number) {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No titles");
  const version = { subscriptionId, id: String(id) };
  app.playMovie(app.titleOf(lists.index, "movie", version)!, version, 0, () => undefined);
}

/** Sends the app to the background and back, as iOS reports it. */
function appGoes(state: "background" | "active") {
  memory.appState = state;
  for (const listener of memory.appListeners) listener(state);
}

const busy = () => Object.assign(new Error("busy"), { code: "ERR_DOWNLOADS_BUSY" });

/** Answers `busy` at once, as a command past its deadline does, and is written natively later. */
const late =
  <A extends unknown[]>(command: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<never> => {
    setTimeout(() => void command(...args).catch(() => undefined), 300);
    throw busy();
  };

/** The model's bridge, as the app finds it: kept across launches, so a spy on it is too. */
const bridge = (
  globalThis as typeof globalThis & { expo: { modules: { BackgroundDownloads: Bridge } } }
).expo.modules.BackgroundDownloads;
interface Bridge {
  holdAuthorization(authorization: string, held: boolean): Promise<void>;
  arrangeAuthorizations(authorizations: string[]): Promise<void>;
}

/** How a command the native side didn't answer in time ends: written later, or never. */
const unanswered = <A extends unknown[]>(
  how: "written late" | "never written",
  command: (...args: A) => Promise<unknown>,
) =>
  how === "written late"
    ? late(command)
    : async (..._args: A): Promise<never> => {
        throw busy();
      };

export {
  memory,
  viewingSaves,
  holdingViewingSaves,
  native,
  DiskFile,
  Folder,
  background,
  fixture,
  ONE,
  one,
  two,
  movie,
  otherMovie,
  episode,
  until,
  launch,
  install,
  installedApp,
  withProviders,
  movieRef,
  statusOf,
  isComplete,
  doc,
  downloadSecrets,
  nativeSecrets,
  receivedOf,
  sleep,
  folder,
  mediaFile,
  everythingStored,
  playFilm,
  appGoes,
  busy,
  late,
  bridge,
  unanswered,
};
export type { App };
