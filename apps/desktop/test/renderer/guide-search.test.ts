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
import { queries } from "../../src/renderer/src/lib/queries.ts";

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
