import { keychain as keychainStore } from "./keychain.ts";
import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";
import type { Provider } from "@mrstreamer/core/provider";
import type { ObservedTrackSnapshot } from "expo-video";
import { finish } from "@mrstreamer/core/steps";
import { partSteps } from "../src/library.ts";
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
let listingGate: Promise<void> | null = null;
let listingReads = 0;
vi.mock("../src/guide.ts", async (original) => {
  const actual = await original<typeof import("../src/guide.ts")>();
  const listings = async (keys: readonly string[]) => {
    listingReads++;
    if (listingGate) await listingGate;
    return new Map(keys.map((key) => [key, { now: onNow, next: null }]));
  };
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
// Watch's system sheets, kept to read and pick from.
const sheets: Array<{
  title?: string;
  message?: string;
  options: readonly string[];
  pick: (index: number) => void;
}> = [];
// What VoiceOver was told, in order.
const announced: string[] = [];
// Who listens for the app leaving the foreground.
const appState = vi.hoisted(() => new Set<(state: string) => void>());
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  AppState: {
    currentState: "active",
    addEventListener: (_: "change", listener: (state: string) => void) => {
      appState.add(listener);
      return { remove: () => appState.delete(listener) };
    },
  },
  AccessibilityInfo: {
    ...(await import("./react-native.ts")).reactNative.AccessibilityInfo,
    announceForAccessibility: (text: string) => announced.push(text),
    sendAccessibilityEvent: () => undefined,
  },
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      options: { title?: string; message?: string; options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      sheets.push({ ...options, pick });
    },
  },
}));
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
// The native format module: each session serves its playlist at once, naming `unshown` as the
// subtitle tracks it can't carry, and closes when asked.
type Unshown = { language: string | null; format: string | null; forced: boolean };
let unshown: { named: Unshown[]; more: number } = { named: [], more: 0 };
const closeSession = new Map<string, () => void>();
// The keyboard's shortcuts Watch offers, pressed by their key.
const keys = { offered: [] as { id: string; input: string }[], press: (_id: string) => {} };
Object.assign(globalThis, {
  expo: {
    modules: {
      KeyCommands: {
        set: (shortcuts: { id: string; input: string }[]) => {
          keys.offered = shortcuts;
        },
        addListener: (_event: "command", listener: (event: { id: string }) => void) => {
          keys.press = (id) => listener({ id });
          return { remove: () => (keys.press = () => {}) };
        },
      },
      TitleFormats: {
        create: () => undefined,
        open: async (id: string) => ({
          kind: "session",
          playlist: `http://127.0.0.1:1/${id}/main.m3u8`,
          unshown,
        }),
        close: (id: string) => closeSession.get(id)?.(),
        closed: (id: string) => new Promise<void>((done) => closeSession.set(id, done)),
        failure: () => null,
        trace: () => [],
        addListener: () => ({ remove: () => undefined }),
      },
    },
  },
});

