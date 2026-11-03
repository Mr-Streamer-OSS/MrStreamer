import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playerState: { kind: "playing", intent: { kind: "file", path: "/private/copy", title: "Copy" } },
  release: vi.fn(),
  command: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  blockSource: vi.fn(async () => {}),
  restore: vi.fn(async () => JSON.stringify({ rows: [], free: 1 })),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    filePath: async () => "/private/copy",
    command: mocks.command,
    restore: mocks.restore,
    blockSource: mocks.blockSource,
    snapshot: async () => JSON.stringify({ rows: [], free: 1 }),
  }),
}));

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));

vi.mock("react-native", () => ({
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
