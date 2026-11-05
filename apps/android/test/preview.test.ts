import { afterEach, expect, it, vi } from "vitest";
import { discover } from "../src/live/discovery.ts";
import { draftOf, remove, identity, resolve } from "../src/live/model.ts";
import { listsOwner } from "../src/live/store.ts";
import { guide } from "../src/guide/guide.ts";
import { libraryIntents } from "../src/library/intents.ts";
import { browseTvs, connectTv } from "../src/cast/sender.ts";
import { enterPreview, exitPreview, providerPrompt, exampleId } from "../src/preview/session.ts";

vi.mock("expo", () => ({
  requireNativeModule: vi.fn(() => {
    throw new Error("No native work permitted");
  }),
}));

afterEach(exitPreview);

it("explores fictional Live, schedules and programmes offline without writing personal lists", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
  const sources = { kind: "ready", sources: [] } as const;
  const writeJson = vi.fn();
  const lists = listsOwner({ readJson: () => null, writeJson }, () => sources);
  lists.read();
  const before = lists.state.get();
  enterPreview();

  try {
    const row = discover(sources).rows[0]!;
    expect(row.title).toContain("Example");
    expect(resolve(identity(row), sources)).toEqual({ kind: "listed", row });
    const page = await guide.schedule(row.key, { from: Date.now(), until: Date.now() + 86400000 });
    const next = page.programmes[1]!;
    expect((await guide.programme(next.detail))?.title).toContain("Example");
    expect(next.start).toBeGreaterThan(Date.now());
    lists.member("favourites", identity(row), true);
    expect(providerPrompt.get()).toBe("save");
    expect(lists.state.get()).toBe(before);
    expect(writeJson).not.toHaveBeenCalled();
    expect(sources).toEqual({ kind: "ready", sources: [] });
    expect(network).not.toHaveBeenCalled();
    exitPreview();
    expect(discover(sources).rows).toEqual([]);
    expect(resolve(identity(row), sources).kind).toBe("removed");
  } finally {
    network.mockRestore();
  }
});

it("stops receiver discovery and stale example playback links at the same provider boundary", async () => {
  enterPreview();
  const stop = browseTvs();
  expect(providerPrompt.get()).toBe("cast");
  await expect(connectTv({ id: "tv", name: "TV", model: null })).rejects.toThrow();
  stop();
  exitPreview();
  const play = vi.fn();
  const unregister = libraryIntents.register({ play });

  try {
    await libraryIntents.state
      .get()
      .play?.({ kind: "live", sourceId: exampleId, channelId: "1", title: "Example" });
    expect(providerPrompt.get()).toBe("play");
    expect(play).not.toHaveBeenCalled();
    providerPrompt.set(null);
    await libraryIntents.state
      .get()
      .play?.({ kind: "live", sourceId: "real", channelId: "1", title: "Real" });
    expect(play).toHaveBeenCalledOnce();
    expect(providerPrompt.get()).toBeNull();
  } finally {
    unregister();
  }
});

it("refuses example play and deep links before stream resolution or native session admission", async () => {
  const { playerOwner } = await import("../src/player/player.ts");

  const resolve = vi.fn(async () => {
    throw new Error("No stream resolution permitted");
  });

  const admit = vi.fn();
  const command = vi.fn(async () => false);

  const owner = playerOwner(
    {
      admit,
      pause: command,
      resume: command,
      seek: command,
      setSpeed: command,
      setQuality: command,
      stop: command,
      capabilities: () => ({ containers: [], decoders: {} }),
      addListener: () => ({ remove() {} }),
    },
    resolve,
  );

  const action = { kind: "live", sourceId: exampleId, channelId: "1", title: "Example" } as const;
  enterPreview();
  owner.play(action);
  expect(providerPrompt.get()).toBe("play");
  expect(owner.state.get().kind).toBe("idle");
  exitPreview();
  owner.play(action);
  await Promise.resolve();
  expect(providerPrompt.get()).toBe("play");
  expect(resolve).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
  await owner.stop();
});

it("preserves old lists and refuses every preview list write, including stale example creation", () => {
  const entry = { sourceId: "removed", channelId: "1", title: "Old" };

  const saved = {
    version: 1,
    lists: [
      { id: "favourites", name: "Favourites", entries: [entry] },
      { id: "trip", name: "Trip", entries: [entry] },
    ],
  };

  const sources = { kind: "ready", sources: [] } as const;
  const writeJson = vi.fn();
  const lists = listsOwner({ readJson: () => saved, writeJson }, () => sources);
  lists.read();
  const before = lists.state.get();
  const draft = draftOf(before.lists[0]!, sources);
  enterPreview();
  const example = identity(discover(sources).rows[0]!);

  for (const action of [
    () => lists.create("New"),
    () => lists.create("Example", example),
    () => lists.rename("trip", "Renamed"),
    () => lists.delete("trip"),
    () => lists.commit(remove(draft, 0)),
    () => lists.member("favourites", entry, false),
  ]) {
    providerPrompt.set(null);
    expect(action()).toBeFalsy();
    expect(providerPrompt.get()).toBe("save");
    expect(lists.state.get()).toBe(before);
    expect(writeJson).not.toHaveBeenCalled();
  }

  exitPreview();
  lists.commit(remove(draft, 0));
  expect(writeJson).toHaveBeenCalledOnce();
  providerPrompt.set(null);
  expect(lists.create("Stale", example)).toBeFalsy();
  expect(providerPrompt.get()).toBe("save");
  expect(writeJson).toHaveBeenCalledOnce();
});

it("keeps programme identity across schedule, detail, search and listings and rejects unknowns", async () => {
  enterPreview();
  const key = `${exampleId}:1`;
  const now = Date.now();
  const page = await guide.schedule(key, { from: now, until: now + 86400000 });
  const selected = page.programmes[1]!;
  const { detail, ...facts } = selected;
  expect(await guide.programme(detail)).toEqual(facts);
  expect(await guide.programmeAt(key, selected.start + 1)).toEqual(facts);
  expect(
    (await guide.schedule(key, { from: selected.start, until: selected.stop })).programmes[0],
  ).toEqual(selected);
  expect((await guide.search(selected.title, [key])).found).toContainEqual({
    key,
    programme: selected,
  });
  expect((await guide.listings([key])).get(key)?.now).toEqual(
    await guide.programme(page.programmes[0]!.detail),
  );
  expect(await guide.programmeAt("unknown", now)).toBeNull();

  for (const token of [
    `unknown|${selected.start}`,
    `${key}|`,
    `${key}|1`,
    `${key}|${selected.start}|extra`,
  ])
    expect(await guide.programme(token)).toBeNull();
  expect((await guide.schedule("unknown", { from: now, until: now + 1000 })).programmes).toEqual(
    [],
  );
  expect((await guide.search("", ["unknown"])).found).toEqual([]);
});
