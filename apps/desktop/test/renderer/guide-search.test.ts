// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GuideSearchPage, ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { defined } from "@mrstreamer/core/defined";
import { queryView } from "./mount.ts";
import { GuideSearch, useGuideSearch } from "../../src/renderer/src/features/live/GuideSearch.tsx";
import { queries, syncGuideUpdates } from "../../src/renderer/src/lib/queries.ts";

const NOW = new Date(2026, 10, 5, 20, 0).getTime();
const HOUR = 60 * 60 * 1000;

const channel = (id: string, title: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: title,
  title,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: title, tags: [], quality: null }],
});

const MERIDIAN = channel("1", "Meridian");
const RIVERBEND = channel("2", "Riverbend");

const match = (
  on: LiveChannel,
  start: number,
  metadata?: ProgrammeMatch["programme"]["metadata"],
): ProgrammeMatch => ({
  channel: on,
  programme: {
    start,
    stop: start + HOUR,
    title: "Rally Hour",
    description: null,
    ...defined({ metadata }),
  },
});

let unmount = () => {};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  ipc.reset();
  ipc.always("guide.cancelSearch", null);
  useGuideSearch.setState({ open: true, query: "" });
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

const settled = (ms = 30) => act(() => vi.advanceTimersByTimeAsync(ms));

async function panel(saved: "read" | "unreadable" = "read") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);

  if (saved === "read") ipc.always("guide.savedQueries", []);
  else ipc.refuse("guide.savedQueries", { kind: "unexpected", detail: "unreadable" });

  const mounted = queryView(client);
  await mounted.render(
    createElement(GuideSearch, {
      list: "Favourites",
      channels: [MERIDIAN, RIVERBEND],
      everything: false,
      filtered: [],
      playing: undefined,
      onWatch: () => {},
    }),
  );
  unmount = () => mounted.unmount();
  await settled();
  const { container } = mounted;

  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.textContent === name || each.getAttribute("aria-label") === name,
    )!;

  return {
    client,
    render: mounted.render,
    container,
    button,
    field: () => container.querySelector<HTMLInputElement>("input")!,
    rows: () =>
      [...container.querySelectorAll<HTMLButtonElement>("[data-guide-row]")].map(
        (row) => row.textContent,
      ),
    click: (target: HTMLElement) => act(async () => target.click()),
    press: (key: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
    type: async (text: string) => {
      await act(async () => useGuideSearch.setState({ query: text }));
      await settled(250);
    },
  };
}

it("searches every kept day a page at a time, from the first page again after a filter changes", async () => {
  const first = ipc.hold("guide.searchPage");
  const view = await panel();
  await view.type("rally");

  expect(ipc.argsOf("guide.searchPage")).toEqual([
    expect.objectContaining({ subscriptionId: SUBSCRIPTION, query: "rally", limit: 50 }),
  ]);
  expect(ipc.argsOf("guide.searchPage")[0]).not.toHaveProperty("from");
  expect(ipc.argsOf("guide.searchPage")[0]).not.toHaveProperty("until");

  const page: GuideSearchPage = {
    matches: [match(MERIDIAN, NOW - 30 * HOUR), match(RIVERBEND, NOW + 3 * HOUR)],
    next: { start: NOW + 3 * HOUR, channel: "2" },
  };

  first.resolve(page);
  await settled();
  expect(view.rows()).toHaveLength(2);
  expect(view.rows()[0]).toContain("Yesterday");
  expect(view.rows()[1]).toContain("Today");

  const more = ipc.hold("guide.searchPage");
  await view.click(view.button("Show more"));
  expect(ipc.argsOf("guide.searchPage")[1]).toMatchObject({
    after: { start: NOW + 3 * HOUR, channel: "2" },
  });
  more.resolve({ matches: [match(MERIDIAN, NOW + 30 * HOUR)], next: null });
  await settled();
  expect(view.rows()).toHaveLength(3);
  expect(view.button("Show more")).toBeUndefined();

  // A narrower search starts over: no cursor, and This list names the list's own channels.
  ipc.hold("guide.searchPage");
  await view.click(view.button("Favourites"));
  const narrowed = ipc.argsOf("guide.searchPage")[2]!;
  expect(narrowed).not.toHaveProperty("after");
  expect(narrowed.channels).toEqual(["1", "2"]);
  expect(view.rows()).toEqual([]);
  const revisit = ipc.hold("guide.searchPage");
  await view.click(view.button("All channels"));
  expect(view.rows()).toEqual([]);
  revisit.resolve({ matches: [match(MERIDIAN, NOW)], next: null });
  await settled();
  expect(view.rows()).toHaveLength(1);
  expect(
    ipc
      .argsOf("guide.searchPage")
      .slice(3)
      .every((input) => !("after" in input)),
  ).toBe(true);
});

