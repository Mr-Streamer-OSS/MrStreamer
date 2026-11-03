import { expect, it, vi } from "vitest";
import { downloadState, type TransferPort } from "../src/downloads/state.ts";

it("keeps the last queue after a failed read and allows a retry", async () => {
  let broken = false;
  const snapshot = { rows: [], free: 123 };

  const read = async () => {
    if (broken) throw new Error("read");

    return JSON.stringify(snapshot);
  };

  const native: TransferPort = {
    restore: read,
    snapshot: read,
    enqueue: vi.fn(),
    cacheArtwork: vi.fn(),
    command: vi.fn(),
    path: vi.fn(),
    filePath: vi.fn(),
    blockSource: vi.fn(),
  };

  const model = downloadState(native);
  await model.refresh(true);
  expect(model.state.get()).toMatchObject({ free: 123, error: null, loading: false });
  broken = true;
  await model.refresh();
  expect(model.state.get()).toMatchObject({ free: 123, error: "read" });
  broken = false;
  await model.refresh();
  expect(model.state.get().error).toBeNull();
});

it("reports a failed command and never publishes a successful save", async () => {
  const read = vi.fn(async () => JSON.stringify({ rows: [], free: 123 }));

  const native: TransferPort = {
    restore: read,
    snapshot: read,
    enqueue: vi.fn(),
    cacheArtwork: vi.fn(),
    command: vi.fn(),
    path: vi.fn(),
    filePath: vi.fn(),
    blockSource: vi.fn(),
  };

  const model = downloadState(native);
  await model.refresh();
  read.mockClear();
  await model.change(async () => {
    throw new Error("write");
  });
  expect(model.state.get().error).toBe("write");
  expect(read).not.toHaveBeenCalled();
});

it("rejects a damaged native snapshot rather than claiming an empty queue", async () => {
  const read = async () => JSON.stringify({ rows: [{ state: "complete" }], free: 0 });

  const native: TransferPort = {
    restore: read,
    snapshot: read,
    enqueue: vi.fn(),
    cacheArtwork: vi.fn(),
    command: vi.fn(),
    path: vi.fn(),
    filePath: vi.fn(),
    blockSource: vi.fn(),
  };

  const model = downloadState(native);
  await model.refresh(true);
  expect(model.state.get().error).toBe("read");
});

it("keeps optional title facts and accepts ledgers created before facts were saved", async () => {
  const old = {
    id: "old",
    key: "old",
    sourceId: "source",
    title: "Title",
    sourceLabel: "Source",
    kind: "movie",
    mediaId: "one",
    container: "mkv",
    state: "queued",
    bytes: 0,
    total: 0,
    reason: "",
  };

  const facts = {
    ...old,
    id: "new",
    year: 2026,
    duration: 2700,
    season: 2,
    episode: 3,
    episodeName: "Crossing",
  };

  const read = async () => JSON.stringify({ rows: [old, facts], free: 10 });

  const port: TransferPort = {
    snapshot: read,
    restore: read,
    enqueue: vi.fn(),
    command: vi.fn(),
    path: vi.fn(),
    filePath: vi.fn(),
    blockSource: vi.fn(),
    cacheArtwork: vi.fn(),
  };

  const model = downloadState(port);
  await model.refresh();
  expect(model.state.get().error).toBeNull();
  expect(model.state.get().rows).toEqual([old, facts]);
});