const { native } = await import("./native-files.ts");
const account = await import("../src/account.ts");
const playback = await import("../src/playback.ts");
const preferences = await import("../src/media-preferences.ts");
const sources = await import("../src/sources.ts");
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
  for (let i = 0; i < 500 && !ready(); i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
    else await new Promise((done) => setTimeout(done, 10));
  }
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
      channels: [
        ...["FHD", "HD", "SD"].map((quality, i) => ({
          id: String(10 + i),
          name: `NL | News ${quality}`,
          number: null,
          logoUrl: null,
          categoryIds: ["news"],
          guideId: "news.nl",
          catchupDays: days[i] ?? null,
        })),
        // Another channel, beside News.
        {
          id: "20",
          name: "NL | Weather",
          number: null,
          logoUrl: null,
          categoryIds: ["news"],
          guideId: "weather.nl",
          catchupDays: null,
        },
      ],
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
  sheets.length = 0;
  unshown = { named: [], more: 0 };
  port.tracks = null;
  onNow = null;
  listingGate = null;
  listingReads = 0;
  port.currentTime = 0;
  port.duration = 600;
  container = document.createElement("div");
  const root = createRoot(container);
  unmount = () => React.act(() => root.unmount());
  React.act(() => root.render(React.createElement(WatchLayer)));
});
afterEach(async () => {
  vi.useRealTimers();
  unmount();
  await playback.stop();
  await tick();
  // Cases that play no channel connect none.
  if (channel) await account.remove(channel.subscriptionId, { keepHistory: true });
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

  it("reads Watch's guide only while the app is in the foreground", async () => {
    await connect([3, 3, 3]);
    onNow = { ...aired(HOUR / 4), description: null, title: "Before background" };
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => fromStart() !== null);
    const { guide } = await import("../src/guide.ts");
    const held = Promise.withResolvers<void>();
    listingGate = held.promise;
    const before = listingReads;
    try {
      await React.act(async () => {
        guide.background();
        await tick();
      });
      expect(listingReads).toBe(before);
      expect(fromStart()).toBeNull();
      onNow = { ...aired(HOUR / 60), description: null, title: "After foreground" };
      await React.act(async () => {
        guide.configure(new Map(), new Map());
        await tick();
      });
      expect(listingReads).toBe(before);
      await React.act(async () => {
        guide.foreground();
        await tick();
      });
      await until(() => listingReads > before);
      expect(fromStart()).toBeNull();
      await React.act(async () => {
        listingGate = null;
        held.resolve();
        await tick();
      });
      await until(
        () => fromStart()?.getAttribute("aria-label") === "Play After foreground from start",
      );
    } finally {
      await React.act(async () => {
        listingGate = null;
        held.resolve();
        guide.foreground();
        await tick();
      });
    }
  });

  it("keeps an unchanged start-over action mounted while guide status is read again", async () => {
    await connect([3, 3, 3]);
    onNow = { ...aired(HOUR / 4), description: null };
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => fromStart() !== null);
    const button = fromStart();
    const { guide } = await import("../src/guide.ts");
    const held = Promise.withResolvers<void>();
    listingGate = held.promise;
    const before = listingReads;
    const refreshing = Promise.withResolvers<void>();
    const request = vi.spyOn(provider, "liveGuideRequest").mockImplementation(async () => {
      await refreshing.promise;
      return { kind: "none" };
    });
    try {
      await React.act(async () => {
        // Foreground repeats the status/minute read without changing the guide contents.
        guide.foreground();
        await tick();
      });
      await until(() => listingReads > before);
      expect(fromStart()).toBe(button);
    } finally {
      await React.act(async () => {
        listingGate = null;
        held.resolve();
        refreshing.resolve();
        await guide.refresh(channel.subscriptionId);
        await tick();
      });
      request.mockRestore();
    }
  });

  it.each(["guide change", "catalogue change", "programme end"])(
    "hides the old start-over action after a %s",
    async (change) => {
      await connect([3, 3, 3]);
      if (change === "programme end")
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      onNow = { ...aired(HOUR / 4), description: null, title: "Previous bulletin" };
      if (change === "programme end") onNow = { ...onNow, stop: Date.now() + 1000 };
      await React.act(async () => {
        account.playChannel(channel, "News", { watch: true });
        await tick();
      });
      await until(() => fromStart() !== null);
      expect(fromStart()?.getAttribute("aria-label")).toBe("Play Previous bulletin from start");
      const { guide } = await import("../src/guide.ts");
      const held = Promise.withResolvers<void>();
      listingGate = held.promise;
      const before = listingReads;
      const next = { ...aired(HOUR / 60), description: null, title: "Updated bulletin" };
      onNow = next;
      try {
        await React.act(async () => {
          if (change === "guide change") guide.configure(new Map(), new Map());
          else if (change === "catalogue change")
            guide.setPart(
              finish(
                partSteps({
                  subscriptionId: channel.subscriptionId,
                  catalogue: await provider.liveCatalogue(),
                }),
              ),
            );
          else await vi.advanceTimersByTimeAsync(1000);
          await tick();
        });
        expect(fromStart()).toBeNull();
        await until(() => listingReads > before);
        await React.act(async () => {
          listingGate = null;
          held.resolve();
          await tick();
        });
        await until(() => fromStart() !== null);
        expect(fromStart()?.getAttribute("aria-label")).toBe("Play Updated bulletin from start");
        await React.act(async () => {
          fromStart()?.click();
          await tick();
        });
        expect(archiveStream).toHaveBeenCalledWith(
          "10",
          { start: next.start, end: next.stop },
          expect.anything(),
        );
      } finally {
        await React.act(async () => {
          listingGate = null;
          held.resolve();
          await tick();
        });
        if (change === "programme end") vi.useRealTimers();
      }
    },
  );

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

