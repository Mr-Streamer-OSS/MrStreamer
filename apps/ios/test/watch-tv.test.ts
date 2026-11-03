import { createRoot, window } from "./dom.ts";
import { nativePlayer } from "./native-player.ts";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playing } from "../src/playback.ts";
import { keychain } from "./keychain.ts";

// Watch's Play on TV button and sheet, as the viewer uses them: the real Watch layer, playback
// and Cast sender run with React DOM on a happy-dom window. The native Cast module is a stand-in
// that says what the browse found; connecting to a TV fails, as an unreachable one does. Playing
// on a TV and the protocol are cast.test.ts's.

const native = vi.hoisted(() => ({
  /** What the stand-in Cast module was asked, in order. */
  events: [] as string[],
  /** The system alerts shown, by title. */
  alerts: [] as string[],
  /** Times Settings was opened. */
  settings: 0,
  listeners: new Map<string, (event: never) => void>(),
}));

Object.assign(globalThis, {
  expo: {
    modules: {
      Cast: {
        browse: () => native.events.push("browse"),
        stopBrowsing: () => native.events.push("stop browsing"),
        connect: async () => {
          native.events.push("connect");
          throw new Error("No route to host");
        },
        disconnect: () => undefined,
        addListener: (event: string, listener: (event: never) => void) => {
          native.listeners.set(event, listener);
          return { remove: () => native.listeners.delete(event) };
        },
      },
    },
  },
});

vi.mock("../src/downloads.ts", () => ({
  useDownloads: () => ({ items: [], series: {}, bytes: 0, free: null, ended: 0 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-video", () => ({
  VideoView: () => null,
  VideoAirPlayButton: () => null,
  isPictureInPictureSupported: () => false,
  createVideoPlayer: () => nativePlayer(),
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Alert: { alert: (title: string) => void native.alerts.push(title) },
  Linking: { openSettings: async () => void native.settings++ },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { LANDSCAPE: 1 },
  lockAsync: async () => undefined,
  unlockAsync: async () => undefined,
}));
vi.mock("expo-router", () => ({
  router: { push: () => undefined },
  useRootNavigationState: () => ({ index: 0, routes: [] }),
  usePathname: () => "/films",
}));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  type Props = { testID?: string; label: string; onPress: () => void };
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({ testID, label, onPress }: Props) =>
      createElement("button", { "data-testid": testID, "aria-label": label, onClick: onPress }),
  };
});
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#A1A1A6" } }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-secure-store", () => keychain(() => new Map()));
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => ({ kind: "loading" }),
  currentCatalogue: () => ({ kind: "loading" }),
  useRoster: () => ({ kind: "ready", members: [] }),
  members: () => [],
}));

const { play, playbackState, stop } = await import("../src/playback.ts");
const { WatchLayer } = await import("../src/watch.tsx");
const { act } = React;

const movie: Playing = {
  id: "m1",
  subscriptionId: "a",
  title: "Harbour Lights",
  place: "2026",
  live: false,
  next: false,
  versions: false,
};
const livingRoom = { id: "tv1", name: "Living Room TV", model: "Sony TV" };
const browse = (event: object) => act(() => native.listeners.get("onBrowse")?.(event as never));

let container = window.document.createElement("div");
let unmount = () => {};
/** The element drawn with `testID`, as the tests press and read it. */
const find = (testID: string) =>
  container.querySelector(`[data-testid="${testID}"]`) as {
    click(): void;
    getAttribute(name: string): string | null;
  } | null;
const press = (testID: string) => act(() => find(testID)?.click());

beforeEach(async () => {
  await stop();
  Object.assign(native, { events: [], alerts: [], settings: 0 });
  container = window.document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(React.createElement(WatchLayer)));
  unmount = () => act(() => root.unmount());
  await act(() =>
    play(
      movie,
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "file:fixture", container: "mp4" }),
      },
      { watch: true, login: [] },
    ),
  );
});
afterEach(() => unmount());

describe("Play on TV in Watch", () => {
  it("looks for TVs only while its sheet shows, and lists those found", () => {
    expect(find("watch-tv")?.getAttribute("aria-label")).toBe("Play on TV");
    expect(native.events).toEqual([]);

    press("watch-tv");
    expect(native.events).toEqual(["browse"]);
    expect(container.textContent).toContain("Looking for TVs on this Wi-Fi");

    browse({ state: "searching", tvs: [livingRoom] });
    expect(find("watch-tv-tv1")?.getAttribute("aria-label")).toBe("Living Room TV, Sony TV");
    expect(container.textContent).toContain("Keep Mr. Streamer open while it plays on the TV.");

    press("watch-tv-done");
    expect(find("watch-tv-sheet")).toBeNull();
    expect(native.events).toEqual(["browse", "stop browsing"]);
  });

  it("says when Local Network is off, and opens Settings", () => {
    press("watch-tv");
    browse({ state: "denied", tvs: [] });
    expect(container.textContent).toContain("Local Network is off for Mr. Streamer");
    press("watch-tv-action");
    expect(native.settings).toBe(1);
  });

  it("says a TV couldn't be reached, and goes on playing here", async () => {
    press("watch-tv");
    browse({ state: "searching", tvs: [livingRoom] });
    press("watch-tv-tv1");
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(native.alerts).toEqual(["Couldn't connect to Living Room TV."]);
    expect(playbackState.get()).toMatchObject({ tv: { kind: "off" }, watch: true });
    expect(playbackState.get().phase.kind).not.toBe("failed");
    expect(find("watch-tv-sheet")).not.toBeNull();
  });
});
