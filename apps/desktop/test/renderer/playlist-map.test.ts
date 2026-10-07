// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaylistGroupPage } from "@mrstreamer/contracts/playlist";
import {
  PlaylistMap,
  PlaylistRows,
} from "../../src/renderer/src/features/settings/PlaylistMap.tsx";

const subscription = { ...SAVED, kind: "m3u" as const, username: "" };
const groups: PlaylistGroupPage = {
  status: { explicit: true, groups: 2, live: 1, movies: 2, series: 0, episodes: 0, omitted: 60 },
  total: 2,
  groups: [
    {
      group: "film-key",
      name: "Films",
      mode: "movie",
      entries: 2,
      samples: [{ name: "Film", groups: ["Films"], reason: null }],
    },
    {
      group: "new-key",
      name: "New group",
      mode: null,
      entries: 60,
      samples: [{ name: "Waiting", groups: ["New group"], reason: "unmapped" }],
    },
  ],
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  ipc.reset();
});
async function render(element: ReturnType<typeof createElement>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["subscriptions"], [subscription]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  const click = async (label: string) => {
    await act(async () => button(label)?.click());
    await settle();
  };
  return { client, button, click, settle, container };
}

describe("playlist mapping in Settings", () => {
  it("shows a group's mapping and samples, saves each pick immediately and updates the saved subscription", async () => {
    ipc.always("playlist.groups", groups);
    const app = await render(createElement(PlaylistMap, { subscription, onClose: () => {} }));
    expect(app.button("Movies")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Film");
    const save = ipc.hold("playlist.map");
    await app.click("Live TV");
    expect(ipc.argsOf("playlist.map")).toEqual([
      { subscriptionId: subscription.id, group: "film-key", mode: "live" },
    ]);
    expect(app.button("Movies")?.disabled).toBe(true);
    await act(async () => save.resolve({ ...subscription, playlistMapped: true }));
    await app.settle();
    expect(app.client.getQueryData(["subscriptions"])).toEqual([
      { ...subscription, playlistMapped: true },
    ]);
    expect(app.button("Movies")?.disabled).toBe(false);
  });

  it("keeps full names, groups and reasons in bounded Settings pages", async () => {
    ipc.always("playlist.groups", groups);
    ipc.always("playlist.omissions", {
      total: 60,
      entries: [
        {
          name: "Full omitted title",
          groups: ["New group", "Films"],
          reason: "conflicting-groups",
        },
      ],
    });
    const app = await render(createElement(PlaylistRows, { subscription, onMap: () => {} }));
    expect(app.container.textContent).toContain("Left out60Show");
    await app.click("Show");
    expect(app.container.textContent).toContain("Full omitted title");
    expect(app.container.textContent).toContain(
      "New group · Films · Groups have different mappings",
    );
    await app.click("Next");
    expect(ipc.argsOf("playlist.omissions")).toEqual([
      { subscriptionId: subscription.id, offset: 0, limit: 50 },
      { subscriptionId: subscription.id, offset: 50, limit: 50 },
    ]);
  });
});