describe("sound and subtitles in Watch", () => {
  const button = (id: string) =>
    [...container.querySelectorAll("button")].find(
      (each) => each.getAttribute("data-testid") === id,
    ) ?? null;
  /**
   * What the stream playing offers, as the native player reads it for this attempt: the main
   * sound, selected, and an audio description, under the native ids `ids` names.
   */
  function offer(
    groups: Partial<Pick<ObservedTrackSnapshot, "audio" | "subtitles">> = {},
    ids = { main: "main", description: "ad" },
  ) {
    const identity = port.identity();
    const track = { ...identity, revision: 1, isPlayable: true };
    port.tracks = {
      ...identity,
      revision: 1,
      audio: {
        state: "ready",
        options: [
          {
            ...track,
            id: ids.main,
            group: "audio",
            language: "en",
            label: "English",
            name: "Main",
            isDefault: true,
          },
          {
            ...track,
            id: ids.description,
            group: "audio",
            language: "en",
            label: "English",
            name: "Audio description",
            isDefault: false,
          },
        ],
      },
      subtitles: {
        state: "ready",
        options: [
          {
            ...track,
            id: "nl",
            group: "subtitles",
            language: "nl",
            label: "Dutch",
            isDefault: false,
            forcedOnly: false,
          },
        ],
      },
      subtitleOffAllowed: true,
      selectedAudioId: ids.main,
      selectedSubtitleId: null,
      ...groups,
    };
  }
  async function open(id: "watch-audio" | "watch-subtitles") {
    const before = sheets.length;
    await React.act(async () => {
      button(id)?.click();
      await tick();
    });
    await until(() => sheets.length > before);
    return sheets.at(-1)!;
  }
  async function watchLive(days: number | null = null) {
    await connect([days, days, days]);
    port.selectObservedTrackAsync.mockImplementation(async (_expected, _revision, choice) => {
      if (port.tracks)
        port.tracks =
          choice.kind === "audio"
            ? { ...port.tracks, selectedAudioId: choice.track.id }
            : { ...port.tracks, selectedSubtitleId: choice.track?.id ?? null };
      return { kind: "requested" };
    });
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => opened.length === 1);
  }
  afterEach(() => {
    // Watch holds the keyboard while a sheet shows, past its unmount, until the sheet answers.
    for (const sheet of sheets) sheet.pick(sheet.options.length - 1);
    port.selectObservedTrackAsync.mockReset();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
  });

  it("picks the exact native track and keeps it on the stream a Quality change plays", async () => {
    await watchLive();
    offer();
    const audio = await open("watch-audio");
    expect(audio.title).toBe("Audio");
    expect(audio.options).toEqual(["✓ English · Main", "English · Audio description", "Cancel"]);
    await React.act(async () => {
      audio.pick(1);
      await tick();
    });
    expect(port.selectObservedTrackAsync).toHaveBeenLastCalledWith(
      expect.objectContaining(port.identity()),
      1,
      expect.objectContaining({ kind: "audio", track: expect.objectContaining({ id: "ad" }) }),
    );
    expect((await open("watch-audio")).options[1]).toBe("✓ English · Audio description");
    const subtitles = await open("watch-subtitles");
    expect(subtitles.options).toEqual(["✓ Off", "Dutch", "Cancel"]);

    await React.act(async () => {
      account.chooseChannelQuality(channel, "News", "11");
      await tick();
    });
    await until(() => opened.length === 2);
    expect(opened[1]).toBe("live:11");
    port.selectObservedTrackAsync.mockClear();
    // The new stream lists the same sounds under each other's native ids.
    offer({}, { main: "ad", description: "main" });
    await React.act(async () => {
      port.ready();
      await tick();
    });
    await until(() => port.selectObservedTrackAsync.mock.calls.length > 0);
    expect(port.selectObservedTrackAsync).toHaveBeenLastCalledWith(
      expect.objectContaining(port.identity()),
      1,
      expect.objectContaining({
        kind: "audio",
        track: expect.objectContaining({ id: "main", name: "Audio description" }),
      }),
    );
  });

  it("keeps a channel's pick out of its programme from catch-up", async () => {
    onNow = { ...aired(HOUR / 4), description: null };
    await watchLive(3);
    offer();
    const audio = await open("watch-audio");
    await React.act(async () => {
      audio.pick(1);
      await tick();
    });
    expect((await open("watch-audio")).options[1]).toBe("✓ English · Audio description");
    await until(() => fromStart() !== null);
    port.selectObservedTrackAsync.mockClear();
    await React.act(async () => {
      fromStart()?.click();
      await tick();
    });
    await until(() => opened.length === 2);
    offer();
    await React.act(async () => {
      port.ready();
      await tick();
    });
    expect((await open("watch-audio")).options[0]).toBe("✓ English · Main");
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });

  it("starts a replay with no picks once the channel's login changed", async () => {
    await watchLive();
    offer();
    const audio = await open("watch-audio");
    await React.act(async () => {
      audio.pick(1);
      await tick();
    });
    expect((await open("watch-audio")).options[1]).toBe("✓ English · Audio description");
    // Watch closed, the stream fails for good; its login is then entered again.
    await React.act(async () => {
      await playback.closeWatch();
      port.failure({ kind: "network", evidence: null });
      await tick();
    });
    expect(phase().kind).toBe("failed");
    await React.act(async () => {
      const source = sources.sourceOf(channel.subscriptionId);
      sources.setSource(channel.subscriptionId, { ...source, revision: source.revision + 1 });
      await tick();
    });
    port.selectObservedTrackAsync.mockClear();
    await React.act(async () => {
      account.playChannel(channel, "News", { watch: true });
      await tick();
    });
    await until(() => opened.length === 2);
    offer();
    await React.act(async () => {
      port.ready();
      await tick();
    });
    expect((await open("watch-audio")).options).toEqual([
      "✓ English · Main",
      "English · Audio description",
      "Cancel",
    ]);
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });

  it("says tracks aren't known yet while loading, and no choices where the stream has none", async () => {
    await watchLive();
    offer({
      audio: { state: "loading", options: [] },
      subtitles: { state: "absent", options: [] },
    });
    const audio = await open("watch-audio");
    expect(audio.options).toEqual(["Cancel"]);
    expect(audio.message).toBe("Not known yet. Try again in a moment.");
    const subtitles = await open("watch-subtitles");
    expect(subtitles.options).toEqual(["Cancel"]);
    expect(subtitles.message).toBe("No choices on this channel.");
  });

  it("names a file's subtitles it can't show, by language and format, beside those it can", async () => {
    await connect([null, null, null]);
    // Past the tracks the session names, it counts the rest.
    unshown = {
      named: [
        { language: "eng", format: "PGS", forced: false },
        { language: "nld", format: "DVD", forced: true },
        { language: null, format: null, forced: false },
      ],
      more: 2,
    };
    const film = {
      id: "film",
      subscriptionId: null,
      title: "Film",
      place: "",
      live: false,
      next: false,
      versions: false,
    };
    const file = { url: "http://panel/film.mkv", container: "mkv" as const };
    await React.act(async () => {
      playback.play(
        film,
        { kind: "file", originalLanguage: null, open: async () => file },
        { watch: true, login: [] },
      );
      await tick();
    });
    await until(() => opened.length === 1);
    offer();
    const cantShow =
      "Can't show here: English (PGS), Dutch (DVD, forced), Unknown language (unknown format) and 2 more.";
    const subtitles = await open("watch-subtitles");
    expect(subtitles.options).toEqual(["✓ Off", "Dutch", "Cancel"]);
    expect(subtitles.message).toBe(cantShow);
    offer({ subtitles: { state: "absent", options: [] } });
    const none = await open("watch-subtitles");
    expect(none.options).toEqual(["Cancel"]);
    expect(none.message).toBe(cantShow);
  });

  it("says tracks aren't known yet when their read fails or the group is unavailable", async () => {
    await watchLive();
    offer({ subtitles: { state: "unavailable", options: [] } });
    const subtitles = await open("watch-subtitles");
    expect(subtitles.options).toEqual(["Cancel"]);
    expect(subtitles.message).toBe("Not known yet. Try again in a moment.");
    port.getObservedTracksAsync.mockRejectedValueOnce(new Error("Read failed"));
    const audio = await open("watch-audio");
    expect(audio.options).toEqual(["Cancel"]);
    expect(audio.message).toBe("Not known yet. Try again in a moment.");
    expect((await open("watch-audio")).options[0]).toBe("✓ English · Main");
  });

  it("keeps a channel's pick out of another channel", async () => {
    await watchLive();
    offer();
    const audio = await open("watch-audio");
    await React.act(async () => {
      audio.pick(1);
      await tick();
    });
    expect((await open("watch-audio")).options[1]).toBe("✓ English · Audio description");
    const now = account.currentCatalogue();
    const weather =
      now.kind === "ready" ? now.library.byKey.get(`${channel.subscriptionId}:20`) : undefined;
    if (!weather) throw new Error("No second channel");
    port.selectObservedTrackAsync.mockClear();
    await React.act(async () => {
      account.playChannel(weather, "News", { watch: true });
      await tick();
    });
    await until(() => opened.length === 2);
    expect(opened[1]).toBe("live:20");
    offer();
    await React.act(async () => {
      port.ready();
      await tick();
    });
    expect((await open("watch-audio")).options[0]).toBe("✓ English · Main");
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });

  it("asks nothing of a newer attempt for a sheet the stream outlived", async () => {
    await watchLive();
    offer();
    const audio = await open("watch-audio");
    await React.act(async () => {
      port.failure({ kind: "network", evidence: null });
      await tick();
    });
    await until(() => opened.length === 2);
    offer();
    await React.act(async () => {
      port.ready();
      await tick();
    });
    port.selectObservedTrackAsync.mockClear();
    port.getObservedTracksAsync.mockClear();
    await React.act(async () => {
      audio.pick(1);
      await tick();
    });
    expect(port.getObservedTracksAsync).not.toHaveBeenCalled();
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ track: expect.objectContaining({ id: "ad" }) }),
    );
  });
});

