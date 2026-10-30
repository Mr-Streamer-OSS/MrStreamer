import { keychain as keychainStore } from "./keychain.ts";
import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";
import type { Provider } from "@mrstreamer/core/provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

// A programme from a channel's catch-up through the real account, playback and Watch: only the
// native player, files, secrets and the provider adapter are ports. It plays the channel's
// streams that keep it, from its start, with a length, and never stands in for the channel live.
const opened: string[] = [];
const port = nativePlayer((source) => {
  opened.push(source.uri);
});
let provider: Provider;
const keychain = new Map<string, string>();
// What the guide says is on now on any channel: the native guide is a port too.
let onNow: Programme | null = null;
vi.mock("../src/guide.ts", async (original) => {
  const actual = await original<typeof import("../src/guide.ts")>();
  const listings = async (keys: readonly string[]) =>
    new Map(keys.map((key) => [key, { now: onNow, next: null }]));
  return { ...actual, guide: { ...actual.guide, listings } };
});
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => keychainStore(() => keychain));
vi.mock("@mrstreamer/core/xtream", async () => ({
  ...(await vi.importActual<typeof import("@mrstreamer/core/xtream")>("@mrstreamer/core/xtream")),
  xtreamProvider: () => provider,
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => port,
  VideoView: () => null,
  VideoAirPlayButton: () => null,
  isPictureInPictureSupported: () => false,
}));
vi.mock("react-native", async () => (await import("./react-native.ts")).reactNative);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { LANDSCAPE: 1 },
  lockAsync: async () => undefined,
  unlockAsync: async () => undefined,
}));
vi.mock("expo-router", () => ({ router: { push: () => undefined }, usePathname: () => "/live" }));
vi.mock("../src/header.tsx", () => ({
  useTabs: () => ({ tab: "live" }),
  openOnTabs: () => undefined,
}));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({ testID, onPress }: { testID?: string; onPress: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }),
  };
});
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#8E8E93" } }));

const { native } = await import("./native-files.ts");
const account = await import("../src/account.ts");
const playback = await import("../src/playback.ts");
const preferences = await import("../src/media-preferences.ts");
const { demoProvider } = await import("../src/demo.ts");
const { WatchLayer } = await import("../src/watch.tsx");
const { programmeRange } = await import("../src/guide-ui.tsx");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let channel: import("../src/library.ts").Channel;
let liveStream: ReturnType<typeof vi.fn<Provider["liveStream"]>>;
let archiveStream: ReturnType<typeof vi.fn<Provider["archiveStream"]>>;
let container = document.createElement("div");
let unmount = () => {};
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((done) => setTimeout(done, 10));
  expect(ready()).toBe(true);
}
const phase = () => playback.playbackState.get().phase;
const fromStart = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("data-testid") === "watch-from-start",
  ) ?? null;

/** Connects a channel with FHD, HD and SD streams that keep `days` of catch-up each. */
async function connect(days: readonly (number | null)[]) {
  provider = {
    ...demoProvider(),
    liveStream,
    archiveStream,
    liveCatalogue: async () => ({
      categories: [{ id: "news", name: "NL | News" }],
      channels: ["FHD", "HD", "SD"].map((quality, i) => ({
        id: String(10 + i),
        name: `NL | News ${quality}`,
        number: null,
        logoUrl: null,
        categoryIds: ["news"],
        guideId: "news.nl",
        catchupDays: days[i] ?? null,
      })),
    }),
  };
  const id = await account.add({
    server: "http://catchup.example",
    username: "fixture",
    password: "fixture-pass",
  });
  if (!id) throw new Error("No saved account");
  await until(() => {
    const now = account.currentCatalogue();
    return now.kind === "ready" && now.library.byKey.has(`${id}:10`);
  });
  const now = account.currentCatalogue();
  const found = now.kind === "ready" ? now.library.byKey.get(`${id}:10`) : undefined;
  if (!found) throw new Error("No channel");
  channel = found;
  preferences.updateMediaPreferences("liveQuality", "fhd");
  preferences.updateChannelPick(channel, null);
}
/** A programme that started `ago` and lasts an hour. */
const aired = (ago: number) => ({
  title: "Morning Tide",
  start: Date.now() - ago,
  stop: Date.now() - ago + HOUR,
});
async function play(programme: { title: string; start: number; stop: number }) {
  await React.act(async () => {
    account.playChannel(channel, "News", { watch: true, programme });
    await tick();
  });
}

