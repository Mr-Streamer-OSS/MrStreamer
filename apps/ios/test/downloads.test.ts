import type { Download, DownloadStatus } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Downloads through the app's own owners: the account, its two fake Xtream panels over HTTP (the
// desktop tests' fake provider, one connection each, closed slots freed at once), the title
// lists, the one player and the downloads owner. expo-file-system is `native-files.ts`, a model of
// Expo's DownloadTask over real files and real requests; the Keychain is kept in memory, and a
// relaunch imports the app's modules again over the same Documents and Keychain. What only iOS
// can show (URLSession's own resume data, suspension in the background, playing the file) is not
// proved here.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** The address the player was given last, and how many file streams each panel had open then. */
  /** What the player was given, and how many download requests were still open then. */
  played: [] as { readonly uri: string; readonly downloading: number }[],
  downloading: (): number => 0,
  player: null as null | {
    currentTime: number;
    duration: number;
    emit(event: string, payload: unknown): void;
  },
  appState: "active" as string,
  appListeners: [] as Array<(state: string) => void>,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("react-native", () => ({
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
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void memory.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void memory.keychain.delete(key),
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => {
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const player = {
      currentTime: 0,
      duration: 0,
      muted: true,
      addListener: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit: (event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
      replaceAsync: async (source: { uri: string } | null) => {
        if (source) memory.played.push({ uri: source.uri, downloading: memory.downloading() });
      },
      play: () => undefined,
      pause: () => undefined,
    };
    memory.player = player;
    return player;
  },
}));

const { native, File: DiskFile, Directory: Folder } = await import("./native-files.ts");

interface FakeTitle {
  readonly id: number;
  readonly name: string;
  readonly fixture: string | null;
}
interface FakeSeries {
  readonly id: number;
  readonly seasons: readonly (readonly (FakeTitle & { readonly number?: number })[])[];
}
interface FakeProvider {
  readonly url: string;
  readonly titles: {
    readonly movies: readonly FakeTitle[];
    readonly series: readonly FakeSeries[];
  };
  activeStreams(): number;
  fileRequests(): number;
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
    startFakeProvider({ ...ONE, channels: 20, titles: 10, slotReleaseMs: 0 }),
    startFakeProvider({ ...TWO, channels: 20, titles: 10, slotReleaseMs: 0, second: true }),
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
  one.stallMovieFile(movie().id, 0, 0);
  one.stallMovieFile(otherMovie().id, 0, 0);
  memory.appState = "active";
  // What an earlier launch left streaming ends before the next test asks the panels for files.
  await until(() => one.activeStreams() === 0 && two.activeStreams() === 0, "the panels to idle");
});

async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/**
 * The app as a launch starts it: what the last process transferred ends with it, as a foreground
 * session's tasks do, and fresh modules start over the same files and Keychain.
 */
