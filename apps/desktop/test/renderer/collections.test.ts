// @vitest-environment happy-dom
// The viewer's collections column and a title's collections menu, driven as the viewer drives
// them: each sends one change and shows it once stored, a refused one says so and sends the same
// change again, and a title goes in a collection as the exact source version it was given.
import { act, createElement, useState } from "react";
import { bareView } from "./mount.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectionKey,
  type CollectionChange,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
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