it("shows episode numbers only as the guide gives them, and never calls an episode new", async () => {
  ipc.always("guide.searchPage", {
    matches: [
      match(MERIDIAN, NOW + HOUR, {
        episode: { season: 1, episode: 3, part: 0 },
        subtitle: "The Final Lap",
      }),
      // A malformed xmltv_ns number gives no season or episode; a premiere is only said.
      match(RIVERBEND, NOW + 2 * HOUR, {
        episodes: [{ system: "xmltv_ns", value: "one.two" }],
        premiere: "First showing",
      }),
      match(MERIDIAN, NOW + 3 * HOUR, { repeat: {} }),
      match(RIVERBEND, NOW + 4 * HOUR),
    ],
    next: null,
  });
  const view = await panel();
  await view.type("rally");
  await settled();

  const [numbered, malformed, repeat, plain] = view.rows();
  expect(numbered).toContain("S2 E4 · The Final Lap");
  expect(malformed).toContain("Premiere");
  expect(malformed).not.toMatch(/S\d+ E\d+/);
  expect(repeat).toContain("Shown before");
  expect(plain).toMatch(/Rally Hour$/);
  expect(view.container.textContent).not.toMatch(/\bNew\b/);
});

it("moves between matches with the keyboard and closes with Escape", async () => {
  ipc.always("guide.searchPage", {
    matches: [match(MERIDIAN, NOW + HOUR), match(RIVERBEND, NOW + 2 * HOUR)],
    next: null,
  });
  const view = await panel();
  await view.type("rally");
  await settled();
  act(() => view.field().focus());

  await view.press("ArrowDown");
  expect(document.activeElement?.textContent).toContain("Meridian");
  await view.press("ArrowDown");
  expect(document.activeElement?.textContent).toContain("Riverbend");
  await view.press("Enter");
  await view.press("Escape");
  expect(document.activeElement).toBe(view.field());
  await view.press("Escape");
  expect(useGuideSearch.getState().query).toBe("");
  await view.press("Escape");
  expect(useGuideSearch.getState().open).toBe(false);
});

it("keeps the saved searches when a save fails, and saves nothing over ones it can't read", async () => {
  const view = await panel();
  await view.type("rally");
  ipc.refuse("guide.setSavedQueries", { kind: "unexpected", detail: "disk full" });
  await view.click(view.button("Save search"));
  await settled();
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "The search couldn't be saved.",
  );
  expect(view.container.textContent).toContain("No saved searches");

  ipc.always("guide.setSavedQueries", [{ name: "rally", query: "rally" }]);
  await view.click(view.button("Retry"));
  await settled();
  expect(view.button("rally")?.getAttribute("aria-pressed")).toBe("true");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  unmount();

  const unreadable = await panel("unreadable");
  await unreadable.type("rally");
  expect(unreadable.container.textContent).toContain("Saved searches couldn't be read.");
  expect(unreadable.button("Save search")).toBeUndefined();
});

it("returns Escape from filters and save controls to the field before clearing or closing", async () => {
  const view = await panel();
  await view.type("rally");

  for (const name of ["Today", "Save search"]) {
    act(() => view.button(name).focus());
    await view.press("Escape");
    expect(document.activeElement).toBe(view.field());
    expect(useGuideSearch.getState()).toMatchObject({ open: true, query: "rally" });
  }
});

it("saves named days and distinct queries whose shortened names collide", async () => {
  const view = await panel();
  const prefix = "a".repeat(80);
  await view.type(prefix + "one");
  await view.click(view.button("Today"));
  ipc.always("guide.setSavedQueries", [{ name: prefix, query: prefix + "one", days: "today" }]);
  await view.click(view.button("Save search"));
  await settled();
  expect(ipc.argsOf("guide.setSavedQueries")[0]?.queries[0]).toMatchObject({ days: "today" });
  expect(ipc.argsOf("guide.setSavedQueries")[0]?.queries[0]).not.toHaveProperty("from");
  await view.type(prefix + "two");
  await view.click(view.button("Save search"));
  const queries = ipc.argsOf("guide.setSavedQueries")[1]?.queries;
  expect(queries).toHaveLength(2);
  expect(new Set(queries?.map((each) => each.name)).size).toBe(2);
  expect(queries?.map((each) => each.query)).toEqual([prefix + "one", prefix + "two"]);
  ipc.always("guide.setSavedQueries", queries!);
  await view.click(view.button("Save search"));
  await settled();
  await view.click(view.button("Tomorrow"));
  await view.click(view.button("Save search"));
  const updated = ipc.argsOf("guide.setSavedQueries").at(-1)?.queries;
  expect(updated).toHaveLength(2);
  expect(updated?.[1]).toMatchObject({
    name: queries![1]!.name,
    query: prefix + "two",
    days: "tomorrow",
  });
});

