import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Search, Tv, Volume } from "../src/cast/sender.ts";
import type { PlayIntent } from "../src/player/intent.ts";
import type { MediaState } from "../src/player/media.ts";
import type { Track } from "../src/player/native.ts";
import type { OutputState } from "../src/player/output.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Play on TV as the viewer meets it on Watch and in the mini player: the chooser looks for TVs
// only while it shows, a chosen TV stays Connecting until the player's owner reports it remote,
// and only then does Watch name the TV and keep just what the TV takes. A refusal or a failed
// connection is a dialog over a phone that still plays; a TV that stopped after taking over
// offers Play here and, unless it couldn't play it, the same TV again. React DOM renders on a
// happy-dom window with React Native's views as elements; the player's Cast output is a store
// whose actions record what they were asked, and discovery is a store the test fills.

const scenario = vi.hoisted(() => ({
  asked: [] as string[],
  browsing: 0,
  browsed: 0,
  settings: 0,
  playHere: true,
  /** Whether this build has the Cast module. */
  available: true,
  /** Discovery as the sender reports it, which the test fills. */
  search: null as import("../src/platform/store.ts").Store<Search> | null,
}));

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  };

  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, onPress }: Props) =>
      h(tag, { "aria-label": accessibilityLabel, onClick: onPress, tabIndex: -1 }, children);

  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? h("section", {}, children) : null,
    Alert: { alert() {} },
    StatusBar: () => null,
    Linking: {
      openSettings: async () => {
        scenario.settings++;
      },
    },
    useWindowDimensions: () => ({ width: 412, height: 900, fontScale: 1 }),
    AppState: { addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    AccessibilityInfo: {
      isScreenReaderEnabled: () => new Promise<boolean>(() => {}),
      addEventListener: () => ({ remove() {} }),
    },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");

  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: { children?: ReactNode }) => children,
    SafeAreaInsetsContext: createContext(null),
  };
});

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { sources: { state: store({ kind: "ready", sources: [] }) } };
});

vi.mock("../src/live/runtime.ts", async () => {
  const { listsOwner } = await import("../src/live/store.ts");

  return {
    lists: listsOwner({ readJson: () => null, writeJson() {} }, () => ({
      kind: "ready",
      sources: [],
    })),
  };
});

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
  usePathname: () => "/",
  useSegments: () => [],
  router: { canGoBack: () => true, back() {}, replace() {}, push() {} },
}));

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/subtitles/runtime.ts", () => ({ retainedFileSubtitle: async () => null }));

vi.mock("../src/cast/sender.ts", async () => {
  const { store, useStore } = await import("../src/platform/store.ts");
  const search = store<Search>({ kind: "off" });
  scenario.search = search;

  return {
    tvAvailable: () => scenario.available,
    useTvSearch: () => useStore(search),
    browseTvs() {
      scenario.browsing++;
      scenario.browsed++;

      return () => {
        scenario.browsing--;
      };
    },
  };
});

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  const still: MediaState = {
    tracksKnown: true,
    pip: false,
    pipSupported: true,
    automatic: true,
    next: null,
    remaining: null,
    error: null,
  };

  const state = store<OutputState>({ kind: "local" });

  return {
    player: {
      state: store<PlayerState>({ kind: "idle" }),
      media: {
        state: store(still),
        speeds: [1],
        watch() {},
        reconcile() {},
        retryPreferences() {},
        cancelNext() {},
        dismissError() {},
      },
      play: () => "attempt",
      stop: async () => {
        scenario.asked.push("stop");
      },
      cast: {
        state,
        volume: store<Volume | null>(null),
        async select(tv: Tv) {
          scenario.asked.push(`select ${tv.name}`);
          state.set({ kind: "connecting", tv });

          return true;
        },
        async cancel() {
          scenario.asked.push("cancel");
          state.set({ kind: "local" });
        },
        async playHere() {
          scenario.asked.push("play here");

          if (scenario.playHere) state.set({ kind: "local" });

          return scenario.playHere;
        },
        setVolume(level: number) {
          scenario.asked.push(`volume ${level}`);
        },
      },
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: Element): { render(node: ReactNode): void; unmount(): void };
};

const { default: Watch } = await import("../src/app/watch.tsx");
const { MiniPlayer } = await import("../src/player/mini-player.tsx");
const { player } = await import("../src/player/instance.ts");
const { languageName } = await import("@mrstreamer/core/ondemand/tracks");

const lounge: Tv = { id: "lounge", name: "Lounge TV", model: "Streaming stick" };
const bedroom: Tv = { id: "bedroom", name: "Bedroom", model: "Smart TV" };

const episode: PlayIntent = {
  kind: "title",
  sourceId: "source-1",
  media: "episode",
  id: "e3",
  container: "mp4",
  title: "Estuary Line",
};

const track = (change: Partial<Track> & Pick<Track, "id" | "type">): Track => ({
  codec: null,
  language: null,
  label: null,
  width: null,
  height: null,
  bitrate: null,
  channels: null,
  selected: false,
  supported: true,
  ...change,
});

