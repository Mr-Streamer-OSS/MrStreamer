import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadRow } from "../src/downloads/state.ts";

const mocks = vi.hoisted(() => ({
  state: { kind: "idle", intent: { kind: "movie", sourceId: "B" }, phase: "playing" },
  listener: () => {},
  release: vi.fn(async () => [] as { outcome: string }[]),
  block: vi.fn(async (_source: string, _blocked: boolean) => {}),
  command: vi.fn(async () => {}),
  path: vi.fn(async () => "/private/copy"),
  play: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    restore: async () => JSON.stringify({ rows: [], free: 1 }),
    snapshot: async () => JSON.stringify({ rows: [], free: 1 }),
    blockSource: mocks.block,
    command: mocks.command,
    path: mocks.path,
    filePath: async () => "/private/copy",
  }),
}));

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
}));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/library/runtime.ts", () => ({ library: vi.fn() }));

vi.mock("../src/player/instance.ts", () => ({
  player: {
    state: {
      get: () => mocks.state,
      subscribe: (listener: () => void) => {
        mocks.listener = listener;

        return () => {};
      },
    },
    release: mocks.release,
    play: mocks.play,
  },
}));

const row: DownloadRow = {
  id: "copy",
  key: "copy",
  sourceId: "B",
  sourceLabel: "Source",
  title: "Copy",
  kind: "movie",
  mediaId: "1",
  container: "mp4",
  state: "complete",
  bytes: 8,
  total: 8,
  reason: "",
};

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state = { kind: "playing", intent: { kind: "movie", sourceId: "B" }, phase: "playing" };
  mocks.release.mockResolvedValue([]);
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

async function started() {
  const { downloads } = await import("../src/downloads/runtime.ts");
  const owner = downloads();
  stop = owner.start();
  await vi.waitFor(() => expect(mocks.block).toHaveBeenCalledWith("B", true));

  return owner;
}

it("keeps an unconfirmed release blocked after later empty releases", async () => {
  await started();
  mocks.release.mockResolvedValueOnce([{ outcome: "unconfirmed" }]);
  mocks.state.kind = "idle";
  mocks.listener();
  await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
  mocks.listener();
  // A new playback source gives an observable completion of the next authority pass.
  mocks.state.kind = "playing";
  mocks.state.intent.sourceId = "C";
  mocks.listener();
  await vi.waitFor(() => expect(mocks.block).toHaveBeenCalledWith("C", true));
  expect(mocks.block).not.toHaveBeenCalledWith("B", false);
});

it("abandons a superseded source change before releasing the current source", async () => {
  await started();
  const gate = Promise.withResolvers<void>();
  mocks.block.mockImplementationOnce(() => gate.promise);
  mocks.state.intent.sourceId = "A";
  mocks.listener();
  await vi.waitFor(() => expect(mocks.block).toHaveBeenCalledWith("A", true));
  mocks.state.intent.sourceId = "B";
  mocks.listener();
  gate.resolve();
  await vi.waitFor(() => expect(mocks.block).toHaveBeenCalledWith("A", false));
  expect(mocks.block).not.toHaveBeenCalledWith("B", false);
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("releases source authority when the last lease stops", async () => {
  await started();
  stop?.();
  stop = undefined;
  await vi.waitFor(() => expect(mocks.block).toHaveBeenCalledWith("B", false));
});

it("guards a delayed remove retry against opening the same copy", async () => {
  const owner = await started();
  mocks.command.mockRejectedValueOnce(new Error("write"));
  await owner.command(row, "remove");
  const gate = Promise.withResolvers<{ outcome: string }[]>();
  mocks.release.mockImplementationOnce(() => gate.promise);
  const retry = owner.retry();
  await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(2));
  await expect(owner.playCopy(row)).rejects.toThrow("removing");
  gate.resolve([{ outcome: "unconfirmed" }]);
  await retry;
  expect(mocks.command).toHaveBeenCalledOnce();
  expect(mocks.alert).toHaveBeenCalled();
});

it("refreshes the missing-file row before refusing offline playback", async () => {
  const owner = await started();
  vi.spyOn(owner.native, "snapshot").mockResolvedValue(
    JSON.stringify({ rows: [{ ...row, state: "failed", reason: "missing" }], free: 1 }),
  );
  mocks.path.mockRejectedValueOnce(new Error("missing"));
  await expect(owner.playCopy(row)).rejects.toThrow("missing");
  expect(owner.state.get().rows[0]?.reason).toBe("missing");
  expect(owner.state.get().error).toBeNull();
  expect(mocks.play).not.toHaveBeenCalled();
});
