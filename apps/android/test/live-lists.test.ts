import type { Json } from "@mrstreamer/contracts/json";
import { setLanguage } from "@mrstreamer/core/i18n";
import { describe, expect, it } from "vitest";
import type { ChannelRow, Sources } from "../src/connect/sources.ts";
import { draftOf, identity, playIntent, remove, resolve, step } from "../src/live/model.ts";
import { FAVOURITES, listsOwner } from "../src/live/store.ts";
import { discover, findGroups } from "../src/live/discovery.ts";

const row: ChannelRow = {
  key: "source:channel:1",
  sourceId: "source",
  title: "News",
  number: 1,
  category: "BE | News",
};

const other: ChannelRow = { ...row, key: "source:2", title: "Music" };

const everyEntry = () => true;

function catalogue(rows: readonly ChannelRow[] = [row, other]): Sources {
  return {
    kind: "ready",
    sources: [
      { id: "source", kind: "xtream", label: "Provider", channels: { kind: "ready", rows } },
    ],
  };
}

function setup() {
  let current = catalogue();
  let file: Json = null;
  let refused = false;
  const writes: unknown[] = [];

  const owner = listsOwner(
    {
      readJson: () => file,
      writeJson: (_name, value) => {
        if (refused) throw new Error("disk");
        writes.push(value);
        file = value;
      },
    },
    () => current,
  );

  owner.read();

  const list = () => {
    const state = owner.state.get();

    if (state.kind !== "ready") throw new Error("read");

    return state.lists.find((list) => list.id === FAVOURITES)!;
  };

  owner.member(FAVOURITES, identity(row), true);
  owner.member(FAVOURITES, identity(other), true);

  return {
    owner,
    writes,
    list,
    providers: () => current,
    change: (next: Sources) => {
      current = next;
    },
    refuse: (value: boolean) => {
      refused = value;
    },
  };
}

describe("Live lists public behavior", () => {
  it("refuses a stale draft, or one whose identity became ambiguous, without writing or moving anything", () => {
    const s = setup();
    const draft = step(draftOf(s.list(), s.providers()), 0, 1, everyEntry);
    s.owner.member(FAVOURITES, identity(other), false);
    const before = s.list();
    const count = s.writes.length;
    expect(() => s.owner.commit(draft)).toThrow("stale");
    expect(s.writes).toHaveLength(count);
    expect(s.list()).toEqual(before);

    const current = draftOf(s.list(), s.providers());
    s.change(catalogue([row, row, other]));
    expect(() => s.owner.commit(current)).toThrow("stale");
    expect(s.writes).toHaveLength(count);
  });
  it("keeps a failed write's draft for retry and saves removal and order together", () => {
    const s = setup();
    const draft = remove(step(draftOf(s.list(), s.providers()), 0, 1, everyEntry), 1);
    const before = s.list();
    s.refuse(true);
    expect(() => s.owner.commit(draft)).toThrow("disk");
    expect(s.list()).toEqual(before);
    expect(draft.entries).toEqual([identity(other)]);
    s.refuse(false);
    s.owner.commit(draft);
    expect(s.list().entries).toEqual([identity(other)]);
    s.owner.read();
    expect(s.list().entries).toEqual([identity(other)]);
  });
  it("moves a shown entry past a hidden one, which keeps its place, and saves that order", () => {
    const s = setup();
    const third: ChannelRow = { ...row, key: "source:3", title: "Sport" };
    s.change(catalogue([row, other, third]));
    s.owner.member(FAVOURITES, identity(third), true);
    const hidden = identity(other);
    const shown = (entry: { channelId: string }) => entry.channelId !== hidden.channelId;
    const start = draftOf(s.list(), s.providers());
    const draft = step(start, 0, 1, shown);
    expect(draft.entries).toEqual([identity(third), hidden, identity(row)]);
    expect(step(draft, 2, 1, shown)).toBe(draft);
    s.owner.commit(draft);
    expect(s.list().entries).toEqual([identity(third), hidden, identity(row)]);
  });
  it("never matches missing, ambiguous or another source's identity", () => {
    const entry = identity(row);
    expect(entry.channelId).toBe("channel:1");
    expect(resolve(entry, catalogue([row, row])).kind).toBe("ambiguous");
    expect(resolve(entry, catalogue([])).kind).toBe("missing");
    expect(resolve({ ...entry, sourceId: "someone-else" }, catalogue()).kind).toBe("removed");
    const s = setup();
    s.change(catalogue([row, row]));
    const count = s.writes.length;
    expect(() => s.owner.member(FAVOURITES, entry, false)).toThrow("identity");
    expect(s.writes).toHaveLength(count);
  });
  it("create and rename refuse taken and over-long names without writes", () => {
    const s = setup();
    s.owner.create("Café");
    const id = s.owner.create("Second");
    const count = s.writes.length;

    for (const [name, error] of [
      [" cafe ", "name-taken"],
      ["x".repeat(61), "name-length"],
    ] as const) {
      expect(() => s.owner.create(name)).toThrow(error);
      expect(() => s.owner.rename(id, name)).toThrow(error);
    }

    expect(s.writes).toHaveLength(count);
    s.owner.rename(id, "x".repeat(60));
    expect(s.writes).toHaveLength(count + 1);
  });
  it("does not replace unreadable stored lists with empty data", () => {
    const writes: unknown[] = [];

    const owner = listsOwner(
      {
        readJson: () => ({ version: 99 }),
        writeJson: (_name, value) => {
          writes.push(value);
        },
      },
      () => catalogue(),
    );

    owner.read();
    expect(owner.state.get().kind).toBe("failed");
    expect(() => owner.create("New")).toThrow("read");
    expect(writes).toEqual([]);
  });
});