beforeAll(async () => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  mkdirSync(join(native.root, "documents"));
  await account.restore();
});
beforeEach(() => {
  liveStream = vi.fn(async (id: string) => ({ url: `live:${id}`, format: "hls" as const }));
  archiveStream = vi.fn(async (id: string, window: ArchiveWindow) => ({
    url: `archive:${id}:${window.start}`,
    format: "hls" as const,
    start: window.start,
  }));
  opened.length = 0;
  onNow = null;
  port.currentTime = 0;
  port.duration = 600;
  container = document.createElement("div");
  const root = createRoot(container);
  unmount = () => React.act(() => root.unmount());
  React.act(() => root.render(React.createElement(WatchLayer)));
});
afterEach(async () => {
  unmount();
  await playback.stop();
  await tick();
  await account.remove(channel.subscriptionId, { keepHistory: true });
});

describe("a programme from catch-up", () => {
  it("plays from its start from the streams that keep it, with a length and never live", async () => {
    await connect([null, 3, 3]);
    const programme = aired(2 * HOUR);
    await play(programme);
    expect(liveStream).not.toHaveBeenCalled();
    expect(archiveStream.mock.calls.map(([id, window]) => [id, window])).toEqual([
      ["11", { start: programme.start, end: programme.stop }],
    ]);
    expect(opened).toEqual([`archive:11:${programme.start}`]);
    const item = playback.playingItem(phase());
    expect(item).toMatchObject({ id: channel.key, live: false, title: "Morning Tide" });
    expect(item?.past).toEqual({ start: programme.start, stop: programme.stop });
    await React.act(async () => {
      port.duration = 3600;
      port.ready();
      port.state(true);
      await tick();
    });
    expect(playback.channelStatus(phase())).toBeNull();
    expect(playback.liveStream()).toBeNull();
    expect(container.textContent).toContain("-1:00:00");
    expect(container.textContent).not.toContain("Live");
    expect(container.textContent).toContain(`${channel.title} · Catch-up · `);
    expect(container.textContent).toContain(programmeRange(programme));
  });

  it("starts a programme still on over, as long as the programme, while it records", async () => {
    await connect([3, 3, 3]);
    const programme = aired(HOUR / 4);
    await play(programme);
    expect(archiveStream).toHaveBeenCalledWith(
      "10",
      { start: programme.start, end: programme.stop },
      expect.anything(),
    );
    await React.act(async () => {
      port.observation({ kind: "ready", durationSeconds: null });
      port.state(true);
      await tick();
    });
    expect(container.textContent).toContain("-1:00:00");
  });

  it("stops at the programme's end where the archive sends on past it", async () => {
    await connect([3, 3, 3]);
    await play(aired(2 * HOUR));
    await React.act(async () => {
      port.observation({ kind: "ready", durationSeconds: null });
      port.currentTime = 3599;
      port.pause.mockClear();
      port.state(true);
      await tick();
    });
    expect(port.pause).not.toHaveBeenCalled();
    await React.act(async () => {
      port.currentTime = 3600;
      port.state(true);
      await tick();
    });
    expect(port.pause).toHaveBeenCalled();
  });

  it.each([
    { days: [1, 1, null], ago: 2 * DAY, error: "Catch-up on this channel goes back 1 day." },
    { days: [null, null, null], ago: 2 * HOUR, error: "This channel has no catch-up." },
  ])(
    "says why it can't play one the archive doesn't keep: $error",
    async ({ days, ago, error }) => {
      await connect(days);
      await play(aired(ago));
      expect(phase()).toMatchObject({ kind: "failed", error });
      expect(container.textContent).toContain(error);
      expect(liveStream).not.toHaveBeenCalled();
      expect(archiveStream).not.toHaveBeenCalled();
      expect(opened).toEqual([]);
    },
  );

  it("reconnects where it got to rather than from its start", async () => {
    await connect([3, 3, 3]);
    await play(aired(2 * HOUR));
    await React.act(async () => {
      port.ready();
      port.state(true);
      port.currentTime = 900;
      port.state(true);
      port.failure({ kind: "network", evidence: null });
      await tick();
    });
    await until(() => opened.length === 2);
    port.currentTime = 0;
    await React.act(async () => {
      port.ready();
      await tick();
    });
    expect(port.currentTime).toBe(900);
  });

  it("starts the programme on now over from a live channel whose catch-up keeps it", async () => {
    await connect([3, 3, 3]);
    onNow = { ...aired(HOUR / 4), description: null };
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => fromStart() !== null);
    expect(fromStart()?.getAttribute("aria-label")).toBe("Play Morning Tide from start");
    await React.act(async () => {
      fromStart()?.click();
      await tick();
    });
    expect(playback.playingItem(phase())).toMatchObject({
      live: false,
      past: { start: onNow.start, stop: onNow.stop },
    });
    expect(opened.at(-1)).toBe(`archive:10:${onNow.start}`);
  });

  it("offers no start over on a live channel without catch-up", async () => {
    await connect([null, null, null]);
    onNow = { ...aired(HOUR / 4), description: null };
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => opened.length === 1);
    await React.act(tick);
    expect(fromStart()).toBeNull();
  });
});
