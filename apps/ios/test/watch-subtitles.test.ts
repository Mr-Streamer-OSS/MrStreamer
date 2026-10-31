import { keychain as keychainStore } from "./keychain.ts";
import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

// Watch's Subtitles sheet and cue overlay for a movie, over the real playback, subtitle and
// preference owners. Only native views, sheets, files, the Keychain, the player and SubDL are
// stand-ins.
const port = nativePlayer();
const keychain = new Map<string, string>();
const sheets: Array<{
  title: string;
  message?: string;
  options: readonly string[];
  pick: (index: number) => void;
}> = [];
const alerts: string[][] = [];
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => keychainStore(() => keychain));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => port,
  VideoView: () => null,
  VideoAirPlayButton: () => null,
  isPictureInPictureSupported: () => false,
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      options: { title: string; message?: string; options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      sheets.push({ ...options, pick });
    },
  },
  Alert: {
    alert: (title: string, message: string) => {
      alerts.push([title, message]);
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
vi.mock("expo-router", () => ({ router: { push: () => undefined }, usePathname: () => "/films" }));
vi.mock("../src/header.tsx", () => ({
  useTabs: () => ({ tab: "films" }),
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

const playback = await import("../src/playback.ts");
const subtitles = await import("../src/downloaded-subtitles.ts");
const { saveSubtitleKey } = await import("../src/online-subtitles.ts");
const { WatchLayer } = await import("../src/watch.tsx");

const SRT = "1\n00:00:01,000 --> 00:00:04,000\nHello <i>there</i>\n";
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let unmount = () => {};
let container = document.createElement("div");

beforeEach(async () => {
  sheets.length = 0;
  alerts.length = 0;
  keychain.clear();
  port.currentTime = 0;
  port.tracks = null;
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(input);
    return url.hostname === "api.subdl.com"
      ? Response.json({
          status: true,
          results: [{ tmdb_id: 550, type: "movie" }],
          subtitles: [{ language: "EN", release_name: "Movie.2001", url: "/s/1.zip", hi: true }],
        })
      : new Response(zipSync({ "Movie.srt": strToU8(SRT) }));
  });
  container = document.createElement("div");
  const root = createRoot(container);
  unmount = () => React.act(() => root.unmount());
  React.act(() => root.render(React.createElement(WatchLayer)));
});
afterEach(async () => {
  unmount();
  vi.unstubAllGlobals();
  await playback.stop();
});

async function watchMovie() {
  const title = subtitles.subtitleTitle({
    subscriptionId: "sub-1",
    id: `m-${Math.random()}`,
    tmdbId: "550",
    title: "Movie",
    year: 2001,
  });
  await React.act(async () => {
    await playback.play(
      {
        id: "sub-1:m1",
        subscriptionId: "sub-1",
        title: "Movie",
        place: "2001",
        live: false,
        next: false,
        versions: false,
        subtitles: title,
      },
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "file:movie.mp4", container: "mp4" }),
      },
      { watch: true, login: [] },
    );
    port.state(true);
    await tick();
  });
  return title;
}
async function openSubtitles() {
  await React.act(async () => {
    container
      .querySelector('[data-testid="watch-subtitles"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));
    await tick();
  });
  return sheets.at(-1)!;
}
async function pick(sheet: (typeof sheets)[number], label: string) {
  const index = sheet.options.findIndex((row) => row.includes(label));
  expect(index).toBeGreaterThanOrEqual(0);
  await React.act(async () => {
    sheet.pick(index);
    await tick();
    await new Promise((done) => setTimeout(done, 20));
    await tick();
  });
}

describe("Watch's online subtitles", () => {
  it("finds, shows and draws a downloaded subtitle, saying Picture in Picture and AirPlay show none", async () => {
    await saveSubtitleKey("key");
    await watchMovie();
    const sheet = await openSubtitles();
    expect(sheet.options).toContain("Find online");
    expect(sheet.options).not.toContain("Adjust timing");
    await pick(sheet, "Find online");
    const results = sheets.at(-1)!;
    expect(results.title).toBe("Online subtitles");
    expect(results.options[0]).toBe("English · Hearing impaired · Movie.2001");
    expect(results.message).toContain("Picture in Picture and AirPlay show no subtitles");

    await pick(results, "Movie.2001");
    expect(container.textContent).not.toContain("Hello there");
    await React.act(async () => {
      port.currentTime = 2;
      port.state(true);
      await tick();
    });
    expect(container.textContent).toContain("Hello there");

    const again = await openSubtitles();
    expect(again.options).toContain("✓ English · Movie.2001");
    expect(again.options).toContain("Adjust timing");
    expect(again.message).toContain("Picture in Picture and AirPlay show no subtitles");
  });

  it("converts a shown subtitle's frame rate from Adjust timing", async () => {
    await saveSubtitleKey("key");
    await watchMovie();
    await pick(await openSubtitles(), "Find online");
    await pick(sheets.at(-1)!, "Movie.2001");
    await pick(await openSubtitles(), "Adjust timing");
    await pick(sheets.at(-1)!, "Frame rate");
    const rates = sheets.at(-1)!;
    expect(rates.message).toBe("Subtitle fps → video fps");
    expect(rates.options[0]).toBe("✓ Original");
    await pick(rates, "25 → 23.976 fps");
    expect(subtitles.shownSubtitle()?.timing.speed).toBeCloseTo(25 / (24000 / 1001));
    expect(sheets.at(-1)?.message).toBe("Frame rate 25 → 23.976 fps");
  });

  it("offers what a search found after the controls hid while it ran", async () => {
    await saveSubtitleKey("key");
    await watchMovie();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answer = fetch;
    vi.stubGlobal("fetch", async (input: URL | string) => {
      await held;
      return answer(input);
    });
    await pick(await openSubtitles(), "Find online");
    await React.act(async () => {
      container
        .querySelector('[aria-label="Hide controls"]')!
        .dispatchEvent(new Event("click", { bubbles: true }));
      await tick();
    });
    expect(container.querySelector('[data-testid="watch-subtitles"]')).toBeNull();
    await React.act(async () => {
      release();
      await new Promise((done) => setTimeout(done, 20));
      await tick();
    });
    expect(sheets.at(-1)?.title).toBe("Online subtitles");
  });

  it("points to Settings when no SubDL key is saved", async () => {
    await watchMovie();
    await pick(await openSubtitles(), "Find online");
    expect(alerts).toEqual([
      ["SubDL key needed", "Add your SubDL API key in Settings > Subtitles."],
    ]);
  });
});