it("discovery retains loaded rows and counts alongside partial failures and loading", () => {
  const base = catalogue();

  if (base.kind !== "ready") throw new Error("test");

  const view = discover({
    kind: "ready",
    sources: [
      ...base.sources,
      {
        id: "failed",
        kind: "m3u",
        label: "Offline",
        channels: { kind: "failed", error: { kind: "unexpected", detail: "offline" } },
      },
      { id: "loading", kind: "m3u", label: "Pending", channels: { kind: "loading" } },
    ],
  });

  expect(view.rows).toEqual([row, other]);
  expect(view.failed).toEqual(["Offline"]);
  expect(view.loading).toEqual(["Pending"]);
  expect(findGroups(view.categories, "NEWS")[0]?.rows).toEqual([row, other]);
  expect(view.countries[0]?.name).toBe("Belgium");
  expect(discover({ kind: "restoring" }).restoring).toBe(true);
});

it("plays only a current unambiguous channel identity, with its current title", () => {
  const entry = identity(row);
  const renamed = { ...row, title: "News now" };

  expect(playIntent(entry, catalogue([renamed]))).toEqual({
    kind: "live",
    sourceId: "source",
    channelId: "channel:1",
    title: "News now",
  });
  expect(playIntent(entry, catalogue([]))).toBeNull();
  expect(playIntent(entry, catalogue([row, row]))).toBeNull();
  expect(playIntent(entry, { kind: "restoring" })).toBeNull();
  expect(playIntent({ ...entry, sourceId: "removed" }, catalogue())).toBeNull();
});

it("reserves the visible Dutch Favourites name for create and rename", () => {
  const s = setup();
  const id = s.owner.create("Custom");
  const count = s.writes.length;
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });

  try {
    expect(() => s.owner.create(" favorieten ")).toThrow("name-taken");
    expect(() => s.owner.rename(id, "Favorieten")).toThrow("name-taken");
    expect(s.writes).toHaveLength(count);
  } finally {
    setLanguage({ locale: "en-US", formats: "en-US" });
  }
});
