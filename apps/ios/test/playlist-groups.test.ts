import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { PlaylistMode } from "@mrstreamer/contracts/playlist";
import { afterEach, expect, it, vi } from "vitest";
import type { Member, PlaylistReport } from "../src/account.ts";
import type { PlaylistView } from "../src/playlist-groups.tsx";

// A playlist's groups from Settings: what it holds and each group's pick, a pick saved and shown
// once the playlist was read with it, a read that failed and is tried again, and what stays out a
// page at a time. The real screen runs with React DOM on a happy-dom window at an iPhone's width,
// as provider-form.test.ts does; reading and mapping the playlist answer as each test picks.

const scenario = vi.hoisted(() => ({
  reports: [] as (() => Promise<PlaylistReport>)[],
  mapped: [] as { args: readonly unknown[]; settle: () => void }[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  router: { push: () => undefined },
  useRootNavigationState: () => undefined,
}));
vi.mock("react-native", async () => (await import("./react-native.ts")).reactNative);
// The top bar's queue button, which header.tsx brings, has separate coverage.
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: [livingRoom] }),
  playlistReport: () => scenario.reports.shift()!(),
  mapPlaylist: (...args: unknown[]) =>
    new Promise<void>((settle) => scenario.mapped.push({ args, settle })),
}));

const livingRoom = vi.hoisted((): Member => ({
  entry: { id: "m3u-a", kind: "m3u", server: "https://tv.example.com", key: "k", name: null },
  label: "tv.example.com",
  account: null,
  needsSecret: false,
  live: { kind: "idle" },
  titles: { kind: "idle" },
}));

const { PlaylistScreen } = await import("../src/playlist-groups.tsx");

const report = (kids: PlaylistMode | null): PlaylistReport => ({
  status: {
    explicit: true,
    groups: 2,
    live: 1204,
    movies: 3410,
    series: 86,
    episodes: 2140,
    omitted: 60,
  },
  groups: [
    {
      group: "kids",
      name: "Kids",
      mode: kids,
      entries: 88,
      samples: [
        { name: "Bluey", groups: ["Kids", "Series | Drama"], reason: "conflicting-groups" },
      ],
    },
    { group: "news", name: "News", mode: "live", entries: 1, samples: [] },
  ],
  omissions: Array.from({ length: 60 }, (_, at) => ({
    name: `Entry ${at + 1}`,
    groups: ["Radio"],
    reason: "skip" as const,
  })),
});

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.reports.length = 0;
  scenario.mapped.length = 0;
});

async function mount(view: PlaylistView) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(PlaylistScreen, { id: "m3u-a", view })),
  );
  unmount = () => React.act(() => root.unmount());
  const button = (id: string) => container.querySelector(`[data-testid="${id}"]`)!;
  return {
    text: () => container.textContent,
    button,
    press: (id: string) =>
      React.act(async () => {
        button(id).dispatchEvent(new Event("click", { bubbles: true }));
      }),
    pressLabel: (label: string) =>
      React.act(async () => {
        [...container.querySelectorAll("button")]
          .find((each) => each.textContent === label)!
          .dispatchEvent(new Event("click", { bubbles: true }));
      }),
  };
}

it("shows what the playlist holds and each group's pick, never its link", async () => {
  scenario.reports.push(async () => report(null));
  const screen = await mount({ kind: "groups" });
  expect(screen.text()).toContain("1,204Channels");
  expect(screen.text()).toContain("Left out60");
  expect(screen.button("playlist-group-kids").getAttribute("aria-label")).toBe(
    "Kids, 88 entries, Needs mapping",
  );
  expect(screen.button("playlist-group-news").getAttribute("aria-label")).toBe(
    "News, 1 entry, Live TV",
  );
  expect(screen.text()).not.toContain("tv.example.com");
});

it("saves a pick, showing it once the playlist was read with it", async () => {
  scenario.reports.push(async () => report(null));
  const screen = await mount({ kind: "group", group: "kids" });
  expect(screen.text()).toContain("Groups have different mappings · also in Series | Drama");
  await screen.press("playlist-mode-movie");
  expect(scenario.mapped.map(({ args }) => args)).toEqual([["m3u-a", "kids", "movie"]]);
  expect(screen.text()).toContain("Saving");
  expect(screen.button("playlist-mode-live").hasAttribute("disabled")).toBe(true);
  scenario.reports.push(async () => report("movie"));
  await React.act(async () => scenario.mapped[0]!.settle());
  expect(screen.text()).not.toContain("Saving");
  expect(screen.button("playlist-mode-movie").getAttribute("aria-pressed")).toBe("true");
});

it("says the playlist couldn't be read, and reads it again on Try again", async () => {
  scenario.reports.push(async () => {
    throw new AppFailure({ kind: "provider-error", status: 503 });
  });
  const screen = await mount({ kind: "groups" });
  expect(screen.text()).toContain("Couldn't read the playlist");
  expect(screen.text()).toContain("Your provider didn't answer. Try again in a moment.");
  scenario.reports.push(async () => report(null));
  await screen.pressLabel("Try again");
  expect(screen.text()).toContain("Kids");
});

it("lists what stays out with why, a page at a time", async () => {
  scenario.reports.push(async () => report(null));
  const screen = await mount({ kind: "left-out" });
  expect(screen.text()).toContain("60 entries");
  expect(screen.text()).toContain("Entry 1Skipped by mapping · Radio");
  expect(screen.text()).not.toContain("Entry 51");
  await screen.press("playlist-show-more");
  expect(screen.text()).toContain("Entry 60");
  expect(screen.text()).not.toContain("Show more");
});
