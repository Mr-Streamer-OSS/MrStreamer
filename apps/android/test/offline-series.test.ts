import { expect, it, vi } from "vitest";
import { offlineNext } from "../src/downloads/offline-next.ts";
import { seriesDownloads, seriesFiles } from "../src/downloads/series.ts";
import type { DownloadRow } from "../src/downloads/state.ts";
import { fixture } from "./library-fixture.ts";

const row: DownloadRow = {
  id: "one",
  key: "one",
  sourceId: "source",
  sourceLabel: "Source",
  title: "Series",
  kind: "episode",
  mediaId: "first",
  container: "mp4",
  state: "complete",
  bytes: 8,
  total: 8,
  reason: "",
  seriesId: "series",
  order: ["first", "second", "third"],
};

it("continues only to the checked immediate copy, never skipping or streaming a gap", async () => {
  let rows: DownloadRow[] = [];
  const path = vi.fn(async () => "/saved/second");
  const port = { snapshot: async () => JSON.stringify({ rows, free: 1 }), path };
  expect(await offlineNext(port, row)).toEqual({ kind: "not-saved" });
  rows = [{ ...row, id: "third", mediaId: "third" }];
  expect(await offlineNext(port, row)).toEqual({ kind: "not-saved" });
  const second = { ...row, id: "second", mediaId: "second" };

  for (const state of ["queued", "running", "paused"] as const) {
    rows = [{ ...second, state }];
    expect(await offlineNext(port, row)).toMatchObject({ kind: "downloading" });
  }

  expect(path).not.toHaveBeenCalled();
  rows = [second];
  expect(await offlineNext(port, row)).toEqual({
    kind: "ready",
    path: "/saved/second",
    row: second,
  });
  path.mockImplementation(async () => {
    rows = [{ ...second, state: "failed", reason: "file-changed" }];
    throw new Error("changed");
  });
  expect(await offlineNext(port, row)).toMatchObject({ kind: "changed" });
  rows = [{ ...second, state: "failed", reason: "missing" }];
  expect(await offlineNext(port, row)).toMatchObject({ kind: "missing" });
  expect(
    await offlineNext(
      {
        ...port,
        snapshot: async () => {
          throw new Error("read");
        },
      },
      row,
    ),
  ).toEqual({ kind: "read" });
});

async function files() {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("series").list("all")[0]!;
  const details = await f.model.details(title);

  if (details.value?.kind !== "series") throw new Error("series");

  return seriesFiles(details.value, title, details.containers, "Source", { kind: "series" });
}

it("freezes exact counts and iOS order including Specials, then cancels only unqueued work", async () => {
  const all = await files();
  expect(all.map((f) => f.mediaId)).toEqual(["first", "second", "special"]);
  let release: (value: string) => void = () => {};

  const admit = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );

  const controller = seriesDownloads(
    {
      review: async () => JSON.stringify({ token: "review", snapshot: { rows: [], free: 1 } }),
      admit,
      endReview: vi.fn(async () => {}),
    },
    async () => true,
    async () => {},
  );

  const plan = await controller.plan(all);
  expect(plan).toMatchObject({ held: 0, add: 3, retry: 0, missing: 0 });
  const result = controller.start(plan, false, () => null);
  await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
  controller.stop();
  release("added");
  expect(await result).toMatchObject({ added: 1, failed: [], unqueued: 2, stopped: "cancelled" });
  expect(admit).toHaveBeenCalledTimes(1);
});

it("counts durable skips and failed additions separately, and stops at changed login", async () => {
  const all = await files();

  const admit = vi
    .fn()
    .mockResolvedValueOnce("skipped")
    .mockRejectedValueOnce(new Error("disk"))
    .mockResolvedValueOnce("login");

  const controller = seriesDownloads(
    {
      review: async () => JSON.stringify({ token: "review", snapshot: { rows: [], free: 1 } }),
      admit,
      endReview: vi.fn(async () => {}),
    },
    async () => true,
    async () => {},
  );

  const plan = await controller.plan(all);
  expect(await controller.start(plan, false, () => null)).toMatchObject({
    added: 0,
    skipped: 1,
    failed: [all[1]],
    unqueued: 1,
    stopped: "login",
  });
});
