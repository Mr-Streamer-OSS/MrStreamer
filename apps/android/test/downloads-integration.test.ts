import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadIntent, MediaIdentity } from "../src/library/intents.ts";
import type { DownloadRow } from "../src/downloads/state.ts";

const mocks = vi.hoisted(() => ({
  rows: [] as DownloadRow[],
  roster: [{ id: "source", label: "Saved source" }],
  title: { title: "Saved title", year: 2024, posterUrl: "artwork" },
  containers: new Map<string, string>(),
  details: {
    kind: "movie",
    duration: 90,
    seasons: [] as {
      episodes: {
        id: string;
        subscriptionId: string;
        duration: number;
        season: number;
        number: number;
        title: string;
      }[];
    }[],
  },
  enqueue: vi.fn(async (_json: string) => "copy"),
  artwork: vi.fn(async () => {}),
  request: vi.fn(async () => "granted"),
  restore: vi.fn(async (): Promise<string> => JSON.stringify({ rows: [], free: 1 })),
  snapshot: vi.fn(async (): Promise<string> => ""),
  block: vi.fn(async (_source: string, _blocked: boolean) => {}),
  state: { kind: "idle", phase: "playing", intent: { kind: "movie", sourceId: "source" } },
  app: { currentState: "active" },
  listener: (_state: string) => {},
  remove: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    enqueue: mocks.enqueue,
    cacheArtwork: mocks.artwork,
    restore: mocks.restore,
    snapshot: mocks.snapshot,
    blockSource: mocks.block,
  }),
}));

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: "android", Version: 34 },
  PermissionsAndroid: {
    request: mocks.request,
    PERMISSIONS: { POST_NOTIFICATIONS: "notifications" },
  },
  AppState: Object.assign(mocks.app, {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listener = listener;

      return { remove: mocks.remove };
    },
  }),
}));

vi.mock("../src/bootstrap/sources.ts", () => ({
  sources: { state: { get: () => ({ kind: "ready", sources: mocks.roster }) } },
}));

vi.mock("../src/library/runtime.ts", () => ({
  library: () => ({
    title: () => mocks.title,
    details: async () => ({ value: mocks.details, containers: mocks.containers }),
  }),
}));

vi.mock("../src/player/instance.ts", () => ({
  player: {
    state: { get: () => mocks.state, subscribe: () => mocks.unsubscribe },
    release: async () => [],
  },
}));

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.roster = [{ id: "source", label: "Saved source" }];
  mocks.containers = new Map([
    ["movie", "mkv"],
    ["episode", "mp4"],
  ]);
  mocks.details = { kind: "movie", duration: 90, seasons: [] };
  mocks.app.currentState = "active";
  mocks.state.kind = "idle";
  mocks.enqueue.mockResolvedValue("copy");
  mocks.artwork.mockResolvedValue(undefined);
  mocks.restore.mockImplementation(async () => JSON.stringify({ rows: mocks.rows, free: 1 }));
  mocks.snapshot.mockImplementation(async () => JSON.stringify({ rows: mocks.rows, free: 1 }));
  mocks.block.mockResolvedValue(undefined);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

const movie: MediaIdentity = {
  kind: "movie",
  sourceId: "source",
  titleKey: "title",
  titleId: "movie",
  version: { id: "movie", subscriptionId: "source", tags: [], container: "avi" },
};

async function start(screen = false) {
  const { downloads } = await import("../src/downloads/runtime.ts");
  const owner = downloads();
  stop = owner.start(screen);
  await vi.waitFor(() => expect(owner.state.get().loading).toBe(false));
  const { libraryIntents, libraryDownloads } = await import("../src/library/intents.ts");

  const download = (media: MediaIdentity) =>
    libraryIntents.state.get().download?.({ action: "download", media } satisfies DownloadIntent);

  return { owner, download, presentation: libraryDownloads };
}

