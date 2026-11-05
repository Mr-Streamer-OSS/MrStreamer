import { enterPreview, exitPreview, providerPrompt } from "../src/preview/session.ts";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playerState: { kind: "playing", intent: { kind: "file", path: "/private/copy", title: "Copy" } },
  notification: vi.fn(async () => "granted"),
  cacheArtwork: vi.fn(async () => {}),
  review: vi.fn(),
  admit: vi.fn(),
  rows: [] as import("../src/downloads/state.ts").DownloadRow[],
  release: vi.fn(),
  command: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  blockSource: vi.fn(async () => {}),
  restore: vi.fn(async () => JSON.stringify({ rows: [], free: 1 })),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    review: mocks.review,
    admit: mocks.admit,
    endReview: async () => {},
    cacheArtwork: mocks.cacheArtwork,
    filePath: async () => "/private/copy",
    command: mocks.command,
    restore: mocks.restore,
    blockSource: mocks.blockSource,
    snapshot: async () => JSON.stringify({ rows: mocks.rows, free: 1 }),
  }),
}));

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));

vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 34 },
  PermissionsAndroid: {
    request: mocks.notification,
    PERMISSIONS: { POST_NOTIFICATIONS: "notifications" },
  },
  AppState: { addEventListener: () => ({ remove: vi.fn() }), currentState: "active" },
}));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/library/runtime.ts", () => ({ library: vi.fn() }));

vi.mock("../src/player/instance.ts", () => ({
  player: {
    state: { get: () => mocks.playerState, subscribe: mocks.subscribe },
    release: mocks.release,
  },
}));

import { downloads } from "../src/downloads/runtime.ts";
import type { DownloadRow } from "../src/downloads/state.ts";

it("refuses deletion while playing or closing, then removes only after confirmed closure", async () => {
  const owner = downloads();

  const row: DownloadRow = {
    id: "copy",
    key: "copy",
    sourceId: "source",
    title: "Copy",
    sourceLabel: "Source",
    kind: "movie",
    mediaId: "1",
    container: "mp4",
    state: "complete",
    bytes: 8,
    total: 8,
    reason: "",
  };

  expect(await owner.command(row, "remove")).toBe("playing");
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.release).not.toHaveBeenCalled();
  mocks.playerState.intent.path = "/other/copy";
  mocks.release.mockResolvedValueOnce([{ outcome: "unconfirmed" }]);
  expect(await owner.command(row, "remove")).toBe("closing");
  expect(mocks.command).not.toHaveBeenCalled();
  mocks.release.mockResolvedValueOnce([{ outcome: "file-closed" }]);
  expect(await owner.command(row, "remove")).toBeNull();
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith("copy", "remove");
});

it("keeps registration alive until the last lease and ignores a stale cleanup", async () => {
  vi.useFakeTimers();

  try {
    const owner = downloads();
    const first = owner.start();
    const second = owner.start(true);
    const { libraryIntents } = await import("../src/library/intents.ts");
    first();
    expect(libraryIntents.state.get().download).toBeTypeOf("function");
    second();
    expect(libraryIntents.state.get().download).toBeUndefined();
    const third = owner.start();
    first();
    expect(libraryIntents.state.get().download).toBeTypeOf("function");
    third();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "settles durable bulk admissions and cancellation while artwork is pending (%s)",
  async (cancel) => {
    mocks.cacheArtwork.mockClear();
    let releaseArtwork!: () => void;
    mocks.cacheArtwork.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseArtwork = resolve;
        }),
    );
    const { fixture } = await import("./library-fixture.ts");
    const { seriesFiles } = await import("../src/downloads/series.ts");
    const f = fixture();
    await f.model.refresh();
    const title = f.model.made("series").list("all")[0]!;
    const details = await f.model.details(title);

    if (details.value?.kind !== "series") throw new Error("series");

    const files = seriesFiles(details.value, title, details.containers, "Source", {
      kind: "series",
    }).map((file) => ({ ...file, poster: "https://fixture.invalid/poster" }));

    mocks.review.mockResolvedValue(
      JSON.stringify({ token: "bulk", snapshot: { rows: [], free: 1 } }),
    );
    Object.assign(mocks.playerState.intent, { kind: "title", sourceId: "source" });
    mocks.admit.mockImplementation(async (_token: string, key: string) => {
      if (!cancel) expect(mocks.blockSource).toHaveBeenCalledWith("source", true);
      const file = files.find((file) => file.key === key)!;
      mocks.rows.push({
        ...file,
        order: [...file.order],
        id: key,
        state: "queued",
        bytes: 0,
        total: 0,
        reason: "",
      });

      if (cancel) controller.stop();

      return "added";
    });
    const owner = downloads();
    const controller = owner.series();
    const plan = await controller.plan(files);
    const result = await controller.start(plan, false, () => null);
    expect(result).toMatchObject({
      added: cancel ? 1 : 3,
      failed: [],
      stopped: cancel ? "cancelled" : null,
    });

    if (!cancel) expect(mocks.notification).toHaveBeenCalledExactlyOnceWith("notifications");
    expect(mocks.cacheArtwork).toHaveBeenCalledTimes(1);
    mocks.cacheArtwork.mockResolvedValue(undefined);
    releaseArtwork();
    await vi.waitFor(() => expect(mocks.cacheArtwork).toHaveBeenCalledTimes(cancel ? 1 : 3));
    expect(mocks.cacheArtwork).toHaveBeenCalledWith(
      files[0]!.key,
      "https://fixture.invalid/poster",
    );
    mocks.rows = [];
    mocks.playerState.intent.kind = "file";
  },
);

it("refuses destructive real-download actions in preview before reading or writing native state", async () => {
  const owner = downloads();

  const row = {
    id: "copy",
    key: "copy",
    sourceId: "real",
    title: "Copy",
    sourceLabel: "Real",
    kind: "movie",
    mediaId: "1",
    container: "mp4",
    state: "complete",
    bytes: 1,
    total: 1,
    reason: "",
  } as const;

  const native = vi.spyOn(owner.native, "filePath");
  mocks.command.mockClear();
  mocks.review.mockClear();
  mocks.release.mockClear();
  enterPreview();

  try {
    await owner.command(row, "remove");
    expect(providerPrompt.get()).toBe("download");
    await owner.replace(row);
    expect(native).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
    exitPreview();
  }
});
