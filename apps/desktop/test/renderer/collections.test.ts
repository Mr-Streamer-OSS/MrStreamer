// @vitest-environment happy-dom
// The viewer's collections column and a title's collections menu, driven as the viewer drives
// them: each sends one change and shows it once stored, a refused one says so and sends the same
// change again, and a title goes in a collection as the exact source version it was given. Then
// the same, mounted: the Collections tab's grid and picks, and the menu in a title's details.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { syncViewing, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";
import { acceptPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { bareView, queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import {
  collectionKey,
  type CollectionChange,
  type CollectionMember,
  type CollectionSummary,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { CollectionsPage } from "../../src/renderer/src/features/collections/CollectionsPage.tsx";
import { TitleCollections } from "../../src/renderer/src/features/collections/TitleCollections.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import {
  CollectionMembership,
  CollectionNav,
} from "../../src/renderer/src/features/collections/CollectionControls.tsx";

let unmount = () => {};

afterEach(() => unmount());

/**
 * Collections with their members by key, stored as the main process would store each change.
 * `refuse` makes the next sends fail without storing them.
 */
function store(names: readonly string[]) {
  const sent: CollectionChange[] = [];
  let refusals = 0;
  let lists = names.map((name, index) => ({ id: `c${index}`, name, members: new Set<string>() }));
  let render = () => {};

  const commit = async (change: CollectionChange) => {
    sent.push(change);

    if (refusals > 0) {
      refusals -= 1;
      throw new Error("refused");
    }

    if (change.kind === "create")
      lists = [...lists, { id: change.id, name: change.name, members: new Set() }];
    else if (change.kind === "rename")
      lists = lists.map((list) => (list.id === change.id ? { ...list, name: change.name } : list));
    else if (change.kind === "delete") lists = lists.filter((list) => list.id !== change.id);
    else if (change.kind === "reorder")
      lists = change.ids.flatMap((id) => lists.filter((list) => list.id === id));
    else if (change.kind === "member") {
      const key = collectionKey(change.title);
      const list = lists.find((each) => each.id === change.id);

      if (change.present) list?.members.add(key);
      else list?.members.delete(key);
    }

    render();
  };

  const summaries = (): CollectionSummary[] =>
    lists.map(({ id, name, members }) => ({ id, name, total: members.size }));

  return {
    sent,
    commit,
    summaries,
    lists: () => lists,
    refuse: (count = 1) => {
      refusals = count;
    },
    /** Re-renders its view after every stored change, as a refetch would. */
    bind: (rerender: () => void) => {
      render = rerender;
    },
  };
}

async function mountNav(saved: ReturnType<typeof store>) {
  const view = bareView();
  unmount = view.unmount;

  function Harness() {
    const [, setVersion] = useState(0);
    const [open, setOpen] = useState<string | null>(null);
    saved.bind(() => setVersion((version) => version + 1));

    return createElement(CollectionNav, {
      collections: saved.summaries(),
      selected: open,
      onOpen: setOpen,
      commit: saved.commit,
    });
  }

  await view.render(createElement(Harness));
}

/** The collections' names in the column, top first. Each row opens by its unlabelled button. */
const rows = () =>
  [...document.querySelectorAll("nav[aria-label=Collections] li button:not([aria-label])")].map(
    (row) => row.querySelector("span")?.textContent,
  );

const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (each) => each.textContent?.trim() === text,
  );

  if (!found) throw new Error(`No ${text}`);

  return found;
};

const field = () => {
  const found = document.querySelector<HTMLInputElement>("input[aria-label='Collection name']");

  if (!found) throw new Error("No field");

  return found;
};

/** Types `text` in the focused field and presses `key` there. */
async function type(text: string, key: string) {
  const input = field();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function choose(collection: string, option: string) {
  await act(async () =>
    document.querySelector<HTMLElement>(`[aria-label='Options for ${collection}']`)!.click(),
  );
  const item = await vi.waitFor(() => button(option));
  await act(async () => item.click());
}

it("creates, renames, moves and deletes collections, each once stored", async () => {
  const saved = store(["Weekend films", "Family night"]);
  await mountNav(saved);

  await act(async () => button("New collection").click());
  expect(document.activeElement).toBe(field());
  await type("Rainy Sundays", "Enter");
  await vi.waitFor(() =>
    expect(rows()).toEqual(["Weekend films", "Family night", "Rainy Sundays"]),
  );
  expect(document.activeElement).toBe(button("New collection"));

  await choose("Family night", "Rename");
  await type("Friday night", "Escape");
  expect(saved.sent.map(({ kind }) => kind)).toEqual(["create"]);
  await choose("Family night", "Rename");
  await type("Friday night", "Enter");
  await vi.waitFor(() =>
    expect(rows()).toEqual(["Weekend films", "Friday night", "Rainy Sundays"]),
  );

  await choose("Weekend films", "Move down");
  await vi.waitFor(() =>
    expect(rows()).toEqual(["Friday night", "Weekend films", "Rainy Sundays"]),
  );
  expect(saved.sent.at(-1)).toEqual({ kind: "reorder", ids: ["c1", "c0", saved.lists()[2]!.id] });

  await choose("Rainy Sundays", "Delete collection");
  expect(document.activeElement).toBe(button("Cancel"));
  await act(async () => button("Cancel").click());
  expect(rows()).toHaveLength(3);
  await choose("Rainy Sundays", "Delete collection");
  await act(async () => button("Delete collection").click());
  await vi.waitFor(() => expect(rows()).toEqual(["Friday night", "Weekend films"]));
});

it("keeps a refused new collection's field and sends the same collection again", async () => {
  const saved = store([]);
  await mountNav(saved);
  saved.refuse();

  await act(async () => button("New collection").click());
  await type("Rainy Sundays", "Enter");
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't save."),
  );
  expect(field().value).toBe("Rainy Sundays");
  expect(rows()).toEqual([]);

  await type("Rainy Sundays", "Enter");
  await vi.waitFor(() => expect(rows()).toEqual(["Rainy Sundays"]));
  const [first, second] = saved.sent;
  expect(first?.kind === "create" && second?.kind === "create" && first.id === second.id).toBe(
    true,
  );
  expect(saved.lists()).toHaveLength(1);
});

it("explains an unavailable membership without offering an identical retry", async () => {
  const view = bareView();
  unmount = view.unmount;
  await view.render(
    createElement(CollectionMembership, {
      title: { sourceId: "sub-a", kind: "movie", titleId: "41", name: "Kite Season", year: 2022 },
      collections: [{ id: "one", name: "Weekend films", total: 0 }],
      memberOf: new Set<string>(),
      commit: async () => {
        throw new AppFailure({ kind: "title-not-found", titleId: "41" });
      },
    }),
  );
  await act(async () => button("Add to collection").click());
  await vi.waitFor(() => expect(document.querySelector("[role=menuitemcheckbox]")).toBeTruthy());
  await act(async () => document.querySelector<HTMLElement>("[role=menuitemcheckbox]")!.click());
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "This title isn't available here.",
    ),
  );
  expect(
    [...document.querySelectorAll("button")].some((item) => item.textContent === "Retry"),
  ).toBe(false);
  expect(button("Close")).toBeTruthy();
});

it("ticks a title's collections by its exact source version and adds it to a new one", async () => {
  const saved = store(["Weekend films", "Family night"]);
  const view = bareView();
  unmount = view.unmount;

  const version: CollectionTitle = {
    sourceId: "sub-a",
    kind: "movie",
    titleId: "41",
    name: "Kite Season",
    year: 2022,
  };

  // Another source's film of the same name, kept in Family night.
  await saved.commit({
    kind: "member",
    id: "c1",
    title: { ...version, sourceId: "sub-b" },
    present: true,
  });

  function Harness() {
    const [, setVersion] = useState(0);
    saved.bind(() => setVersion((each) => each + 1));

    const key = collectionKey(version);

    const memberOf = new Set(
      saved
        .lists()
        .filter((list) => list.members.has(key))
        .map((list) => list.id),
    );

    return createElement(CollectionMembership, {
      title: version,
      collections: saved.summaries(),
      memberOf,
      commit: saved.commit,
    });
  }

  await view.render(createElement(Harness));
  expect(button("Add to collection")).toBeTruthy();

  const open = async () => {
    await act(async () =>
      document.querySelector<HTMLElement>("[aria-label='Collections for Kite Season']")!.click(),
    );

    return vi.waitFor(() => {
      const items = [...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];

      if (items.length === 0) throw new Error("No menu");

      return items;
    });
  };

  /** The menu's ticks as they read now; ticking one leaves the menu open for the next. */
  const ticks = () => [...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];

  const [weekend, family] = await open();
  expect(weekend?.getAttribute("aria-checked")).toBe("false");
  expect(family?.getAttribute("aria-checked")).toBe("false");
  await act(async () => weekend!.click());
  await vi.waitFor(() => expect(button("In 1 collection")).toBeTruthy());
  expect(saved.sent.at(-1)).toEqual({ kind: "member", id: "c0", title: version, present: true });

  expect(ticks()[0]?.getAttribute("aria-checked")).toBe("true");
  saved.refuse();
  await act(async () => ticks()[1]!.click());
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save."),
  );
  await act(async () => button("Retry").click());
  await vi.waitFor(() => expect(button("In 2 collections")).toBeTruthy());

  await act(async () => button("New collection").click());
  expect(document.activeElement).toBe(field());
  await type("Kites", "Enter");
  await vi.waitFor(() => expect(button("In 3 collections")).toBeTruthy());
  expect(document.activeElement).toBe(button("In 3 collections"));
  const created = saved.lists().at(-1);
  expect(created?.name).toBe("Kites");
  expect(saved.sent.at(-1)).toEqual({
    kind: "member",
    id: created?.id,
    title: version,
    present: true,
  });
});

