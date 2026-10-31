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
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((done) => setTimeout(done, 10));
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
/** Recordings that start `seconds` before the programme asked for, as on the minute before. */
function earlier(seconds: number) {
  archiveStream.mockImplementation(async (id, window) => ({
    url: `archive:${id}:${window.start}`,
    format: "hls",
    start: window.start - seconds * 1000,
  }));
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
    expect(archiveStream).toHaveBeenCalledExactlyOnceWith(
      "11",
      { start: programme.start, end: programme.stop },
      expect.anything(),
    );
    expect(opened).toEqual([`archive:11:${programme.start}`]);
    expect(playback.playingItem(phase())).toMatchObject({
      id: channel.key,
      live: false,
      title: "Morning Tide",
      past: { start: programme.start, stop: programme.stop },
    });
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
      // A recording still being made opens where it is now, 15 minutes in.
      port.currentTime = 900;
      port.observation({ kind: "ready", durationSeconds: null });
      await tick();
    });
    expect(port.currentTime).toBe(0);
    await React.act(async () => {
      port.state(true);
      await tick();
    });
    expect(container.textContent).toContain("-1:00:00");
  });

  it("counts from the programme's start and stops at its end, where the recording runs wider", async () => {
    await connect([3, 3, 3]);
    // A recording that starts on the minute, 30 seconds before the programme.
    earlier(30);
    await play(aired(2 * HOUR));
    await React.act(async () => {
      port.duration = 2 * 3600;
      port.ready();
      await tick();
    });
    expect(port.currentTime).toBe(30);
    // Back from the programme's start stays at its start, short of the programme before.
    port.seekBy.mockImplementationOnce((seconds: number) => {
      port.currentTime += seconds;
    });
    playback.seekBy(-10);
    expect(port.currentTime).toBe(30);
    // The player marks no moment while it plays on: the end is timed from where it is.
    await React.act(async () => {
      port.currentTime = 30 + 3500;
      port.pause.mockClear();
      port.state(true);
      await tick();
    });
    expect(container.textContent).toContain("-1:40");
    await new Promise((done) => setTimeout(done, 100));
    expect(port.pause).not.toHaveBeenCalled();
    await React.act(async () => {
      port.currentTime = 30 + 3600 - 0.05;
      port.state(true);
      await tick();
    });
    await until(() => port.pause.mock.calls.length > 0);
  });

  it("starts the next stream at the programme's start when one fails before it plays", async () => {
    await connect([3, 3, 3]);
    // A recording that starts on the minute, 30 seconds before the programme.
    earlier(30);
    await play(aired(2 * HOUR));
    await React.act(async () => {
      port.ready();
      port.failure({ kind: "missing", evidence: null });
      await tick();
    });
    await until(() => opened.length === 2);
    port.currentTime = 0;
    await React.act(async () => {
      port.ready();
      await tick();
    });
    expect(port.currentTime).toBe(30);
  });

  it("plays Automatic's pick among the streams that keep it where the accepted one doesn't", async () => {
    await connect([null, 3, 3]);
    preferences.updateChannelPick(channel, "10");
    await play(aired(2 * HOUR));
    expect(archiveStream).toHaveBeenCalledExactlyOnceWith(
      "11",
      expect.anything(),
      expect.anything(),
    );
  });

  it("plays the accepted stream where it keeps the programme", async () => {
    await connect([null, 3, 3]);
    preferences.updateChannelPick(channel, "12");
    await play(aired(2 * HOUR));
    expect(archiveStream).toHaveBeenCalledExactlyOnceWith(
      "12",
      expect.anything(),
      expect.anything(),
    );
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
    },
  );

  it.each([900, 3605])("reconnects within the programme after reaching %i seconds", async (at) => {
    await connect([3, 3, 3]);
    earlier(30);
    const programme = aired(2 * HOUR);
    await play(programme);
    await React.act(async () => {
      port.ready();
      port.state(true);
      port.currentTime = 30 + at;
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
    expect(port.currentTime).toBe(30 + Math.min(at, (programme.stop - programme.start) / 1000));
  });

  it("stays the programme from catch-up across closing and returning to Watch", async () => {
    await connect([3, 3, 3]);
    const programme = aired(2 * HOUR);
    await play(programme);
    await React.act(async () => {
      port.ready();
      port.currentTime = 600;
      port.state(true);
      await tick();
    });
    await React.act(async () => {
      void playback.closeWatch();
      port.state(false);
      await tick();
    });
    await React.act(async () => {
      playback.openWatch();
      port.state(true);
      await tick();
    });
    expect(playback.playingItem(phase())).toMatchObject({
      live: false,
      past: { start: programme.start, stop: programme.stop },
    });
    expect(port.currentTime).toBe(600);
    expect(opened).toHaveLength(1);
    expect(liveStream).not.toHaveBeenCalled();
  });

  it("pauses nothing played after a programme whose end was near", async () => {
    await connect([3, 3, 3]);
    await play(aired(2 * HOUR));
    await React.act(async () => {
      port.ready();
      port.currentTime = 3600 - 0.2;
      port.state(true);
      await tick();
    });
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    port.pause.mockClear();
    await new Promise((done) => setTimeout(done, 400));
    expect(port.pause).not.toHaveBeenCalled();
    expect(playback.playingItem(phase())?.live).toBe(true);
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