it("enqueues saved movie and episode facts and asks permission only on the first explicit download", async () => {
  const { owner, download } = await start();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.artwork.mockRejectedValue(new Error("optional artwork"));
  download(movie);
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.enqueue.mock.calls[0]![0])).toEqual({
    key: JSON.stringify(["source", "movie", "movie", "mkv"]),
    sourceId: "source",
    sourceLabel: "Saved source",
    kind: "movie",
    mediaId: "movie",
    container: "mkv",
    title: "Saved title",
    year: 2024,
    duration: 90,
  });
  await vi.waitFor(() => expect(mocks.artwork).toHaveBeenCalledOnce());
  await owner.refresh();
  expect(owner.state.get().error).toBeNull();
  mocks.details = {
    kind: "series",
    duration: 90,
    seasons: [
      {
        episodes: [
          {
            id: "episode",
            subscriptionId: "other",
            duration: 1,
            season: 9,
            number: 9,
            title: "Wrong",
          },
          {
            id: "episode",
            subscriptionId: "source",
            duration: 42,
            season: 2,
            number: 3,
            title: "Episode",
          },
        ],
      },
    ],
  };
  download({ ...movie, kind: "episode", episodeId: "episode" });
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
  expect(JSON.parse(mocks.enqueue.mock.calls[1]![0])).toEqual({
    key: JSON.stringify(["source", "episode", "episode", "mp4"]),
    sourceId: "source",
    sourceLabel: "Saved source",
    kind: "episode",
    mediaId: "episode",
    container: "mp4",
    title: "Saved title",
    year: 2024,
    duration: 42,
    season: 2,
    episode: 3,
    episodeName: "Episode",
  });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("notifications");
});

it("keeps missing source and container failures tap-local and retries the original intent", async () => {
  const { owner, download, presentation } = await start();
  mocks.roster = [];
  download(movie);
  await vi.waitFor(() => expect(presentation.state.get()?.read(movie)?.icon).toBe("retry"));
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.roster = [{ id: "source", label: "Saved source" }];
  presentation.state.get()?.read(movie)?.activate();
  await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(owner.state.get().error).toBeNull());
  mocks.containers.clear();
  const missing = { ...movie, titleId: "missing", version: { ...movie.version, container: "" } };
  download(missing);
  await vi.waitFor(() => expect(presentation.state.get()?.read(missing)?.icon).toBe("retry"));
  expect(presentation.state.get()?.read(movie)?.icon).not.toBe("retry");
  expect(mocks.enqueue).toHaveBeenCalledOnce();
});

it("polls visible and queued work only while active and tears down the last lease", async () => {
  vi.useFakeTimers();
  const { owner } = await start();
  mocks.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  const screen = owner.start(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  screen();
  mocks.rows = [
    {
      id: "copy",
      key: "key",
      sourceId: "source",
      sourceLabel: "Source",
      title: "Title",
      kind: "movie",
      mediaId: "movie",
      container: "mkv",
      state: "queued",
      bytes: 0,
      total: 0,
      reason: "",
    },
  ];
  await owner.refresh();
  mocks.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  mocks.app.currentState = "background";
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  mocks.app.currentState = "active";
  mocks.listener("active");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  stop?.();
  stop = undefined;
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});

it("retries source holds independently of idle polling and does not reacquire after startup stops", async () => {
  vi.useFakeTimers();
  mocks.state.kind = "playing";
  mocks.block.mockRejectedValueOnce(new Error("hold failed"));
  await start();
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.block).toHaveBeenCalledTimes(2);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  stop?.();
  stop = undefined;
  await vi.advanceTimersByTimeAsync(0);
  const gate = Promise.withResolvers<string>();
  mocks.restore.mockReturnValueOnce(gate.promise);
  // A fresh owner models startup finishing after its last consumer disappeared.
  vi.resetModules();
  const { downloads } = await import("../src/downloads/runtime.ts");
  const owner = downloads();
  const cleanup = owner.start();
  cleanup();
  mocks.block.mockClear();
  gate.resolve(JSON.stringify({ rows: [], free: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.state.get().loading).toBe(false);
  expect(mocks.block).not.toHaveBeenCalledWith("source", true);
});
