import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playerState: { kind: "playing", intent: { kind: "file", path: "/private/copy", title: "Copy" } },
  release: vi.fn(),
  command: vi.fn(),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    filePath: async () => "/private/copy",
    command: mocks.command,
    snapshot: async () => JSON.stringify({ rows: [], free: 1 }),
  }),
}));

vi.mock("react-native", () => ({ AppState: {} }));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/library/runtime.ts", () => ({ library: vi.fn() }));

vi.mock("../src/player/instance.ts", () => ({
  player: {
    state: { get: () => mocks.playerState },
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