async function launch() {
  native.kill();
  vi.resetModules();
  memory.appListeners.length = 0;
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const playback = await import("../src/playback.ts");
  const viewing = await import("../src/viewing.ts");
  const downloads = await import("../src/downloads.ts");
  await account.restore();
  downloads.startDownloads();
  return { ...titles, ...playback, ...viewing, ...downloads, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

/** A fresh install: nothing in Documents or the Keychain. */
function install() {
  const documents = new Folder(native.root, "documents");
  documents.delete();
  documents.create();
  native.free = 64 * 1024 * 1024 * 1024;
  native.requests.length = 0;
  native.pauseMs = 0;
  memory.keychain.clear();
  memory.played.length = 0;
}

async function withProviders(app: App, both = false) {
  const a = await app.add({ server: one.url, ...ONE });
  const b = both ? await app.add({ server: two.url, ...TWO }) : null;
  const listed = () => {
    const lists = app.titleLists();
    return (
      lists.kind === "ready" && app.members().every((member) => member.titles.kind === "ready")
    );
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
const downloadSecrets = () =>
  [...memory.keychain.keys()].filter((key) => key.startsWith("s.download"));
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

/** Sends the app to the background and back, as iOS reports it. */
function appGoes(state: "background" | "active") {
  memory.appState = state;
  for (const listener of memory.appListeners) listener(state);
}

describe("downloads", { timeout: 30_000 }, () => {
  it("transfers one at a time, a movie then an episode, and keeps no login with them", async () => {
    install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    const film = await app.addDownload(movieRef(a));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    expect(film.subscription?.id).toBe(a);
    await until(() => isComplete(app, film.id) && isComplete(app, show.id), "both copies");
    expect(one.mostFilesAtOnce()).toBe(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    const listed = app.downloadList();
    expect(listed.items.map((item) => item.id)).toEqual([show.id, film.id]);
    expect(listed.bytes).toBe(fixture(movie().fixture!).length + fixture(first.fixture!).length);
    expect(listed.items.find((item) => item.id === show.id)?.episodeName).not.toBeNull();
    // Nothing kept on disk names the address, the username or the password; nor the Keychain.
    const stored = everythingStored();
    for (const secret of [ONE.password, encodeURIComponent(ONE.password), `/${ONE.username}/`]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain("/movie/");
    expect(downloadSecrets()).toEqual([]);
    expect(doc().forgetting).toEqual([]);
  });

  it("answers a title asked for twice with one download, and keeps two providers' same id apart", async () => {
    install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 30_000);
    const [first, second] = await Promise.all([
      app.addDownload(movieRef(a)),
      app.addDownload(movieRef(a)),
    ]);
    expect(second.id).toBe(first.id);
    const theirs = await app.addDownload(movieRef(b!));
    expect(theirs.id).not.toBe(first.id);
    expect(doc().items).toHaveLength(2);
    expect(app.downloadOf(movieRef(b!))?.id).toBe(theirs.id);
    expect(app.downloadOf(movieRef(a))?.id).toBe(first.id);
    await app.removeDownload(first.id);
    await until(() => isComplete(app, theirs.id), "the second provider's copy");
    expect(app.downloadOf(movieRef(a))).toBeUndefined();
  });

  it("cancels a transfer under way: its request ends and nothing of it stays", async () => {
    install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 30_000);
    const film = await app.addDownload(movieRef(a));
    await until(
      () => (statusOf(app, film.id) as { received?: number } | undefined)?.received === 20_000,
      "the transfer to stall",
    );
    expect(one.activeStreams()).toBe(1);
    await app.removeDownload(film.id);
    await until(() => one.activeStreams() === 0, "the request to end");
    expect(app.downloadList().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    expect(doc().items).toEqual([]);
    expect(downloadSecrets()).toEqual([]);
  });

  it("fails while the provider refuses the file, and completes once retried", async () => {
    install();
    const app = await launch();
    const { a } = await withProviders(app);
    // Every connection the subscription allows is in use elsewhere.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const held = new AbortController();
    const login = `${ONE.username}/${encodeURIComponent(ONE.password)}`;
    await fetch(`${one.url}/movie/${login}/${otherMovie().id}.mp4`, { signal: held.signal });
    expect(one.activeStreams()).toBe(1);
    const film = await app.addDownload(movieRef(a));
    await until(() => statusOf(app, film.id)?.kind === "failed", "the refusal");
    expect(statusOf(app, film.id)).toEqual({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "refused", status: 403 } },
    });
    held.abort();
    await until(() => one.activeStreams() === 0, "the other connection to close");
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the retried copy");
    // Added again once failed, a download is queued again rather than duplicated.
    expect(doc().items).toHaveLength(1);
  });

  it("pauses in the background, keeps resume data only in the Keychain, and goes on after a relaunch", async () => {
    install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(
      () => (statusOf(app, film.id) as { received?: number } | undefined)?.received === 30_000,
      "the transfer to stall",
    );
    appGoes("background");
    await until(() => downloadSecrets().length === 1, "the resume data");
    await until(() => one.activeStreams() === 0, "the request to end");
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    const [secret] = downloadSecrets();
    expect(JSON.parse(memory.keychain.get(secret!)!).resumeData).toBeTruthy();
    expect(everythingStored()).not.toContain("resumeData");
    expect(doc().items[0]).toMatchObject({ state: "queued", received: 30_000 });
    // Killed in the background; the next launch, in the foreground, goes on from where it paused.
    native.requests.length = 0;
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, film.id), "the resumed copy");
    expect(native.requests.map((each) => each.range)).toEqual(["bytes=30000-"]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    expect(downloadSecrets()).toEqual([]);
  });

  it("starts again, and says so, when the provider's file changed while it was paused", async () => {
    install();
    let app = await launch();
    const { a } = await withProviders(app);
    const id = otherMovie().id;
    one.stallMovieFile(id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a, id));
    await until(
      () => (statusOf(app, film.id) as { received?: number } | undefined)?.received === 30_000,
      "the transfer to stall",
    );
    appGoes("background");
    await until(() => downloadSecrets().length === 1, "the resume data");
    const replacement = fixture("title-caption-track.mov");
    one.replaceMovieFile(id, replacement);
    one.stallMovieFile(id, 0, 0);
    memory.appState = "active";
    app = await launch();
    let restarted = false;
    const off = app.onDownloads(() => {
      const status = statusOf(app, film.id);
      if (status?.kind === "transferring" && status.restarted) restarted = true;
    });
    await until(() => isComplete(app, film.id), "the copy of the new file");
    off();
    expect(restarted).toBe(true);
    expect(mediaFile(film.id)?.size).toBe(replacement.length);
  });

  it("deletes a file left beside an unfinished download, rather than calling it complete", async () => {
    install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => folder(film.id).exists, "its folder");
    // A whole file of the right size, but no completion was ever written down for it.
    const left = new DiskFile(folder(film.id), "media.mp4");
    left.writeSync("x".repeat(fixture(movie().fixture!).length));
    one.stallMovieFile(movie().id, 0, 0);
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(mediaFile(film.id)?.textSync()).not.toMatch(/^x+$/);
  });

  it("gives its provider's connection to a stream first, and goes on once the stream stops", async () => {
    install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    await until(() => app.currentCatalogue().kind === "ready", "the channels");
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => one.activeStreams() === 1, "the transfer");
    const channelOf = (subscriptionId: string) => {
      const now = app.currentCatalogue();
      if (now.kind !== "ready") throw new Error("No channels");
      return [...now.library.byKey.values()].find(
        (each) => each.subscriptionId === subscriptionId,
      )!;
    };
    // Another provider's channel: the transfer goes on.
    app.playChannel(channelOf(b!), "", { watch: true });
    await until(() => memory.played.length === 1, "the other channel");
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    expect(one.activeStreams()).toBe(1);
    // Its own provider's channel: the transfer's request ended before the stream was opened, though
    // URLSession took a while to end it.
    native.pauseMs = 200;
    app.playChannel(channelOf(a), "", { watch: true });
    await until(() => memory.played.length === 2, "the channel");
    expect(memory.played[1]?.downloading).toBe(0);
    expect(statusOf(app, film.id)?.kind).toBe("waiting");
    one.stallMovieFile(movie().id, 0, 0);
    native.requests.length = 0;
    app.stop();
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests[0]?.range).toBe("bytes=20000-");
  });

  it("ends a removed provider's unfinished downloads; its copy stays, plays offline and keeps its progress", async () => {
    install();
    let app = await launch();
    const { a, b } = await withProviders(app, true);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const unfinished = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => one.activeStreams() === 1, "the second transfer");
    // Watched a while from the copy, its subscription still saved: the viewing record has it too.
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    expect(memory.played[0]?.uri).toBe(`file://${mediaFile(kept.id)!.path}`);
    memory.player!.emit("playingChange", { isPlaying: true });
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    app.stop();
    const copyOf = () => app.downloadList().items.find((item) => item.id === kept.id);
    await until(() => copyOf()?.progress?.position === 40, "the copy's progress");
    const recorded = await app.progressOf({ movies: [{ subscriptionId: a, id: kept.title.id }] });
    expect(recorded[0]?.position).toBe(40);

    await app.remove(a, { keepHistory: true });
    await until(() => one.activeStreams() === 0, "the transfer to end");
    await until(() => app.downloadList().items.length === 1, "the unfinished download to go");
    const list = app.downloadList();
    expect(list.ended).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: kept.id,
      subscription: null,
      status: { kind: "complete" },
    });
    expect(folder(unfinished.id).exists).toBe(false);
    expect(downloadSecrets()).toEqual([]);

    // After a relaunch, with no provider for it, it plays from where it was left.
    app = await launch();
    const requests = one.fileRequests();
    app.playDownload(kept.id);
    await until(() => memory.played.length === 2, "the copy to open again");
    expect(memory.played[1]?.uri).toBe(memory.played[0]?.uri);
    expect(app.playbackState.get().phase).toMatchObject({ item: { subscriptionId: null } });
    memory.player!.emit("playingChange", { isPlaying: true });
    Object.assign(memory.player!, { currentTime: 70, duration: 100 });
    app.stop();
    await until(
      () => app.downloadList().items.find((item) => item.id === kept.id)?.progress?.position === 70,
      "the copy's progress",
    );
    expect(one.fileRequests()).toBe(requests);
    expect(app.members().map((member) => member.entry.id)).toEqual([b]);
    const copy: Download | undefined = app.downloadList().items[0];
    expect(copy?.subscription).toBeNull();
  });
});
