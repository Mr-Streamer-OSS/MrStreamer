// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  ipc.reset();
});

it("shows mapped titles without live channels or invented added dates, and opens their full list", async () => {
  const subscription = { ...SAVED, kind: "m3u" as const, playlistMapped: true, username: "" };
  const title: Title = {
    kind: "movie",
    key: "movie:exact",
    subscriptionId: subscription.id,
    id: "exact",
    name: "Playlist film",
    title: "Playlist film",
    originalTitle: null,
    originalLanguage: null,
    tags: [],
    year: null,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: subscription.id, id: "exact", tags: [] }],
  };
  ipc.always("subscription.list", [subscription]);
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
  ipc.always("ondemand.collection", { name: "All", total: 1, titles: [title] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [subscription]);
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
  await vi.waitFor(async () => {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(container.textContent).toContain("Playlist film");
  });
  expect(container.textContent).not.toContain("No live channels");
  expect(ipc.argsOf("ondemand.collection").every((query) => query.id === "all")).toBe(true);
  expect(ipc.argsOf("watchlist.list")).toHaveLength(1);
  const heading = [...container.querySelectorAll("h2")].find(
    (element) => element.textContent === "Movies",
  );
  const movies = heading?.closest("section")?.querySelector("button");
  expect(movies).toBeDefined();
  await act(async () => movies?.click());
  expect(useUi.getState().view).toBe("movies");
});