// The mounted views, against the window's IPC: Movies' and Series' Collections tab and the
// collections menu in a title's details, each reading and changing what the main process keeps.

/** A film or series as the lists have it, in one version of the tests' subscription. */
const listedTitle = (kind: Title["kind"], id: string, name: string, year: number): Title => ({
  kind,
  key: `${kind}:${id}`,
  subscriptionId: SUBSCRIPTION,
  id,
  name,
  title: name,
  originalTitle: null,
  originalLanguage: "en",
  tags: [],
  year,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id, tags: [] }],
});

/** A member as a page answers it: available with its exact version, else the label kept. */
function member(title: Title, available = true): CollectionMember {
  const kept = {
    sourceId: title.subscriptionId,
    kind: title.kind,
    titleId: title.id,
    name: title.title,
    year: title.year,
    adult: false,
    available,
  };

  return available ? { ...kept, title } : kept;
}

const kite = listedTitle("movie", "41", "Kite Season", 2022);
const canyon = listedTitle("series", "s7", "Canyon Hours", 2024);
const gone = member(listedTitle("movie", "19", "Blue Hour", 2019), false);

/**
 * What the main process keeps: collections in order with their members, changed as sent. An
 * addition becomes the version `catalogue` lists, and one it doesn't list is refused.
 */
function mainCollections(
  initial: readonly { name: string; members: CollectionMember[] }[],
  catalogue: readonly Title[] = [kite, canyon],
) {
  let kept = initial.map((each, index) => ({ id: `c${index}`, ...each }));
  const find = (id: string) => kept.find((each) => each.id === id);

  ipc.answer("collections.list", () =>
    kept.map(({ id, name, members }) => ({ id, name, total: members.length })),
  );
  ipc.answer("collections.page", ({ id, offset, limit }) => {
    const members = find(id)?.members ?? [];

    return { total: members.length, members: members.slice(offset, offset + limit) };
  });
  ipc.answer("collections.memberships", (title) =>
    kept
      .filter(({ members }) => members.some((each) => collectionKey(each) === collectionKey(title)))
      .map(({ id }) => id),
  );
  ipc.answer("collections.change", (change) => {
    if (change.kind === "member") {
      const collection = find(change.id);
      const key = collectionKey(change.title);
      const members = collection?.members.filter((each) => collectionKey(each) !== key) ?? [];
      const listed = catalogue.find((each) => collectionKey(member(each)) === key);

      if (change.present && !listed) throw new Error("Not listed");

      if (change.present && listed) members.push(member(listed));

      if (collection) collection.members = members;
    } else if (change.kind === "create")
      kept = [...kept, { id: change.id, name: change.name, members: [] }];

    return null;
  });

  return { find };
}

// happy-dom lays nothing out, and the grid draws only the rows that fit: it gets a height.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

async function mountTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);
  await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
  const stop = syncOnDemand(client);
  unmount = () => {
    stop();
    view.unmount();
  };
}

