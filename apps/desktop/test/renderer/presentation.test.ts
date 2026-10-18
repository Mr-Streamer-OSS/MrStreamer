// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { homeRows } from "@mrstreamer/core/home/rows";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { useNow } from "../../src/renderer/src/lib/clock.ts";
import { PresentationVisible } from "../../src/renderer/src/lib/presentation.ts";

let cleanup = () => {};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

function Clock({ name }: { name: string }) {
  return createElement("output", { "aria-label": name }, String(useNow()));
}

it("keeps a covered page's clock still while Watch advances and refreshes on return", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const render = (visible: boolean) =>
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(
            PresentationVisible,
            { value: visible },
            createElement(Clock, { name: "page" }),
          ),
          createElement(Clock, { name: "Watch" }),
        ),
      ),
    );
  vi.setSystemTime(100_000);
  render(true);
  render(false);
  const held = container.querySelector('[aria-label="page"]')?.textContent;
  await act(() => vi.advanceTimersByTimeAsync(75_000));
  expect(container.querySelector('[aria-label="page"]')?.textContent).toBe(held);
  expect(Number(container.querySelector('[aria-label="Watch"]')?.textContent)).toBeGreaterThan(
    Number(held),
  );
  render(true);
  expect(Number(container.querySelector('[aria-label="page"]')?.textContent)).toBe(Date.now());
});

it("skips disabled Home title rows even before saved preferences answer, then reads an enabled row", async () => {
  const preferences = ipc.hold("preferences.get");
  const saved = {
    ...defaultPreferences,
    homeRows: homeRows(undefined).map((row) => ({ ...row, visible: false })),
  };
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.always("library.channels", []);
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.collection", { name: "New movies", total: 0, titles: [] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(HomeScreen, { active: false })),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection")).toEqual([]);
  await act(async () => preferences.resolve(saved));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection")).toEqual([]);
  expect(ipc.argsOf("watchlist.list")).toEqual([]);
  expect(ipc.argsOf("ondemand.recommendations")).toEqual([]);
  ipc.prefer({
    homeRows: saved.homeRows.map((row) => ({ ...row, visible: row.id === "new-movies" })),
  });
  await act(async () => client.invalidateQueries({ queryKey: ["preferences"] }));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection").map((query) => query.kind)).toEqual(["movie"]);
});
