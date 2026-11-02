import "./native-assets.ts";
import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Member, PlaylistReport } from "../src/account.ts";
import { keychain } from "./keychain.ts";

// A playlist in Settings: its row says it is one, never its link, with how many groups wait for
// a pick, and its sheet offers its groups and one reload for both its lists. The real Settings
// run with React DOM on a happy-dom window, as settings-removal.test.ts does.

Object.assign(globalThis, { __DEV__: false });

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  sheet: null as { options: readonly string[]; pick: (index: number) => void } | null,
  reloaded: [] as string[],
  pushed: [] as unknown[],
  /** How many times a row read its playlist's report. */
  reported: 0,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-secure-store", () => keychain(() => new Map()));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      scenario.sheet = { options, pick };
    },
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("expo-router", () => ({
  router: { push: (to: unknown) => scenario.pushed.push(to) },
  useRootNavigationState: () => ({ index: 0, routes: [{ name: "(tabs)" }] }),
  useNavigation: () => ({ setOptions: () => undefined }),
}));
vi.mock("expo-video", () => ({ isPictureInPictureSupported: () => true }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/ui.tsx", () => ({
  colors: { text: "#FFFFFF", dim: "#8E8E93", line: "#38383A" },
  ChannelLogo: () => null,
  TextButton: () => null,
}));
vi.mock("../src/titles.ts", () => ({
  useMetadataStanding: () => ({ kind: "no-key" }),
  useTitleTimings: () => null,
}));
vi.mock("../src/telemetry/index.ts", () => ({
  useStatistics: () => ({ enabled: false, transport: "production" }),
  setStatistics: async () => undefined,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  reloadChannels: (id: string) => scenario.reloaded.push(`channels ${id}`),
  reloadTitles: (id: string) => scenario.reloaded.push(`titles ${id}`),
  playlistReport: async (): Promise<Partial<PlaylistReport>> => {
    scenario.reported++;
    return {
      groups: [
        { group: "a", name: "Kids", mode: null, entries: 2, samples: [] },
        { group: "b", name: "News", mode: "live", entries: 4, samples: [] },
        { group: "c", name: "Radio", mode: null, entries: 1, samples: [] },
      ],
    };
  },
}));

const { default: Settings } = await import("../src/app/(tabs)/(home)/settings.tsx");

const livingRoom: Member = {
  entry: {
    id: "m3u-a",
    kind: "m3u",
    server: "https://tv.example.com",
    key: "k",
    name: "Living room",
    // Mapped once: until then every group is Live, and none waits.
    mapping: { version: 1, groups: [] },
  },
  label: "Living room",
  account: { state: "active", expiresAt: null, maxConnections: null, activeConnections: null },
  needsSecret: false,
  live: {
    kind: "ready",
    value: { channels: [], categories: [] } as never,
    from: "provider",
    fetchedAt: 1,
    took: 1,
  },
  titles: { kind: "idle" },
};

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.sheet = null;
  scenario.reloaded.length = 0;
  scenario.pushed.length = 0;
  scenario.reported = 0;
});

async function open(member = livingRoom) {
  scenario.members = [member];
  const container = document.createElement("div");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Settings)));
  unmount = () => React.act(() => root.unmount());
  const row = container.querySelector('[data-testid="settings-provider-m3u-a"]')!;
  return {
    line: () => row.getAttribute("aria-label"),
    press: () => React.act(() => row.dispatchEvent(new Event("click", { bubbles: true }))),
  };
}

it("names a playlist as one, with the groups that need mapping, never its link", async () => {
  const settings = await open();
  expect(settings.line()).toBe("Living room, M3U playlist · 2 groups need mapping");
});

it("reads no unmapped playlist for its row, where every group is Live", async () => {
  const { mapping: _, ...unmapped } = livingRoom.entry as Extract<Member["entry"], { kind: "m3u" }>;
  const settings = await open({ ...livingRoom, entry: unmapped });
  expect(settings.line()).toBe("Living room, M3U playlist");
  expect(scenario.reported).toBe(0);
});

it("offers its groups and one reload that reads both its lists again", async () => {
  const settings = await open();
  settings.press();
  const sheet = scenario.sheet!;
  expect(sheet.options).toEqual(["Playlist groups", "Reload playlist", "Edit", "Remove", "Cancel"]);
  React.act(() => sheet.pick(sheet.options.indexOf("Reload playlist")));
  expect(scenario.reloaded).toEqual(["channels m3u-a", "titles m3u-a"]);
  React.act(() => sheet.pick(sheet.options.indexOf("Playlist groups")));
  expect(scenario.pushed).toEqual([{ pathname: "/playlist", params: { id: "m3u-a" } }]);
});
