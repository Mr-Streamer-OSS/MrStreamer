import { createRoot, document } from "./dom.ts";
import { nativePlayer } from "./native-player.ts";
import * as React from "react";
import type { Locale } from "@mrstreamer/contracts/language";
import { setLanguage } from "@mrstreamer/core/i18n";
import type { ObservedTrackSnapshot } from "expo-video";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Playing } from "../src/playback.ts";
import { keychain } from "./keychain.ts";

// Watch in the interface language: its controls, what they say to VoiceOver, its sheets and a
// failed play's message read in the language picked, and a new pick while a title plays redraws
// them where they stand, leaving the player, its picture, position, speed and sound track alone.
// The real Watch layer and playback run with React DOM on a happy-dom window, as
// watch-picture-in-picture.test.ts does; the native player and VideoView are stand-ins.

const native = vi.hoisted(() => ({
  /** VideoViews made, and those on screen. */
  made: 0,
  views: [] as number[],
  port: null as ReturnType<typeof nativePlayer> | null,
  sheets: [] as Array<{
    title?: string;
    options: readonly string[];
    pick: (index: number) => void;
  }>,
}));

vi.mock("../src/downloads.ts", () => ({
  useDownloads: () => ({ items: [], series: {}, bytes: 0, free: null, ended: 0 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-video", async () => {
  const { Component } = await import("react");
  class VideoView extends Component {
    readonly id = ++native.made;
    override componentDidMount() {
      native.views.push(this.id);
    }
    override componentWillUnmount() {
      native.views.splice(native.views.indexOf(this.id), 1);
    }
    async startPictureInPicture() {}
    async stopPictureInPicture() {}
    override render() {
      return null;
    }
  }
  return {
    VideoView,
    VideoAirPlayButton: () => null,
    isPictureInPictureSupported: () => true,
    createVideoPlayer: () => (native.port = nativePlayer()),
  };
});
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      options: { title?: string; options: readonly string[] },
      pick: (index: number) => void,
    ) => void native.sheets.push({ ...options, pick }),
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
vi.mock("expo-router", () => ({
  router: { push: () => undefined, dismiss: () => undefined },
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
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#8E8E93" } }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-secure-store", () => keychain(() => new Map()));
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => ({ kind: "loading" }),
  currentCatalogue: () => ({ kind: "loading" }),
  useRoster: () => ({ kind: "ready", members: [] }),
  members: () => [],
}));

const { play, playbackState, player, stop } = await import("../src/playback.ts");
const { WatchLayer } = await import("../src/watch.tsx");
const { act } = React;

const movie: Playing = {
  id: "m1",
  subscriptionId: "a",
  title: "A movie",
  place: "Movies",
  live: false,
  next: false,
  versions: false,
};
const open = async () => ({ url: "file:fixture", container: "mp4" });
const settle = () => act(() => new Promise((done) => setTimeout(done, 0)));
const speak = (locale: Locale) => act(() => setLanguage({ locale, formats: locale }));
const port = () => native.port!;

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const button = (id: string) =>
  [...document.querySelectorAll("button")].find((each) => each.getAttribute("data-testid") === id);
const label = (id: string) => byId(id)?.getAttribute("aria-label");
const text = (id: string) => byId(id)?.textContent;

/** The sheet Watch shows for the text control `id`. */
async function sheetOf(id: string) {
  const before = native.sheets.length;
  await act(async () => button(id)?.click());
  await settle();
  const sheet = native.sheets.at(-1);
  expect(native.sheets.length).toBe(before + 1);
  // Closed with its last option, Cancel, so the next sheet can show.
  act(() => sheet!.pick(sheet!.options.length - 1));
  return sheet!;
}

function tracks(): ObservedTrackSnapshot {
  const identity = { ...port().identity(), revision: 1, isDefault: false, isPlayable: true };
  return {
    ...identity,
    audio: {
      state: "ready",
      options: [
        { ...identity, id: "1", group: "audio", language: "en", label: "English", name: "Stereo" },
        { ...identity, id: "2", group: "audio", language: "nl", label: "Dutch", name: "Stereo" },
      ],
    },
    subtitles: { state: "ready", options: [] },
    subtitleOffAllowed: true,
    selectedAudioId: "2",
    selectedSubtitleId: null,
  };
}

let unmount = () => {};
beforeEach(() => {
  native.sheets = [];
});
afterEach(async () => {
  unmount();
  await stop();
  setLanguage({ locale: "en-US", formats: "en-US" });
});

/** Watch shows `movie` playing, at 1.5×, its Dutch sound chosen. */
async function watching() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(React.createElement(WatchLayer)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(() =>
    play(movie, { kind: "file", originalLanguage: null, open }, { watch: true, login: [] }),
  );
  port().tracks = tracks();
  port().playbackRate = 1.5;
  port().currentTime = 300;
  act(() => {
    port().ready();
    port().state(true);
  });
  await settle();
}

it("shows Watch in the language picked, and redraws it in place in a new one", async () => {
  speak("fr-FR");
  await watching();
  expect(label("watch-close")).toBe("Fermer");
  expect(label("watch-pip")).toBe("Image dans l'image");
  expect(label("watch-scrubber")).toBe("Position");
  expect(text("watch-subtitles")).toBe("Sous-titres");
  expect(text("watch-speed")).toBe("Vitesse 1,5×");
  const audio = await sheetOf("watch-audio");
  expect(audio.title).toBe("Audio");
  expect(audio.options).toEqual(["English", "✓ Dutch", "Annuler"]);
  expect((await sheetOf("watch-speed")).options).toEqual([
    "0,5×",
    "0,75×",
    "1×",
    "1,25×",
    "✓ 1,5×",
    "2×",
    "Annuler",
  ]);

  const shown = [...native.views];
  const opened = port().replaceObservedAsync.mock.calls.length;
  const picked = port().selectObservedTrackAsync.mock.calls.length;
  port().play.mockClear();
  port().pause.mockClear();
  speak("de-DE");
  expect(label("watch-close")).toBe("Schließen");
  expect(label("watch-pause")).toBe("Pause");
  expect(text("watch-subtitles")).toBe("Untertitel");
  expect(text("watch-speed")).toBe("Geschwindigkeit 1,5×");
  const speed = await sheetOf("watch-speed");
  expect(speed.title).toBe("Geschwindigkeit");
  expect(speed.options.at(-1)).toBe("Abbrechen");
  expect((await sheetOf("watch-audio")).options).toEqual(["English", "✓ Dutch", "Abbrechen"]);

  // The same picture and play: nothing opened again, paused, played, sought or picked.
  expect(native.views).toEqual(shown);
  expect(port().replaceObservedAsync.mock.calls.length).toBe(opened);
  expect(port().play).not.toHaveBeenCalled();
  expect(port().pause).not.toHaveBeenCalled();
  expect(port().seekBy).not.toHaveBeenCalled();
  expect(port().selectObservedTrackAsync.mock.calls.length).toBe(picked);
  expect(player().currentTime).toBe(300);
  expect(port().playbackRate).toBe(1.5);
  expect(playbackState.get()).toMatchObject({
    phase: { kind: "playing", item: movie },
    watch: true,
  });
});

it("says why a play failed in the language picked", async () => {
  speak("es-ES");
  await watching();
  act(() => port().failure({ kind: "unsupported", evidence: null }));
  await settle();
  expect(playbackState.get().phase.kind).toBe("failed");
  expect(document.body.textContent).toContain("Mr. Streamer no puede reproducir este archivo.");
  expect(label("watch-retry")).toBe("Reintentar");
});