/** A grid tile's poster button, by what it is named. */
const poster = (label: string) =>
  vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-index] button[aria-label='${label}']`);

    if (!found) throw new Error(`No poster ${label}`);

    return found;
  });

/** A collection's row in the column, by its name; its count reads beside it. */
const row = (name: string) =>
  vi.waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLElement>(
        "nav[aria-label=Collections] li button:not([aria-label])",
      ),
    ].find((each) => each.querySelector("span")?.textContent === name);

    if (!found) throw new Error(`No row ${name}`);

    return found;
  });

const pick = (name: string) =>
  act(async () =>
    document.querySelector<HTMLElement>(`[role=checkbox][aria-label='Select ${name}']`)!.click(),
  );

describe("the Collections tab", () => {
  beforeEach(() => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);
    useUi.setState({ details: null });
  });

  it("opens the version each member was added as, and removes picked ones, unavailable too", async () => {
    const main = mainCollections([
      { name: "Weekend films", members: [] },
      { name: "Family night", members: [member(kite), member(canyon), gone] },
    ]);

    await mountTab();
    const family = await row("Family night");
    await act(async () => family.click());
    await vi.waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Family night"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("3 titles"));

    await act(async () => (await poster("Kite Season, Movie, 2022")).click());
    expect(useUi.getState().details).toEqual({
      kind: "movie",
      subscriptionId: SUBSCRIPTION,
      id: "41",
      asked: true,
    });
    useUi.setState({ details: null });

    // An unavailable member opens nothing: pressing it picks it.
    await act(async () => (await poster("Blue Hour, Unavailable, Movie, 2019")).click());
    expect(useUi.getState().details).toBeNull();
    await pick("Canyon Hours");
    await vi.waitFor(() => expect(button("Remove from Family night")).toBeTruthy());
    expect(document.querySelector("[role=group]")?.getAttribute("aria-label")).toBe("2 selected");

    await act(async () => button("Remove from Family night").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("1 title"));
    expect(ipc.argsOf("collections.change")).toEqual([
      {
        kind: "member",
        id: "c1",
        title: {
          sourceId: SUBSCRIPTION,
          kind: "movie",
          titleId: "19",
          name: "Blue Hour",
          year: 2019,
        },
        present: false,
      },
      {
        kind: "member",
        id: "c1",
        title: {
          sourceId: SUBSCRIPTION,
          kind: "series",
          titleId: "s7",
          name: "Canyon Hours",
          year: 2024,
        },
        present: false,
      },
    ]);
    expect(main.find("c1")?.members.map((each) => each.titleId)).toEqual(["41"]);
    expect(document.querySelector("[aria-label='Remove from Family night']")).toBeNull();
    expect(() => button("Remove from Family night")).toThrow();
  });

  it("adds the picked available titles to another collection, and Retry sends them again", async () => {
    const main = mainCollections([
      { name: "Family night", members: [member(kite), gone] },
      { name: "Weekend films", members: [] },
    ]);

    await mountTab();
    const family = await row("Family night");
    await act(async () => family.click());
    await poster("Kite Season, Movie, 2022");
    await pick("Kite Season");
    await pick("Blue Hour");
    const refused = ipc.hold("collections.change");
    await act(async () => button("Add to collection").click());
    const item = await vi.waitFor(() => button("Weekend films"));
    await act(async () => item.click());
    await act(async () => refused.reject({ kind: "unexpected", detail: "disk" }));
    await vi.waitFor(() =>
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save."),
    );

    await act(async () => button("Retry").click());
    await vi.waitFor(() =>
      expect(main.find("c1")?.members.map((each) => each.titleId)).toEqual(["41"]),
    );
    // Blue Hour is no subscription's now, so it went nowhere; the same change went twice.
    expect(
      ipc.argsOf("collections.change").map((each) => each.kind === "member" && each.id),
    ).toEqual(["c1", "c1"]);
    await vi.waitFor(async () => expect((await row("Weekend films")).textContent).toContain("1"));
  });

  it("says why a collection could not be read and shows nothing as empty", async () => {
    mainCollections([{ name: "Family night", members: [member(kite)] }]);
    ipc.refuse("collections.page", { kind: "unexpected", detail: "database locked" });
    await mountTab();
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).toBeTruthy());
    expect(document.body.textContent).not.toContain("Add movies and series to it");
    expect(document.querySelector("[data-index]")).toBeNull();
    expect(document.body.textContent).not.toContain("0 titles");

    mainCollections([{ name: "Family night", members: [member(kite)] }]);
    ipc.always("collections.page", { total: 1, members: [member(kite)] });
    await act(async () => button("Try again").click());
    await poster("Kite Season, Movie, 2022");
  });

  it("drops what it read once the lists mark a member for adults, while it reads again", async () => {
    mainCollections([{ name: "Family night", members: [member(kite)] }]);
    await mountTab();
    const family = await row("Family night");
    await act(async () => family.click());
    await poster("Kite Season, Movie, 2022");
    const reread = ipc.hold("collections.page");

    await act(async () =>
      ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
    );
    await vi.waitFor(() => expect(document.querySelector("[data-index]")).toBeNull());
    await act(async () => reread.resolve({ total: 0, members: [] }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Add movies and series to it"),
    );
  });

  it("reads again for the viewer's own changes only, and sends nothing as the next viewer", async () => {
    const viewer = { id: "sam", revision: 2 };
    selectProfileOwner(viewer);
    mainCollections([{ name: "Family night", members: [member(kite)] }]);
    await mountTab();
    await poster("Kite Season, Movie, 2022");
    const reads = () => ipc.argsOf("collections.list").length;
    const before = reads();

    await act(async () => ipc.emit("collections.changed", { owner: { id: "mila", revision: 2 } }));
    await act(async () => ipc.emit("collections.changed", { owner: { id: "sam", revision: 1 } }));
    expect(reads()).toBe(before);
    await act(async () => ipc.emit("collections.changed", { owner: { ...viewer } }));
    await vi.waitFor(() => expect(reads()).toBe(before + 1));

    // A pick made for Sam is not removed as Mila's once she is the viewer.
    await pick("Kite Season");
    selectProfileOwner({ id: "mila", revision: 3 });
    await act(async () => button("Remove from Family night").click());
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).toBeTruthy());
    expect(ipc.argsOf("collections.change")).toEqual([]);
  });
});

describe("a title's collections menu in its details", () => {
  /** A film in two versions of one subscription: HD, shown first, and 4K. */
  const film: Title = {
    ...listedTitle("movie", "hd", "Night Harbour", 2024),
    versions: [
      { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["HD"] },
      { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["4K"] },
    ],
  };

  async function details() {
    ipc.always("ondemand.titles", [film]);
    ipc.always("viewing.progress", []);
    ipc.always("watchlist.saved", null);
    ipc.always("ondemand.details", {
      kind: "movie",
      title: film,
      originalTitle: null,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: null,
      backdropUrl: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["subscriptions"], [SAVED]);
    const view = queryView(client);
    // Opened on the 4K version, as the 4K tab opens it.
    await view.render(
      createElement(DetailsView, {
        target: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k", asked: true },
      }),
    );
    unmount = view.unmount;

    return client;
  }

  beforeEach(() => ipc.reset());

  it("keeps the new collection name focused when its menu unmounts", async () => {
    mainCollections([], [{ ...film, id: "4k" }]);
    await details();

    const trigger = await vi.waitFor(() => {
      const trigger = button("Add to collection");
      expect(trigger.hasAttribute("disabled")).toBe(false);

      return trigger;
    });

    // The details initially focus Play. Pointer opening the menu leaves that return target.
    await act(async () => button("Play").focus());
    await act(async () => trigger.click());
    const item = await vi.waitFor(() => button("New collection"));
    await act(async () => item.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Friday films", "Escape");
    expect(document.querySelector("input[aria-label='Collection name']")).toBeNull();
    expect(document.activeElement).toBe(button("Add to collection"));
    expect(ipc.argsOf("collections.change")).toEqual([]);
  });

  it("retains a refused operation after a fresh title read fails then recovers", async () => {
    mainCollections([{ name: "Weekend films", members: [] }], [{ ...film, id: "4k" }]);
    const client = await details();
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).not.toBeNull(),
    );
    await act(async () => button("Add to collection").click());

    const tick = await vi.waitFor(() => {
      const item = document.querySelector<HTMLElement>("[role=menuitemcheckbox]");
      expect(item).not.toBeNull();

      return item!;
    });

    const held = ipc.hold("collections.change");
    await act(async () => tick.click());
    const reread = ipc.hold("ondemand.titles");
    await act(async () => {
      void client.resetQueries({ queryKey: ["ondemand", "titles"] });
    });
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeNull(),
    );
    expect(document.querySelector("[role=menuitemcheckbox]")).toBeNull();
    await act(async () => reread.reject({ kind: "unexpected", detail: "worker unavailable" }));
    await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
    expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeNull();
    await act(async () => held.reject({ kind: "unexpected", detail: "currency changed" }));
    ipc.always("ondemand.titles", [film]);
    await act(async () => button("Try again").click());
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).not.toBeNull(),
    );
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save.");
    expect(button("Retry")).toBeTruthy();
    const next = ipc.hold("collections.change");
    await act(async () => button("Retry").click());
    ipc.always("ondemand.titles", []);
    await act(async () => {
      await client.resetQueries({ queryKey: ["ondemand", "titles"] });
    });
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeNull(),
    );
    await act(async () => next.reject({ kind: "unexpected", detail: "obsolete write" }));
    ipc.always("ondemand.titles", [film]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["ondemand", "titles"] });
    });
    await vi.waitFor(() => expect(button("Add to collection")).toBeTruthy());
    expect(() => button("Retry")).toThrow();
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it.each(["create", "member"] as const)(
    "suspends a retained title after an actual refetch error and retries its %s with fresh facts",
    async (operation) => {
      mainCollections([{ name: "Private films", members: [] }], [{ ...film, id: "4k" }]);
      const lists = ipc.hold("collections.list");
      const memberships = ipc.hold("collections.memberships");
      const client = await details();
      const stop = syncOnDemand(client);
      const close = unmount;
      unmount = () => {
        stop();
        close();
      };

      // Text also matches the loading placeholder; both reads must admit the real trigger.
      await vi.waitFor(() => expect(button("Add to collection")).toBeTruthy());
      expect(button("Add to collection").hasAttribute("disabled")).toBe(true);
      await act(async () => button("Add to collection").click());
      expect(() => button("New collection")).toThrow();
      await act(async () => lists.resolve([{ id: "c0", name: "Private films", total: 0 }]));
      expect(button("Add to collection").hasAttribute("disabled")).toBe(true);
      await act(async () => memberships.resolve([]));
      await vi.waitFor(() =>
        expect(
          document.querySelector("[aria-label='Collections for Night Harbour']"),
        ).not.toBeNull(),
      );
      expect(button("Add to collection").hasAttribute("disabled")).toBe(false);
      await act(async () => button("Add to collection").click());
      const held = ipc.hold("collections.change");

      if (operation === "create") {
        const item = await vi.waitFor(() => button("New collection"));
        await act(async () => item.click());
        await type("Private weekend", "Enter");
      } else {
        const item = await vi.waitFor(() => {
          const found = document.querySelector<HTMLElement>("[role=menuitemcheckbox]");
          expect(found).not.toBeNull();

          return found!;
        });

        await act(async () => item.click());
        await act(async () => held.reject({ kind: "unexpected", detail: "disk refused" }));
        await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
        await vi.waitFor(() =>
          expect(document.querySelector("[role=menuitemcheckbox]")?.textContent).toContain(
            "Private films",
          ),
        );
      }

      const original = ipc.argsOf("collections.change")[0];

      if (!original || (original.kind !== "create" && original.kind !== "member"))
        throw new Error("No original operation");
      // A pending background refresh still has successful cached admission.
      const refreshing = ipc.hold("ondemand.titles");
      const reads = ipc.argsOf("ondemand.titles").length;
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await vi.waitFor(() => expect(ipc.argsOf("ondemand.titles").length).toBeGreaterThan(reads));

      if (operation === "create") expect(field().value).toBe("Private weekend");
      else
        expect(document.querySelector("[role=menuitemcheckbox]")?.textContent).toContain(
          "Private films",
        );
      await act(async () => refreshing.resolve([film]));

      const refused = ipc.hold("ondemand.titles");
      const beforeFailure = ipc.argsOf("ondemand.titles").length;
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await vi.waitFor(() =>
        expect(ipc.argsOf("ondemand.titles").length).toBeGreaterThan(beforeFailure),
      );
      await act(async () => refused.reject({ kind: "unexpected", detail: "worker unavailable" }));
      await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
      // Details still shows cached title metadata, but private collection DOM must be gone.
      expect(document.body.textContent).toContain("Night Harbour");
      await vi.waitFor(() =>
        expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeNull(),
      );
      expect(document.querySelector("input[aria-label='Collection name']")).toBeNull();
      expect(document.querySelector("[role=menuitemcheckbox]")).toBeNull();
      expect(document.body.innerHTML).not.toContain("Private weekend");
      expect(document.body.innerHTML).not.toContain("Private films");
      expect(() => button("Retry")).toThrow();

      if (original.kind === "create") {
        // Deliver the successful create while title admission is refused, with usable rereads.
        ipc.always("collections.list", [
          { id: "c0", name: "Private films", total: 0 },
          { id: original.id, name: "Private weekend", total: 0 },
        ]);
        await act(async () => held.resolve(null));
      }

      expect(ipc.argsOf("collections.change")).toHaveLength(1);
      expect(document.body.innerHTML).not.toContain("Private weekend");
      const fresh = { ...film, title: "Harbour restored", year: 2025 };
      ipc.always("ondemand.titles", [fresh]);
      await act(async () => button("Try again").click());
      await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save.");

      // The stored create disables the menu until its add is sent, so Retry takes the focus.
      if (operation === "create") expect(document.activeElement).toBe(button("Retry"));
      expect(ipc.argsOf("collections.change")).toHaveLength(1);
      const retry = ipc.hold("collections.change");
      await act(async () => button("Retry").click());
      await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(2));
      expect(ipc.argsOf("collections.change")[1]).toEqual({
        kind: "member",
        id: original.id,
        title: {
          sourceId: SUBSCRIPTION,
          kind: "movie",
          titleId: "4k",
          name: "Harbour restored",
          year: 2025,
        },
        present: true,
      });
      await act(async () => retry.resolve(null));
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")).toBeNull());
    },
  );

  it("keeps an unsent new collection name through a failed title read", async () => {
    mainCollections([{ name: "Private films", members: [] }], [{ ...film, id: "4k" }]);
    const client = await details();
    const stop = syncOnDemand(client);
    const close = unmount;
    unmount = () => {
      stop();
      close();
    };

    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).not.toBeNull(),
    );
    await act(async () => button("Add to collection").click());
    const item = await vi.waitFor(() => button("New collection"));
    await act(async () => item.click());
    await type("Private weekend", "Shift");
    const refused = ipc.hold("ondemand.titles");
    const reads = ipc.argsOf("ondemand.titles").length;
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await vi.waitFor(() => expect(ipc.argsOf("ondemand.titles").length).toBeGreaterThan(reads));
    await act(async () => refused.reject({ kind: "unexpected", detail: "worker unavailable" }));
    await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
    expect(document.querySelector("input[aria-label='Collection name']")).toBeNull();
    expect(document.body.innerHTML).not.toContain("Private weekend");

    ipc.always("ondemand.titles", [film]);
    await act(async () => button("Try again").click());
    await vi.waitFor(() => expect(field().value).toBe("Private weekend"));
    await type("Private weekend", "Enter");
    await vi.waitFor(() =>
      expect(ipc.argsOf("collections.change")[0]).toMatchObject({
        kind: "create",
        name: "Private weekend",
      }),
    );
  });

  it("ticks and adds the version the details play, not the title's first", async () => {
    mainCollections(
      [
        { name: "Weekend films", members: [] },
        // The HD version is in Family night; the 4K version is another member.
        { name: "Family night", members: [member(film)] },
      ],
      [{ ...film, id: "4k" }],
    );
    await details();

    const trigger = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[aria-label='Collections for Night Harbour']",
      );

      if (!found) throw new Error("No menu");

      return found;
    });

    expect(ipc.argsOf("collections.memberships")).toEqual([
      { sourceId: SUBSCRIPTION, kind: "movie", titleId: "4k" },
    ]);
    expect(trigger.textContent).toBe("Add to collection");

    await act(async () => trigger.click());

    const [weekend, family] = await vi.waitFor(() => {
      const items = [...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];

      if (items.length < 2) throw new Error("No menu");

      return items;
    });

    expect(family?.getAttribute("aria-checked")).toBe("false");
    await act(async () => weekend!.click());
    await vi.waitFor(() => expect(button("In 1 collection")).toBeTruthy());
    expect(ipc.argsOf("collections.change")).toEqual([
      {
        kind: "member",
        id: "c0",
        title: {
          sourceId: SUBSCRIPTION,
          kind: "movie",
          titleId: "4k",
          name: "Night Harbour",
          year: 2024,
        },
        present: true,
      },
    ]);
  });

  it("says why its collections could not be read, and offers none meanwhile", async () => {
    mainCollections([{ name: "Weekend films", members: [] }]);
    ipc.refuse("collections.memberships", { kind: "unexpected", detail: "database locked" });
    await details();
    await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
    expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeNull();

    ipc.answer("collections.memberships", () => []);
    ipc.always("collections.memberships", []);
    await act(async () => button("Try again").click());
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Night Harbour']")).toBeTruthy(),
    );
  });
});

it("clears selected members and failed retry payloads on an adult privacy reset", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  mainCollections([{ name: "Privacy films", members: [member(kite)] }]);
  await mountTab();
  await poster("Kite Season, Movie, 2022");
  await pick("Kite Season");
  const failed = ipc.hold("collections.change");
  await act(async () => button("Remove from Privacy films").click());
  await act(async () => failed.reject({ kind: "unexpected", detail: "disk" }));
  await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
  const reread = ipc.hold("collections.page");
  await act(async () =>
    ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
  );
  await vi.waitFor(() => expect(document.querySelector("[data-index]")).toBeNull());
  expect(document.querySelector("[aria-label='1 selected']")).toBeNull();
  expect(() => button("Retry")).toThrow();
  await act(async () => reread.resolve({ total: 0, members: [] }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("0 titles"));
  expect(document.querySelector("[aria-label='1 selected']")).toBeNull();
  expect(() => button("Remove from Privacy films")).toThrow();
});

it("discards cached adult collection content before a delayed preference reread", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  selectProfileOwner(null);
  mainCollections([{ name: "Adult collection", members: [member({ ...kite, adult: true })] }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  acceptPreferences(client, {
    revision: 1,
    preferences: { ...defaultPreferences, adultTitles: true },
  });
  const view = queryView(client);
  unmount = view.unmount;
  await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
  await poster("Kite Season, Movie, 2022");
  const reread = ipc.hold("collections.page");
  await act(async () => {
    acceptPreferences(client, {
      revision: 2,
      preferences: { ...defaultPreferences, adultTitles: false },
    });
  });
  expect(client.getQueryData(["collections", "page", "c0", 0, 48])).toBeUndefined();
  await vi.waitFor(() => expect(document.querySelector("[data-index]")).toBeNull());
  expect(document.body.textContent).not.toContain("1 title");
  expect(document.body.textContent).not.toContain("Kite Season");
  await act(async () => reread.resolve({ total: 0, members: [] }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("0 titles"));
});

it.each([false, true])(
  "drops restricted facts off-surface with an old response in flight: %s",
  async (inFlight) => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);
    selectProfileOwner(null);
    const { syncOnDemand, syncWatchlist } = await import("../../src/renderer/src/lib/queries.ts");
    const privateTitle = { ...kite, posterUrl: "https://img.invalid/private.jpg" };
    const kept = mainCollections([{ name: "Privacy films", members: [member(privateTitle)] }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stops = [syncOnDemand(client), syncWatchlist(client)];
    const view = queryView(client);
    unmount = () => {
      stops.forEach((stop) => stop());
      view.unmount();
    };

    await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
    await poster("Kite Season, Movie, 2022");
    expect(document.body.innerHTML).toContain("private.jpg");
    const old = inFlight ? ipc.hold("collections.page") : null;

    if (old) {
      const reads = ipc.argsOf("collections.page").length;
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await vi.waitFor(() => expect(ipc.argsOf("collections.page").length).toBeGreaterThan(reads));
    }

    await view.render(null);
    kept.find("c0")!.members = [];
    await act(async () =>
      ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
    );
    const reread = ipc.hold("collections.page");
    await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));

    try {
      await act(async () => old?.resolve({ total: 1, members: [member(privateTitle)] }));
      expect(document.querySelector("img")).toBeNull();
      expect(document.body.textContent).not.toContain("Kite Season");
      expect(document.body.textContent).not.toContain("1 title");
    } finally {
      await act(async () => reread.resolve({ total: 0, members: [] }));
    }
  },
);

it.each([false, true])(
  "keeps a failed removal visible through a metadata update: %s",
  async (changed) => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);
    useUi.setState({ details: null });
    const main = mainCollections([{ name: "Films", members: [member(kite)] }]);
    await mountTab();
    await poster("Kite Season, Movie, 2022");
    await pick("Kite Season");
    const held = ipc.hold("collections.change");
    await act(async () => button("Remove from Films").click());
    // TMDB metadata lands meanwhile: the same member now has artwork.
    main.find("c0")!.members[0] = member(
      changed ? { ...kite, posterUrl: "https://img.invalid/kite.jpg" } : kite,
    );
    const reads = ipc.argsOf("collections.page").length;
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await vi.waitFor(() => expect(ipc.argsOf("collections.page").length).toBeGreaterThan(reads));

    if (changed) await vi.waitFor(() => expect(document.body.innerHTML).toContain("kite.jpg"));
    expect(button("Remove from Films").hasAttribute("disabled")).toBe(true);
    await act(async () => held.reject({ kind: "unexpected", detail: "disk" }));
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).not.toBeNull());
  },
);

it("keeps the selected member menu and focus through metadata updates", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);

  const main = mainCollections([
    { name: "Films", members: [member(kite)] },
    { name: "Weekend", members: [] },
  ]);

  await mountTab();
  await poster("Kite Season, Movie, 2022");
  await pick("Kite Season");
  await act(async () => button("Add to collection").click());
  await vi.waitFor(() => expect(document.querySelector("[role=menuitem]")).not.toBeNull());
  const item = document.querySelector<HTMLElement>("[role=menuitem]")!;
  await act(async () => item.focus());
  main.find("c0")!.members[0] = member({ ...kite, posterUrl: "https://img.invalid/menu.jpg" });
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  await vi.waitFor(() => expect(document.body.innerHTML).toContain("menu.jpg"));
  expect(document.querySelector("[role=menuitem]")).toBe(item);
  expect(document.activeElement).toBe(item);
});

it("drops obsolete failed commands when one of the selected identities is deselected", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  mainCollections([{ name: "Films", members: [member(kite), member(canyon)] }]);
  await mountTab();
  await poster("Kite Season, Movie, 2022");
  await pick("Kite Season");
  await pick("Canyon Hours");
  const held = ipc.hold("collections.change");
  await act(async () => button("Remove from Films").click());
  await act(async () => held.reject({ kind: "unexpected", detail: "disk" }));
  await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
  await pick("Kite Season");
  expect(document.querySelector("[aria-label='1 selected']")).not.toBeNull();
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(() => button("Retry")).toThrow();
  expect(button("Remove from Films").hasAttribute("disabled")).toBe(false);
});

it.each([false, true])(
  "retains an allowed removal refusal across privacy loading: %s",
  async (marked) => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);
    selectProfileOwner({ id: "mila", revision: 2 });
    mainCollections([
      { name: "Films", members: [member({ ...kite, posterUrl: "https://img.invalid/old.jpg" })] },
    ]);
    await mountTab();
    await poster("Kite Season, Movie, 2022");
    await pick("Kite Season");
    const held = ipc.hold("collections.change");
    await act(async () => button("Remove from Films").click());
    const list = ipc.hold("collections.list");
    const page = ipc.hold("collections.page");
    await act(async () =>
      ipc.emit(
        "ondemand.updated",
        marked
          ? { lists: [], metadata: null, markedForAdults: true }
          : { lists: [], metadata: null },
      ),
    );

    if (marked) {
      await vi.waitFor(() => expect(document.querySelector("[data-index]")).toBeNull());
      expect(document.body.innerHTML).not.toContain("old.jpg");
      expect(document.body.innerHTML).not.toContain("Kite Season");
      expect(() => button("Retry")).toThrow();
      expect(document.querySelector("[aria-label='1 selected']")).toBeNull();
    }

    await act(async () => list.resolve([{ id: "c0", name: "Films", total: 1 }]));
    await act(async () => page.resolve({ total: 1, members: [member(kite)] }));
    await poster("Kite Season, Movie, 2022");
    await act(async () => held.reject({ kind: "unexpected", detail: "subscription changed" }));
    await vi.waitFor(() =>
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save."),
    );
    const original = ipc.argsOf("collections.change")[0];
    await act(async () => button("Retry").click());
    await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(2));
    expect(ipc.argsOf("collections.change")[1]).toEqual(original);
    expect(document.body.innerHTML).not.toContain("old.jpg");
  },
);

it("retains the details membership refusal through unrelated privacy loading", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  mainCollections([{ name: "Films", members: [] }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);
  const stop = syncOnDemand(client);
  unmount = () => {
    stop();
    view.unmount();
  };

  await view.render(
    createElement(TitleCollections, {
      title: kite,
      version: { subscriptionId: SUBSCRIPTION, id: kite.id },
    }),
  );
  await vi.waitFor(() =>
    expect(document.querySelector("[aria-label='Collections for Kite Season']")).not.toBeNull(),
  );
  await act(async () => button("Add to collection").click());

  const tick = await vi.waitFor(() => {
    const item = document.querySelector<HTMLElement>("[role=menuitemcheckbox]");
    expect(item).not.toBeNull();

    return item!;
  });

  const held = ipc.hold("collections.change");
  await act(async () => tick.click());
  const list = ipc.hold("collections.list");
  const memberships = ipc.hold("collections.memberships");
  await act(async () =>
    ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
  );
  await view.render(
    createElement(TitleCollections, {
      title: null,
      pending: true,
      version: { subscriptionId: SUBSCRIPTION, id: kite.id },
    }),
  );
  await vi.waitFor(() => expect(document.body.innerHTML).not.toContain("Films"));
  expect(document.querySelector("[role=menuitemcheckbox]")).toBeNull();
  await act(async () => list.resolve([{ id: "c0", name: "Films", total: 0 }]));
  await act(async () => memberships.resolve([]));
  await view.render(
    createElement(TitleCollections, {
      title: kite,
      version: { subscriptionId: SUBSCRIPTION, id: kite.id },
    }),
  );
  await act(async () => held.reject({ kind: "unexpected", detail: "currency changed" }));
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save."),
  );
  const original = ipc.argsOf("collections.change")[0];
  await act(async () => button("Retry").click());
  await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(2));
  expect(ipc.argsOf("collections.change")[1]).toEqual(original);
});

it("keeps a refused rename and its exact submitted name through privacy loading", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  mainCollections([{ name: "Films", members: [member(kite)] }]);
  await mountTab();
  await row("Films");
  await choose("Films", "Rename");
  const held = ipc.hold("collections.change");
  await type("Weekend", "Enter");
  const list = ipc.hold("collections.list");
  await act(async () =>
    ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
  );
  await vi.waitFor(() => expect(document.querySelector("input")).toBeNull());
  expect(document.body.innerHTML).not.toContain("Films");
  await act(async () => list.resolve([{ id: "c0", name: "Films", total: 1 }]));
  await act(async () => held.reject({ kind: "unexpected", detail: "currency changed" }));
  await vi.waitFor(() =>
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save."),
  );
  expect(field().value).toBe("Weekend");
  await act(async () =>
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(2));
  expect(ipc.argsOf("collections.change")[1]).toEqual(ipc.argsOf("collections.change")[0]);
});

it("keeps an unsent rename through privacy loading without showing it meanwhile", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  mainCollections([{ name: "Films", members: [member(kite)] }]);
  await mountTab();
  await row("Films");
  await choose("Films", "Rename");
  await type("Weekend", "Shift");
  const list = ipc.hold("collections.list");
  await act(async () =>
    ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
  );
  await vi.waitFor(() => expect(document.querySelector("input")).toBeNull());
  expect(document.body.innerHTML).not.toContain("Weekend");
  await act(async () => list.resolve([{ id: "c0", name: "Films", total: 1 }]));
  await vi.waitFor(() => expect(field().value).toBe("Weekend"));
  await type("Weekend", "Enter");
  await vi.waitFor(() =>
    expect(ipc.argsOf("collections.change")).toEqual([
      { kind: "rename", id: "c0", name: "Weekend" },
    ]),
  );
});

it("forgets a restricted selection and pending refusal before it can become eligible again", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);

  const main = mainCollections([
    {
      name: "Films",
      members: [member({ ...kite, posterUrl: "https://img.invalid/restricted.jpg" })],
    },
  ]);

  await mountTab();
  await poster("Kite Season, Movie, 2022");
  await pick("Kite Season");
  const held = ipc.hold("collections.change");
  await act(async () => button("Remove from Films").click());
  main.find("c0")!.members = [];

  const page = ipc.hold("collections.page");
  await act(async () =>
    ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
  );
  await vi.waitFor(() => expect(document.querySelector("[data-index]")).toBeNull());
  expect(document.body.innerHTML).not.toContain("restricted.jpg");
  expect(document.body.innerHTML).not.toContain("Kite Season");
  expect(() => button("Retry")).toThrow();
  await act(async () => page.resolve({ total: 0, members: [] }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("0 titles"));
  await act(async () => held.reject({ kind: "unexpected", detail: "refused" }));
  expect(document.querySelector("[role=alert]")).toBeNull();
  main.find("c0")!.members = [member(kite)];
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  await poster("Kite Season, Movie, 2022");
  expect(document.querySelector("[aria-label='1 selected']")).toBeNull();
  expect(() => button("Retry")).toThrow();
  expect(ipc.argsOf("collections.change")).toHaveLength(1);
});

it("discards old collection responses and failures when the full owner changes", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  selectProfileOwner({ id: "mila", revision: 2 });
  mainCollections([{ name: "Old films", members: [member(kite)] }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);
  const stop = syncOnDemand(client);
  unmount = () => {
    stop();
    view.unmount();
  };

  await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
  await poster("Kite Season, Movie, 2022");
  await pick("Kite Season");
  const held = ipc.hold("collections.change");
  await act(async () => button("Remove from Old films").click());
  const oldPage = ipc.hold("collections.page");
  const reads = ipc.argsOf("collections.page").length;
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  await vi.waitFor(() => expect(ipc.argsOf("collections.page").length).toBeGreaterThan(reads));
  await act(async () => {
    client.clear();
    selectProfileOwner({ id: "mila", revision: 3 });
  });
  mainCollections([{ name: "New films", members: [member(kite)] }]);
  const page = ipc.hold("collections.page");
  await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
  await act(async () =>
    oldPage.resolve({
      total: 1,
      members: [member({ ...kite, posterUrl: "https://img.invalid/old-owner.jpg" })],
    }),
  );
  expect(document.body.innerHTML).not.toContain("old-owner.jpg");
  expect(document.body.innerHTML).not.toContain("Old films");
  await act(async () => page.resolve({ total: 1, members: [member(kite)] }));
  await poster("Kite Season, Movie, 2022");
  await act(async () => held.reject({ kind: "unexpected", detail: "old failure" }));
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(document.querySelector("[aria-label='1 selected']")).toBeNull();
  expect(() => button("Retry")).toThrow();
  expect(ipc.argsOf("collections.change")).toHaveLength(1);
});

it.each([false, true])(
  "keeps selected controls and focus while a later page loads or fails: %s",
  async (fails) => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);

    const many = Array.from({ length: 130 }, (_, index) =>
      member(listedTitle("movie", `m${index}`, `Film ${index}`, 2000)),
    );

    mainCollections([{ name: "Big", members: many }]);
    await mountTab();
    const first = await poster("Film 0, Movie, 2000");
    await pick("Film 0");
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='1 selected']")).not.toBeNull(),
    );
    const later = ipc.hold("collections.page");
    const reads = ipc.argsOf("collections.page").length;
    const control = button("Remove from Big");
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      control.focus();
    });
    await vi.waitFor(() => expect(ipc.argsOf("collections.page").length).toBeGreaterThan(reads));
    expect(ipc.argsOf("collections.page").at(-1)?.offset).toBe(120);
    expect(document.querySelector("[aria-label='1 selected']")).not.toBeNull();
    expect(document.activeElement).toBe(control);
    await act(async () =>
      fails
        ? later.reject({ kind: "unexpected", detail: "later page" })
        : later.resolve({ total: 130, members: many.slice(120) }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='1 selected']")).not.toBeNull(),
    );
    expect(button("Remove from Big")).toBe(control);
    expect(document.activeElement).toBe(control);

    if (fails) await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
  },
);

it.each([
  "complete",
  "refuse",
  "retry",
  "owner",
  "revision",
  "version",
  "visit",
  "absent",
  "target",
] as const)(
  "keeps a partial create receipt and uses fresh exact admission: %s",
  async (outcome) => {
    ipc.reset();
    selectProfileOwner({ id: "mila", revision: 2 });
    ipc.always("subscription.list", [SAVED]);
    mainCollections([{ name: "Films", members: [] }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = queryView(client);
    const stop = syncOnDemand(client);
    unmount = () => {
      stop();
      view.unmount();
    };

    const version = { subscriptionId: SUBSCRIPTION, id: kite.id };
    await view.render(createElement(TitleCollections, { title: kite, version }));
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Collections for Kite Season']")).not.toBeNull(),
    );
    await act(async () => button("Add to collection").click());

    const item = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((each) =>
        each.textContent?.includes("New collection"),
      );

      expect(found).toBeTruthy();

      return found!;
    });

    await act(async () => item.click());
    const held = ipc.hold("collections.change");
    await type("Weekend", "Enter");
    const creation = ipc.argsOf("collections.change")[0];

    if (creation?.kind !== "create") throw new Error("No collection creation");
    const list = ipc.hold("collections.list");
    const memberships = ipc.hold("collections.memberships");
    await act(async () =>
      ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
    );
    await view.render(createElement(TitleCollections, { title: null, pending: true, version }));
    await vi.waitFor(() => expect(document.querySelector("input")).toBeNull());
    expect(document.body.innerHTML).not.toContain("Kite Season");
    expect(document.body.innerHTML).not.toContain("Weekend");
    await act(async () => held.resolve(null));
    await act(async () =>
      list.resolve([
        { id: "c0", name: "Films", total: 0 },
        { id: creation.id, name: "Weekend", total: 0 },
      ]),
    );
    await act(async () => memberships.resolve([]));
    expect(ipc.argsOf("collections.change").map((each) => each.kind)).toEqual(["create"]);
    await view.render(createElement(TitleCollections, { title: kite, version }));
    await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("Couldn't save.");
    expect(ipc.argsOf("collections.change").map((each) => each.kind)).toEqual(["create"]);

    if (["owner", "revision", "version", "visit", "absent", "target"].includes(outcome)) {
      if (outcome === "owner") selectProfileOwner({ id: "sam", revision: 2 });

      if (outcome === "revision") selectProfileOwner({ id: "mila", revision: 3 });

      if (outcome === "visit") await view.render(null);

      if (outcome === "absent")
        await view.render(createElement(TitleCollections, { title: null, version }));

      if (outcome === "target") {
        ipc.always("collections.list", [{ id: "c0", name: "Films", total: 0 }]);
        await act(async () => {
          await client.invalidateQueries({ queryKey: ["collections"] });
        });
      }

      await view.render(
        createElement(TitleCollections, {
          title: outcome === "version" ? { ...kite, id: "other" } : kite,
          version: outcome === "version" ? { ...version, id: "other" } : version,
        }),
      );
      await vi.waitFor(() => expect(button("Add to collection")).toBeTruthy());
      expect(() => button("Retry")).toThrow();
      expect(document.querySelector("[role=alert]")).toBeNull();
      expect(ipc.argsOf("collections.change").map((each) => each.kind)).toEqual(["create"]);

      return;
    }

    const fresh = { ...kite, title: "Kite restored", year: 2025 };
    await view.render(createElement(TitleCollections, { title: fresh, version }));
    ipc.always("collections.list", [
      { id: "c0", name: "Films", total: 0 },
      { id: creation.id, name: "Weekend", total: 0 },
    ]);
    const refused = ipc.hold("collections.change");
    await act(async () => button("Retry").click());
    await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(2));
    const target = creation.id;
    expect(ipc.argsOf("collections.change")[1]).toEqual({
      kind: "member",
      id: target,
      title: {
        sourceId: SUBSCRIPTION,
        kind: "movie",
        titleId: kite.id,
        name: "Kite restored",
        year: 2025,
      },
      present: true,
    });

    if (outcome === "complete") {
      await act(async () => refused.resolve(null));
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")).toBeNull());
      expect(ipc.argsOf("collections.change").map((each) => each.kind)).toEqual([
        "create",
        "member",
      ]);

      return;
    }

    if (outcome === "retry") {
      await act(async () => refused.reject({ kind: "unexpected", detail: "disk" }));
      await vi.waitFor(() => expect(button("Retry")).toBeTruthy());
      await view.render(
        createElement(TitleCollections, { title: { ...fresh, title: "Kite current" }, version }),
      );
      const finalAdd = ipc.hold("collections.change");
      await act(async () => button("Retry").click());
      await vi.waitFor(() => expect(ipc.argsOf("collections.change")).toHaveLength(3));
      expect(ipc.argsOf("collections.change")[2]).toEqual({
        kind: "member",
        id: target,
        title: {
          sourceId: SUBSCRIPTION,
          kind: "movie",
          titleId: kite.id,
          name: "Kite current",
          year: 2025,
        },
        present: true,
      });
      await act(async () => finalAdd.resolve(null));
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")).toBeNull());

      return;
    }

    await act(async () => refused.reject({ kind: "title-not-found", titleId: kite.id }));
    await vi.waitFor(() => expect(button("Close")).toBeTruthy());
    expect(() => button("Retry")).toThrow();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "This title isn't available here.",
    );
  },
);

// Smart collections: rules instead of members, edited inline and stored only by Save rules.
describe("a smart collection in the Collections tab", () => {
  const dune = listedTitle("movie", "52", "Dune Road", 2021);
  const options = { qualities: [], languages: [], verified: [], files: 0, genres: [] };

  beforeEach(() => {
    ipc.reset();
    ipc.always("subscription.list", [SAVED]);
    ipc.always("ondemand.filterOptions", options);
    // What the edited rules would match now: one of the two saved matches.
    ipc.answer("ondemand.collection", () => ({ name: "All", titles: [kite], total: 1 }));
    useUi.setState({ details: null });
  });

  /** One smart collection of short films, stored as the main process stores rule changes. */
  function smartMain() {
    let kept: CollectionSummary[] = [
      {
        id: "s0",
        name: "Short films",
        total: 2,
        rules: { kind: "movie", filters: { runtime: { max: 5399 } } },
      },
    ];

    ipc.answer("collections.list", () => kept);
    ipc.answer("collections.page", ({ id }) =>
      id === "s0" ? { total: 2, members: [member(kite), member(dune)] } : { total: 0, members: [] },
    );
    ipc.answer("collections.change", (change) => {
      if (change.kind === "rules")
        kept = kept.map((each) =>
          each.id === change.id ? { ...each, rules: change.rules } : each,
        );
      else if (change.kind === "create")
        kept = [
          ...kept,
          {
            id: change.id,
            name: change.name,
            total: 1,
            ...(change.rules && { rules: change.rules }),
          },
        ];

      return null;
    });
  }

  /** Opens the rule menu named `rule`, or adds it with + Rule, then picks `choice` in it. */
  async function setRule(rule: string, choice: string) {
    const trigger = document.querySelector<HTMLElement>(
      `[role=group][aria-label='${rule}'] button`,
    );

    if (trigger) await act(async () => trigger.click());
    else {
      await act(async () =>
        document.querySelector<HTMLElement>("[role=group][aria-label='Add rule'] button")!.click(),
      );
      const add = await vi.waitFor(() => button(rule));
      await act(async () => add.click());
    }

    const item = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>(
          `[role=menu][aria-label='${rule}'] [role^=menuitem]`,
        ),
      ].find((each) => each.textContent?.trim() === choice);

      if (!found) throw new Error(`No ${choice}`);

      return found;
    });

    await act(async () => item.click());
  }

  const bar = () => document.querySelector<HTMLElement>("[role=group][aria-label='Rules changed']");

  it("previews edited rules, stores them only on Save rules and keeps them when refused", async () => {
    smartMain();
    await mountTab();
    await vi.waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Short films"));
    await poster("Dune Road, Movie, 2021");
    expect(document.querySelector("[aria-label='Runtime: Under 90 min']")).not.toBeNull();

    await setRule("Watched", "Unwatched");
    await vi.waitFor(() => expect(bar()?.textContent).toContain("1 matches, 2 before"));
    expect(document.body.textContent).toContain("1 title");
    // The column keeps the saved count, and nothing is stored or fetched for the edit.
    expect((await row("Short films")).textContent).toContain("2");
    expect(ipc.argsOf("collections.change")).toEqual([]);
    expect(ipc.methods()).not.toContain("ondemand.details");
    expect(ipc.argsOf("ondemand.collection").at(-1)).toMatchObject({
      kind: "movie",
      id: "all",
      filters: { runtime: { max: 5399 }, watched: "unwatched" },
    });

    const refused = ipc.hold("collections.change");
    await act(async () => button("Save rules").click());
    await act(async () => refused.reject({ kind: "unexpected", detail: "disk" }));
    await vi.waitFor(() =>
      expect(bar()?.querySelector("[role=alert]")?.textContent).toBe(
        "Couldn't save. Your changes are kept.",
      ),
    );
    expect(document.querySelector("[aria-label='Watched: Unwatched']")).not.toBeNull();

    await act(async () => button("Retry").click());
    await vi.waitFor(() => expect(bar()).toBeNull());
    expect(ipc.argsOf("collections.change")).toEqual([
      {
        kind: "rules",
        id: "s0",
        rules: { kind: "movie", filters: { runtime: { max: 5399 }, watched: "unwatched" } },
      },
      {
        kind: "rules",
        id: "s0",
        rules: { kind: "movie", filters: { runtime: { max: 5399 }, watched: "unwatched" } },
      },
    ]);
    // The stored rules stay shown while the collections are read again.
    expect(document.querySelector("[aria-label='Watched: Unwatched']")).not.toBeNull();
  });

  it("goes back to the saved rules on Discard, and removes a rule set to Any", async () => {
    smartMain();
    await mountTab();
    await poster("Dune Road, Movie, 2021");

    await setRule("Runtime", "Any");
    await vi.waitFor(() => expect(bar()?.textContent).toContain("Add a rule to save"));
    expect(document.querySelector("[role=group][aria-label='Runtime']")).toBeNull();
    expect(button("Save rules").hasAttribute("disabled")).toBe(true);

    await act(async () => button("Discard").click());
    await vi.waitFor(() => expect(bar()).toBeNull());
    expect(document.querySelector("[aria-label='Runtime: Under 90 min']")).not.toBeNull();
    await poster("Dune Road, Movie, 2021");
    expect(ipc.argsOf("collections.change")).toEqual([]);
  });

  it("keeps edits while a rule save is pending", async () => {
    smartMain();
    await mountTab();
    await poster("Dune Road, Movie, 2021");
    await setRule("Rating", "7+");
    const held = ipc.hold("collections.change");
    await act(async () => button("Save rules").click());
    expect(button("Discard").hasAttribute("disabled")).toBe(true);
    await act(async () => held.reject({ kind: "unexpected", detail: "disk" }));
    await vi.waitFor(() => expect(button("Discard").hasAttribute("disabled")).toBe(false));
    expect(bar()?.textContent).toContain("Your changes are kept");
  });

  it("makes a smart collection as a draft that is stored with its first saved rule", async () => {
    smartMain();
    const loading = ipc.hold("ondemand.filterOptions");
    await mountTab();
    await row("Short films");

    await act(async () => button("New collection").click());

    const smart = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((each) =>
        each.textContent?.startsWith("Smart collection"),
      );

      if (!found) throw new Error("No Smart collection");

      return found;
    });

    await act(async () => smart.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Short comedies", "Enter");

    await vi.waitFor(() =>
      expect(document.querySelector("h1")?.textContent).toBe("Short comedies"),
    );
    expect((await row("Short comedies")).textContent).toContain("New");

    const draft = () =>
      document.querySelector<HTMLElement>("[role=group][aria-label='New smart collection']");

    expect(draft()?.textContent).toContain("Add a rule to save");
    expect(ipc.argsOf("collections.change")).toEqual([]);

    await act(async () =>
      document.querySelector<HTMLElement>("[role=group][aria-label='Add rule'] button")!.click(),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[role=menu][aria-label='Add rule']")).not.toBeNull(),
    );

    const choices = [...document.querySelectorAll("[role=menuitem]")].map(
      (item) => item.textContent,
    );

    expect(choices).toEqual(["Year", "Runtime", "Rating", "Watched", "Source"]);
    await act(async () =>
      document
        .querySelector<HTMLElement>("[role=menuitem]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(async () => loading.reject({ kind: "unexpected", detail: "choices unavailable" }));
    await vi.waitFor(() => expect(button("Try again")).toBeTruthy());
    await act(async () =>
      document.querySelector<HTMLElement>("[role=group][aria-label='Add rule'] button")!.click(),
    );
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent),
      ).toEqual(["Year", "Runtime", "Rating", "Watched", "Source"]),
    );
    await act(async () =>
      document
        .querySelector<HTMLElement>("[role=menuitem]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await setRule("Rating", "7+");
    ipc.always("ondemand.filterOptions", { qualities: [], languages: [], verified: [], files: 0 });
    await act(async () => button("Try again").click());
    await vi.waitFor(() => expect(() => button("Try again")).toThrow());
    expect(document.querySelector("h1")?.textContent).toBe("Short comedies");
    await act(async () =>
      document.querySelector<HTMLElement>("[role=group][aria-label='Add rule'] button")!.click(),
    );
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent),
      ).toContain("Genre"),
    );
    await act(async () =>
      document
        .querySelector<HTMLElement>("[role=menuitem]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await vi.waitFor(() => expect(button("Save rules").hasAttribute("disabled")).toBe(false));
    await act(async () => button("Save rules").click());
    await vi.waitFor(() => expect(draft()).toBeNull());
    expect(ipc.argsOf("collections.change")).toEqual([
      {
        kind: "create",
        id: expect.any(String),
        name: "Short comedies",
        rules: { kind: "movie", filters: { rating: { min: 7 } } },
      },
    ]);
    // Stored, it is a smart collection in the column like the others, no longer New.
    await vi.waitFor(async () =>
      expect((await row("Short comedies")).textContent).toBe("Short comediesSmart collection1"),
    );
  });

  it("renames a refused smart draft without losing its rules or changing the stored collection", async () => {
    smartMain();
    await mountTab();
    await row("Short films");
    await act(async () => button("New collection").click());

    const smart = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((each) =>
        each.textContent?.startsWith("Smart collection"),
      );

      if (!found) throw new Error("No Smart collection");

      return found;
    });

    await act(async () => smart.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Short films", "Enter");
    await setRule("Rating", "7+");

    const refused = ipc.hold("collections.change");
    await act(async () => button("Save rules").click());
    await act(async () => refused.reject({ kind: "list-name-taken" }));

    const draftBar = () =>
      document.querySelector<HTMLElement>("[role=group][aria-label='New smart collection']");

    await vi.waitFor(() =>
      expect(draftBar()?.textContent).toContain("Another list has this name."),
    );

    const first = ipc.argsOf("collections.change")[0]!;
    expect(first).toEqual({
      kind: "create",
      id: expect.any(String),
      name: "Short films",
      rules: { kind: "movie", filters: { rating: { min: 7 } } },
    });

    if (first.kind !== "create") throw new Error("Expected a draft create");

    const selected = () =>
      document.querySelector<HTMLButtonElement>("nav[aria-label=Collections] [aria-current=page]");

    const options = () => {
      const found = selected()?.closest("li")?.querySelector<HTMLButtonElement>("[aria-label]");

      if (!found) throw new Error("No draft options");

      return found;
    };

    await act(async () => options().click());
    await vi.waitFor(() => expect(button("Rename")).toBeTruthy());
    expect(
      [...document.querySelectorAll("[role=menuitem]")].map((each) => each.textContent),
    ).toEqual(["Rename"]);
    await act(async () => button("Rename").click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Discarded name", "Escape");
    expect(document.activeElement).toBe(selected());
    expect(document.querySelector("h1")?.textContent).toBe("Short films");
    expect(draftBar()?.textContent).toContain("Another list has this name.");

    await act(async () => options().click());
    await act(async () => (await vi.waitFor(() => button("Rename"))).click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Rated 7+", "Enter");
    expect(document.activeElement).toBe(selected());
    expect(document.querySelector("h1")?.textContent).toBe("Rated 7+");
    expect(draftBar()?.querySelector("[role=alert]")).toBeNull();
    expect(draftBar()?.textContent).toContain("1 title");
    expect(document.querySelector("[aria-label='Rating: 7+']")).not.toBeNull();
    expect(ipc.argsOf("collections.change")).toHaveLength(1);

    await act(async () => options().click());
    await act(async () => (await vi.waitFor(() => button("Rename"))).click());
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    await type("Friday films", "End");
    // Browser pointer focus transfers only if mouse-down was not prevented by the button.
    const retry = button("Save rules");
    await act(async () => {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      retry.dispatchEvent(down);

      if (!down.defaultPrevented) retry.focus();
    });
    expect(document.querySelector("h1")?.textContent).toBe("Friday films");
    const saving = ipc.hold("collections.change");
    await act(async () => retry.click());
    expect(options().disabled).toBe(true);
    expect(button("Discard").hasAttribute("disabled")).toBe(true);
    expect(ipc.argsOf("collections.change")).toEqual([first, { ...first, name: "Friday films" }]);
    ipc.always("collections.list", [
      {
        id: "s0",
        name: "Short films",
        total: 2,
        rules: { kind: "movie", filters: { runtime: { max: 5399 } } },
      },
      {
        id: first.id,
        name: "Friday films",
        total: 1,
        rules: { kind: "movie", filters: { rating: { min: 7 } } },
      },
    ]);
    await act(async () => saving.resolve(null));
    await vi.waitFor(() => expect(draftBar()).toBeNull());
    expect((await row("Short films")).textContent).toBe("Short filmsSmart collection2");
    expect((await row("Friday films")).textContent).toBe("Friday filmsSmart collection1");
    expect(ipc.methods()).not.toContain("ondemand.details");
  });

  it("refreshes saved runtime matches on return and cancels an obsolete first page", async () => {
    smartMain();
    ipc.always("collections.page", { total: 0, members: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = queryView(client);
    unmount = () => view.unmount();
    await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("No titles match"));
    await view.render(createElement(CollectionsPage, { kind: "movie", active: false }));
    const old = ipc.hold("collections.page");
    void client.resetQueries({ queryKey: ["collections", "page"] });
    await vi.waitFor(() => expect(ipc.argsOf("collections.page").length).toBeGreaterThan(1));
    // Details loaded from global search changed runtime facts, without a viewing/catalogue event.
    ipc.always("collections.page", { total: 1, members: [member(kite)] });
    ipc.always("collections.list", [
      {
        id: "s0",
        name: "Short films",
        total: 1,
        rules: { kind: "movie", filters: { runtime: { max: 5399 } } },
      },
    ]);
    await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
    await poster("Kite Season, Movie, 2022");
    await act(async () => old.resolve({ total: 0, members: [] }));
    await poster("Kite Season, Movie, 2022");
    await vi.waitFor(async () => expect((await row("Short films")).textContent).toContain("1"));
  });

  it("refreshes smart matches and counts on this owner's viewing event alone", async () => {
    const owner = { id: "sam", revision: 2 };
    selectProfileOwner(owner);
    smartMain();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = queryView(client);
    const stop = syncViewing(client);
    unmount = () => {
      stop();
      view.unmount();
    };

    await view.render(createElement(CollectionsPage, { kind: "movie", active: true }));
    await poster("Dune Road, Movie, 2021");
    ipc.always("collections.list", [
      {
        id: "s0",
        name: "Short films",
        total: 0,
        rules: { kind: "movie", filters: { watched: "unwatched" } },
      },
    ]);
    ipc.always("collections.page", { total: 0, members: [] });
    const beforeWrong = ipc.argsOf("collections.page").length;
    await act(async () =>
      ipc.emit("profiles.viewingChanged", { owner: { id: "other", revision: 2 }, sequence: 1 }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(ipc.argsOf("collections.page")).toHaveLength(beforeWrong);
    await poster("Dune Road, Movie, 2021");
    await act(async () => ipc.emit("profiles.viewingChanged", { owner, sequence: 1 }));
    await vi.waitFor(() => expect(document.querySelector("[data-index] button")).toBeNull());
    expect((await row("Short films")).textContent).toContain("0");
  });

  it("keeps the matches shown when reading them again fails, and says when they are from", async () => {
    const viewer = { id: "sam", revision: 2 };
    selectProfileOwner(viewer);
    smartMain();
    await mountTab();
    await poster("Dune Road, Movie, 2021");

    ipc.refuse("collections.page", { kind: "unexpected", detail: "worker" });
    await act(async () => ipc.emit("collections.changed", { owner: { ...viewer } }));
    await vi.waitFor(() =>
      expect(document.querySelector("[role=alert]")?.textContent).toMatch(
        /^Couldn't refresh your sources\. Showing matches from .+\. Try again$/,
      ),
    );
    await poster("Dune Road, Movie, 2021");
  });

  it("is left out of the picks' Add to collection and offers no Remove", async () => {
    smartMain();
    ipc.answer("collections.list", () => [
      {
        id: "s0",
        name: "Short films",
        total: 2,
        rules: { kind: "movie", filters: { runtime: { max: 5399 } } },
      },
      {
        id: "s1",
        name: "Long films",
        total: 0,
        rules: { kind: "movie", filters: { runtime: { min: 7200 } } },
      },
      { id: "c0", name: "Weekend films", total: 0 },
    ]);
    await mountTab();
    await poster("Kite Season, Movie, 2022");
    await pick("Kite Season");
    await act(async () => button("Add to collection").click());
    await vi.waitFor(() => expect(button("Weekend films")).toBeTruthy());
    expect(
      [
        ...document.querySelectorAll("[role=menu][aria-label='Add to collection'] [role=menuitem]"),
      ].map((each) => each.textContent),
    ).toEqual(["Weekend films"]);
    expect(() => button("Remove from Short films")).toThrow();
  });
});

it("leaves smart collections out of a title's collections menu", async () => {
  const view = bareView();
  unmount = view.unmount;
  await view.render(
    createElement(CollectionMembership, {
      title: {
        sourceId: SUBSCRIPTION,
        kind: "movie",
        titleId: "41",
        name: "Kite Season",
        year: 2022,
      },
      collections: [
        {
          id: "s0",
          name: "Short films",
          total: 2,
          rules: { kind: "movie", filters: { runtime: { max: 5399 } } },
        },
        { id: "c0", name: "Weekend films", total: 0 },
      ],
      memberOf: new Set<string>(),
      commit: async () => {},
    }),
  );
  await act(async () => button("Add to collection").click());

  const ticks = await vi.waitFor(() => {
    const found = [...document.querySelectorAll("[role=menuitemcheckbox]")];
    expect(found).not.toHaveLength(0);

    return found;
  });

  expect(ticks.map((each) => each.textContent)).toEqual(["Weekend films"]);
});