describe("an episode's end in Watch", () => {
  /** What the countdown or Next episode played. */
  const played: string[] = [];
  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const press = (id: string) =>
    React.act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("data-testid") === id)
        ?.click();
      await tick();
    });
  const key = (input: string) =>
    React.act(async () => {
      const shortcut = keys.offered.find((each) => each.input === input);
      if (!shortcut) throw new Error(`No ${input} offered`);
      keys.press(shortcut.id);
      await tick();
    });
  const seconds = (ms: number) =>
    React.act(async () => {
      vi.advanceTimersByTime(ms);
      await tick();
    });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    played.length = 0;
    announced.length = 0;
  });

  /** S1 E2 plays in Watch to its end, and S1 E3 goes on after it. */
  async function ends() {
    await React.act(async () => {
      await playback.play(
        {
          id: "sub-1:e2",
          subscriptionId: null,
          title: "Harbour Lights",
          place: "S1 E2 · The Quiet Ferry",
          live: false,
          next: true,
          versions: false,
        },
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "file:e2.mp4", container: "mp4" }),
        },
        {
          watch: true,
          login: [],
          next: () => played.push("Next episode"),
          upNext: async () => ({
            place: "S1 E3 · The Long Table",
            play: () => played.push("S1 E3"),
          }),
        },
      );
      port.ready();
      port.state(true);
      port.currentTime = 600;
      port.observation({ kind: "ended" });
      port.state(false);
      await tick();
    });
    await until(() => byTestId("watch-up-next") !== null);
  }

  it("counts down in the text-button row, told to VoiceOver once, and plays on Play next", async () => {
    await ends();
    const row = byTestId("watch-up-next")!;
    expect(row.textContent).toBe("S1 E3 · The Long TablePlays in 10Play nextCancel");
    expect(byTestId("watch-next")).toBeNull();
    await seconds(3000);
    expect(row.textContent).toContain("Plays in 7");
    expect(announced).toEqual(["Next episode, S1 E3, The Long Table, plays in 10 seconds."]);
    await press("watch-play-next");
    expect(played).toEqual(["S1 E3"]);
  });

  it("returns today's row on Cancel, where Next episode still plays the next", async () => {
    await ends();
    await press("watch-up-next-cancel");
    expect(byTestId("watch-up-next")).toBeNull();
    await seconds(20_000);
    expect(played).toEqual([]);
    await press("watch-next");
    expect(played).toEqual(["Next episode"]);
  });

  it("cancels on Space without playing, and Escape closes Watch with nothing next", async () => {
    await ends();
    port.play.mockClear();
    await key(" ");
    expect(byTestId("watch-up-next")).toBeNull();
    expect(byTestId("watch-next")).not.toBeNull();
    expect(port.play).not.toHaveBeenCalled();

    await ends();
    await key("escape");
    await seconds(20_000);
    expect(playback.playbackState.get().watch).toBe(false);
    expect(played).toEqual([]);
  });

  it("ends the countdown when the app leaves the foreground", async () => {
    await ends();
    await React.act(async () => {
      for (const listener of appState) listener("background");
      await tick();
    });
    await seconds(20_000);
    expect(played).toEqual([]);
  });

  it("ends the countdown when a tap on the picture hides the panel", async () => {
    await ends();
    await React.act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Hide controls")!
        .click();
      await tick();
    });
    await seconds(20_000);
    expect(played).toEqual([]);
  });
});
