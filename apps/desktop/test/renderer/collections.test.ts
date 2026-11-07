// @vitest-environment happy-dom
// The viewer's collections column and a title's collections menu, driven as the viewer drives
// them: each sends one change and shows it once stored, a refused one says so and sends the same
// change again, and a title goes in a collection as the exact source version it was given. Then
// the same, mounted: the Collections tab's grid and picks, and the menu in a title's details.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { bareView, queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import {
  collectionKey,
  type CollectionChange,
  type CollectionMember,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { CollectionsPage } from "../../src/renderer/src/features/collections/CollectionsPage.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import {
  CollectionMembership,
  CollectionNav,
  type CollectionSummary,
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
  await view.render(createElement(CollectionsPage, { active: true }));
  unmount = view.unmount;
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
  }

  beforeEach(() => ipc.reset());

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