function playing(change: Partial<Playing> = {}): Playing {
  return {
    kind: "playing",
    intent: episode,
    attempt: "one",
    phase: "playing",
    positionMs: 60_000,
    durationMs: 3_000_000,
    bufferedMs: 0,
    live: false,
    seekable: true,
    speed: 1,
    failure: null,
    tracks: [],
    ...change,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

function mount(screen: () => ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(screen()));

  return container;
}

const output = (next: OutputState) => act(() => player.cast.state.set(next));
const found = (next: Search) => act(() => scenario.search?.set(next));

/** The buttons by what they say, as the viewer reads them. */
const labels = (shown: Element) =>
  Array.from(shown.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? button.textContent,
  );

async function press(shown: Element, label: string) {
  const button = Array.from(shown.querySelectorAll("button")).find(
    (each) => (each.getAttribute("aria-label") ?? each.textContent) === label,
  );

  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${label}`);
  await act(async () => button.click());
}

beforeEach(() => {
  scenario.asked = [];
  scenario.browsed = 0;
  scenario.settings = 0;
  scenario.playHere = true;
  scenario.available = true;
  player.state.set(playing());
  player.cast.state.set({ kind: "local" });
  player.cast.volume.set(null);
  scenario.search?.set({ kind: "off" });
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  window.document.body.innerHTML = "";
  expect(scenario.browsing).toBe(0);
});

describe("Play on TV", () => {
  it("looks for TVs only while the chooser shows, and keeps a chosen TV Connecting until it plays there", async () => {
    const shown = mount(() => createElement(Watch));
    expect(scenario.browsed).toBe(0);

    await press(shown, "Play on TV");
    expect(scenario.browsing).toBe(1);
    expect(shown.textContent).toContain("Looking for TVs on this Wi-Fi");
    expect(shown.textContent).toContain("Leaving the app stops playback on the TV.");

    found({ kind: "searching", tvs: [lounge, bedroom] });
    expect(labels(shown)).toContain("Lounge TV, Streaming stick");
    expect(shown.textContent).toContain("Looking for more on this Wi-Fi");

    await press(shown, "Lounge TV, Streaming stick");
    expect(scenario.asked).toEqual(["select Lounge TV"]);
    expect(labels(shown)).toContain("Lounge TV, Connecting");
    // Still the phone's: its own controls stay until the TV reports it plays.
    expect(labels(shown)).toContain("Picture in picture");

    output({ kind: "remote", tv: lounge });
    expect(scenario.browsing).toBe(0);
    expect(shown.textContent).toContain("On Lounge TV");
    expect(shown.textContent).toContain("Keep Mr. Streamer open while it plays.");
  });

  it("keeps only what the TV takes while it plays: play, the jumps, the seek bar and Subtitles", () => {
    player.state.set(
      playing({ tracks: [track({ id: "en", type: "audio", language: "en", selected: true })] }),
    );
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(Watch));
    const now = labels(shown);
    expect(now).toEqual(
      expect.arrayContaining(["On Lounge TV", "Pause", "Back 10 seconds", "Subtitles"]),
    );

    for (const local of ["Audio", "Speed", "Picture in picture"]) expect(now).not.toContain(local);
  });

  it("says no TVs were found after a quiet while, and Look again looks again", async () => {
    vi.useFakeTimers();
    const shown = mount(() => createElement(Watch));
    await press(shown, "Play on TV");
    found({ kind: "searching", tvs: [] });
    act(() => vi.advanceTimersByTime(10_000));
    expect(shown.textContent).toContain("No TVs found");

    await press(shown, "Look again");
    expect(scenario.browsed).toBe(2);
    expect(shown.textContent).toContain("Looking for TVs on this Wi-Fi");
  });

  it("offers Settings only where Android actually denied looking", async () => {
    const shown = mount(() => createElement(Watch));
    await press(shown, "Play on TV");
    found({ kind: "failed" });
    expect(shown.textContent).toContain("Can't look for TVs");
    expect(labels(shown)).not.toContain("Open Settings");

    found({ kind: "denied" });
    await press(shown, "Open Settings");
    expect(scenario.settings).toBe(1);
  });

  it("shows nothing of TVs in a build without the Cast module", () => {
    scenario.available = false;
    output({ kind: "refused", tv: lounge, reason: "protected" });
    const shown = mount(() => createElement(Watch));
    expect(labels(shown)).not.toContain("Play on TV");
    expect(shown.textContent).not.toContain("Can't play on");
  });
});

describe("the TV sheet", () => {
  it("shows the TV's volume only once the TV reported one, and sends a change to the TV", async () => {
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(Watch));
    await press(shown, "On Lounge TV");
    expect(shown.textContent).toContain("Playing Estuary Line");
    expect(shown.querySelector('[aria-label="TV volume"]')).toBeNull();

    act(() => player.cast.volume.set({ level: 0.6, muted: false }));
    expect(shown.querySelector('[aria-label="TV volume"]')).not.toBeNull();
  });

  it("returns playback here explicitly with Disconnect and play here", async () => {
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(Watch));
    await press(shown, "On Lounge TV");
    await press(shown, "Disconnect and play here");
    expect(scenario.asked).toEqual(["play here"]);
    expect(shown.textContent).not.toContain("Disconnect and play here");
  });

  it("moves to another TV only once playback is back here, and never after a failed return", async () => {
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(Watch));
    await press(shown, "On Lounge TV");
    found({ kind: "searching", tvs: [lounge, bedroom] });
    expect(labels(shown)).not.toContain("Lounge TV, Streaming stick");

    scenario.playHere = false;
    await press(shown, "Bedroom, Smart TV");
    expect(scenario.asked).toEqual(["play here"]);

    scenario.playHere = true;
    await press(shown, "Bedroom, Smart TV");
    expect(scenario.asked).toEqual(["play here", "play here", "select Bedroom"]);
  });

  it("says a downloaded subtitle doesn't play on the TV, and any other offers no choice there", async () => {
    player.state.set(
      playing({
        tracks: [
          track({
            id: "mrstreamer-downloaded-subtitle",
            type: "text",
            language: "nl",
            selected: true,
          }),
        ],
      }),
    );
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(Watch));
    await press(shown, "Subtitles");
    expect(shown.textContent).toContain("Downloaded subtitles don't play on the TV.");
    expect(shown.textContent).toContain(`${languageName("nl")} shows again when it plays here.`);
    expect(shown.textContent).not.toContain("Subtitle choices aren't available");

    act(() => player.state.set(playing({ tracks: [track({ id: "en", type: "text" })] })));
    expect(shown.textContent).toContain("Subtitle choices aren't available on the TV.");
    expect(shown.textContent).not.toContain("Downloaded subtitles");
  });
});

describe("when the TV can't or doesn't play it", () => {
  it("says a refusal in a dialog over a phone that still plays, and OK clears it", async () => {
    output({ kind: "refused", tv: lounge, reason: "protected" });
    const shown = mount(() => createElement(Watch));
    expect(shown.textContent).toContain("Can't play on Lounge TV");
    expect(shown.textContent).toContain(
      "Its stream is protected, so it can't play on a TV. It still plays on this phone.",
    );
    expect(labels(shown)).toContain("Picture in picture");

    await press(shown, "OK");
    expect(scenario.asked).toEqual(["cancel"]);
    expect(shown.textContent).not.toContain("Can't play on");
  });

  it("says a failed connection, and a TV that stopped before it played, in that dialog", () => {
    output({ kind: "refused", tv: lounge, reason: "unavailable" });
    const shown = mount(() => createElement(Watch));
    expect(shown.textContent).toContain("Couldn't connect to Lounge TV");

    output({ kind: "stopped", tv: lounge, reason: "failed", detached: false });
    expect(shown.textContent).toContain(
      "Lounge TV couldn't play it. It still plays on this phone.",
    );
    expect(shown.textContent).not.toContain("TV stopped");
  });

  it("clears a connection the app left before the TV played, without a word", () => {
    output({ kind: "stopped", tv: lounge, reason: "foreground", detached: false });
    const shown = mount(() => createElement(Watch));
    expect(scenario.asked).toEqual(["cancel"]);
    expect(shown.textContent).not.toContain("TV stopped");
  });

  it("says why a TV that held playback stopped, with Play here and the same TV again", async () => {
    player.state.set(
      playing({
        phase: "failed",
        failure: { kind: "native", failure: { kind: "network", code: "CAST_ENDED", status: null } },
      }),
    );
    output({ kind: "stopped", tv: lounge, reason: "lost", detached: true });
    const shown = mount(() => createElement(Watch));
    expect(shown.textContent).toContain("TV stopped");
    expect(shown.textContent).toContain("Lost Lounge TV.");
    expect(shown.textContent).not.toContain("Connection lost");
    expect(labels(shown)).not.toContain("Try again");

    await press(shown, "Play on Lounge TV");
    expect(scenario.asked).toEqual(["play here", "select Lounge TV"]);
  });

  it("offers only Play here when the TV couldn't play it, and says leaving stopped it", async () => {
    output({ kind: "stopped", tv: lounge, reason: "failed", detached: true });
    const shown = mount(() => createElement(Watch));
    expect(shown.textContent).toContain("It can still play on this phone.");
    expect(labels(shown)).not.toContain("Play on Lounge TV");
    await press(shown, "Play here");
    expect(scenario.asked).toEqual(["play here"]);

    output({ kind: "stopped", tv: lounge, reason: "foreground", detached: true });
    expect(shown.textContent).toContain("Stopped on the TV when you left the app.");
    expect(shown.textContent).toContain("Lounge TV stops when you leave Mr. Streamer.");
  });
});

describe("the mini player on a TV", () => {
  it("says which TV plays it, and Close stops it there", async () => {
    output({ kind: "remote", tv: lounge });
    const shown = mount(() => createElement(MiniPlayer));
    expect(shown.textContent).toContain("On Lounge TV");

    await press(shown, "Close");
    expect(scenario.asked).toEqual(["stop"]);
  });
});