it("uses seven calendar days across the autumn DST change and resolves saved Today on apply", async () => {
  const previous = process.env["TZ"];
  process.env["TZ"] = "Europe/Brussels";

  try {
    vi.setSystemTime(new Date(2026, 9, 24, 12));
    const view = await panel();
    ipc.always("guide.searchPage", { matches: [], next: null });
    await view.type("rally");
    await view.click(view.button("Next 7 days"));
    expect(ipc.argsOf("guide.searchPage").at(-1)).toMatchObject({
      from: new Date(2026, 9, 24).getTime(),
      until: new Date(2026, 9, 31).getTime(),
    });
    await view.click(view.button("Today"));
    ipc.always("guide.setSavedQueries", [{ name: "rally", query: "rally", days: "today" }]);
    await view.click(view.button("Save search"));
    await settled();
    vi.setSystemTime(new Date(2026, 9, 26, 12));
    await settled(60_000);
    await view.click(view.button("rally"));
    await settled();
    expect(ipc.argsOf("guide.searchPage").at(-1)).toMatchObject({
      from: new Date(2026, 9, 26).getTime(),
      until: new Date(2026, 9, 27).getTime(),
    });
  } finally {
    if (previous === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previous;
  }
});

it("retries a refused first page and retains rows when the next page is refused", async () => {
  ipc.refuse("guide.searchPage", { kind: "unexpected", detail: "offline" });
  const view = await panel();
  await view.type("rally");
  await settled();
  expect(view.rows()).toEqual([]);
  expect(view.container.textContent).toContain("Service unavailable");
  ipc.always("guide.searchPage", {
    matches: [match(MERIDIAN, NOW)],
    next: { start: NOW, channel: "1" },
  });
  await view.click(view.button("Retry"));
  await settled();
  expect(view.rows()).toHaveLength(1);
  ipc.refuse("guide.searchPage", { kind: "unexpected", detail: "offline" });
  await view.click(view.button("Show more"));
  await settled();
  expect(view.rows()).toHaveLength(1);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "Service unavailable",
  );
  ipc.always("guide.searchPage", { matches: [match(RIVERBEND, NOW + HOUR)], next: null });
  await view.click(view.button("Show more"));
  await settled();
  expect(view.rows()).toHaveLength(2);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("cannot act on late matches after typing, filtering or unmounting the panel", async () => {
  const old = ipc.hold("guide.searchPage");
  const view = await panel();
  await view.type("old");
  const current = ipc.hold("guide.searchPage");
  await view.type("current");
  old.resolve({ matches: [match(MERIDIAN, NOW)], next: null });
  await settled();
  expect(view.rows()).toEqual([]);
  current.resolve({ matches: [match(RIVERBEND, NOW)], next: null });
  await settled();
  expect(view.rows().join()).toContain("Riverbend");
  const filtered = ipc.hold("guide.searchPage");
  await view.click(view.button("Tomorrow"));
  expect(view.rows()).toEqual([]);
  const latest = ipc.hold("guide.searchPage");
  await view.click(view.button("Today"));
  filtered.resolve({ matches: [match(MERIDIAN, NOW + 24 * HOUR)], next: null });
  await settled();
  expect(view.rows()).toEqual([]);
  unmount();
  latest.resolve({ matches: [match(MERIDIAN, NOW)], next: null });
  await settled();
  expect(view.container.querySelector("[data-guide-row]")).toBeNull();
});

it("disables a new save at twenty while allowing an existing query to update", async () => {
  const saved = Array.from({ length: 20 }, (_, i) => ({ name: `saved ${i}`, query: `query ${i}` }));
  const view = await panel();
  await act(async () => view.client.setQueryData(["guide", "savedQueries", SUBSCRIPTION], saved));
  await view.type("new query");
  expect(view.button("Save search").disabled).toBe(true);
  expect(view.container.textContent).toContain("20 saved at most");
  await view.type("query 0");
  expect(view.button("Save search").disabled).toBe(false);
  ipc.always("guide.setSavedQueries", saved);
  await view.click(view.button("Tomorrow"));
  await view.click(view.button("Save search"));
  await settled();
  const written = ipc.argsOf("guide.setSavedQueries").at(-1)!.queries;
  expect(written).toHaveLength(20);
  expect(written.find((each) => each.query === "query 0")).toMatchObject({ days: "tomorrow" });
});

it("keeps a delayed save owned by its subscription after switching away and reopening", async () => {
  const view = await panel();
  await view.type("rally");
  const write = ipc.hold("guide.setSavedQueries");
  await view.click(view.button("Save search"));
  const other = { ...SAVED, id: "3f6c1b5e-2a47-4d0e-9c1f-7b8a5d2e4f11", name: "Other" };
  await act(async () => view.client.setQueryData(queries.subscriptions().queryKey, [SAVED, other]));
  await settled();
  await view.click(view.button("Other"));
  ipc.answer("guide.savedQueries", ({ subscriptionId }) =>
    subscriptionId === SUBSCRIPTION ? [{ name: "rally", query: "rally" }] : [],
  );
  write.resolve([{ name: "rally", query: "rally" }]);
  await settled();
  expect(view.button("rally")).toBeUndefined();
  ipc.hold("guide.savedQueries");
  await view.click(view.button("line.example.tv"));
  await settled();
  expect(view.button("rally")).toBeDefined();
  ipc.always("guide.savedQueries", [{ name: "rally", query: "rally" }]);
  // Closing unmounts the panel, as GuidePage does, while preserving the public query client.
  await view.render(createElement("div"));
  await view.render(
    createElement(GuideSearch, {
      list: "Favourites",
      channels: [MERIDIAN],
      everything: false,
      filtered: [],
      playing: undefined,
      onWatch: () => {},
    }),
  );
  await settled();
  expect(view.button("rally")).toBeDefined();
  expect(ipc.argsOf("guide.setSavedQueries")).toEqual([
    { subscriptionId: SUBSCRIPTION, queries: [{ name: "rally", query: "rally", days: "any" }] },
  ]);
});

it("replaces mounted matches after a guide or mapping update, rejecting the held older reply", async () => {
  const old = ipc.hold("guide.searchPage");
  const view = await panel();
  const stop = syncGuideUpdates(view.client);

  try {
    await view.type("rally");
    ipc.always("guide.searchPage", { matches: [match(RIVERBEND, NOW)], next: null });
    await act(async () => ipc.emit("guide.updated", null));
    await settled();
    expect(view.rows().join()).toContain("Riverbend");
    old.resolve({ matches: [match(MERIDIAN, NOW)], next: null });
    await settled();
    expect(view.rows().join()).not.toContain("Meridian");
    ipc.always("guide.searchPage", { matches: [], next: null });
    await act(async () => ipc.emit("guide.updated", null));
    await settled();
    expect(view.rows()).toEqual([]);
    expect(view.container.textContent).toContain("No matches");
  } finally {
    stop();
  }
});

it("explains empty and oversized lists, and prefers a source filter over playback then falls back after removal", async () => {
  const view = await panel();
  const other = { ...SAVED, id: "3f6c1b5e-2a47-4d0e-9c1f-7b8a5d2e4f11", name: "Other" };
  await act(async () => view.client.setQueryData(queries.subscriptions().queryKey, [SAVED, other]));

  const render = async (channels: LiveChannel[], filtered: string[], playing: string) => {
    await view.render(createElement("div"));
    await view.render(
      createElement(GuideSearch, {
        list: "Favourites",
        channels,
        everything: false,
        filtered,
        playing,
        onWatch: () => {},
      }),
    );
    await settled();
  };

  await render([], [SUBSCRIPTION], other.id);
  expect(view.button("line.example.tv").getAttribute("aria-pressed")).toBe("true");
  expect(view.button("Favourites").disabled).toBe(true);
  expect(view.container.textContent).toContain("None from this subscription");
  await render(
    Array.from({ length: 101 }, (_, i) => channel(String(i), `Channel ${i}`)),
    [],
    SUBSCRIPTION,
  );
  expect(view.button("Favourites").disabled).toBe(true);
  expect(view.container.textContent).toContain("Over 100 channels");
  await render([MERIDIAN], [], other.id);
  expect(view.button("Other").getAttribute("aria-pressed")).toBe("true");
  await view.click(view.button("line.example.tv"));
  expect(view.button("line.example.tv").getAttribute("aria-pressed")).toBe("true");
  await act(async () => view.client.setQueryData(queries.subscriptions().queryKey, [other]));
  await settled();
  await view.type("rally");
  expect(ipc.argsOf("guide.searchPage").at(-1)?.subscriptionId).toBe(other.id);
});

it("shows a save completed while closed when the panel reopens", async () => {
  const view = await panel();
  await view.type("rally");
  const write = ipc.hold("guide.setSavedQueries");
  await view.click(view.button("Save search"));
  await view.render(createElement("div"));
  write.resolve([{ name: "rally", query: "rally" }]);
  await settled();
  ipc.hold("guide.savedQueries");
  await view.render(
    createElement(GuideSearch, {
      list: "Favourites",
      channels: [MERIDIAN],
      everything: false,
      filtered: [],
      playing: undefined,
      onWatch: () => {},
    }),
  );
  await settled();
  expect(view.button("rally")).toBeDefined();
});
