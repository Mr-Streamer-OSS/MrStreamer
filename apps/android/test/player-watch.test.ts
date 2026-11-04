import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { MediaState } from "../src/player/media.ts";
import type { Track } from "../src/player/native.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Watch as the viewer meets it: it plays the intent its link names unless that already plays,
// leaves when it names none and nothing plays, words a failure with Try again, keeps its
// controls up while one has keyboard focus, and offers the media controls the player reports. The mini player, off Watch, says how far it covers
// the screens' foot. Both render with React DOM on a happy-dom window; React Native's views are
// elements that lay out once at a stand-in height, the router records what it is asked, and the
// player is a store with play() that records each intent; its media model is a store whose
// actions record what they were asked.

/** What the media model holds before anything is known. */
const still = vi.hoisted((): MediaState => ({
  tracksKnown: false,
  pip: false,
  pipSupported: true,
  automatic: true,
  next: null,
  remaining: null,
  error: null,
}));

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  pathname: "/watch",
  asked: [] as string[],
  played: [] as unknown[],
  retries: 0,
  media: [] as string[],
  replacements: [] as string[],
}));

vi.mock("react-native", async () => {
  const { createElement: h, useLayoutEffect } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    onPress?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };

  const view =
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      onPress,
      onFocus,
      onBlur,
      onLayout,
    }: Props) => {
      useLayoutEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 412, height: 72 } } }),
        [],
      );

      return h(
        tag,
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole === "radio" ? "radio" : undefined,
          "aria-checked": accessibilityState?.checked,
          onClick: onPress,
          onFocus,
          onBlur,
          tabIndex: -1,
        },
        children,
      );
    };

  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    TextInput: () => null,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? h("section", {}, children) : null,
    Alert: { alert() {} },
    StatusBar: () => null,
    useWindowDimensions: () => ({ width: 412, height: 900 }),
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
  useLocalSearchParams: () => scenario.params,
  useIsFocused: () => true,
  usePathname: () => scenario.pathname,
  useSegments: () => [],
  navigate: () => {},
  router: {
    canGoBack: () => true,
    back: () => scenario.asked.push("back"),
    replace: (href: string) => scenario.asked.push(`replace ${href}`),
    push: () => scenario.asked.push("push"),
    navigate: () => scenario.asked.push("downloads"),
  },
}));

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const state = store<PlayerState>({ kind: "idle" });
  const media = store<MediaState>(still);

  // Each action records what it was asked, and the player accepts it.
  const asked = (name: string) => (value?: string | number) => {
    scenario.media.push(value === undefined ? name : `${name} ${String(value)}`);

    return Promise.resolve(true);
  };

  return {
    player: {
      state,
      media: {
        state: media,
        speeds: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        watch() {},
        reconcile() {},
        retryPreferences() {},
        audio: asked("audio"),
        text: asked("text"),
        speed: asked("speed"),
        quality: asked("quality"),
        enterPip: asked("pip"),
        refreshOfflineNext: asked("refresh offline next"),
        playNext: asked("play next"),
        cancelNext() {
          scenario.media.push("cancel next");
          media.set((now) => ({ ...now, remaining: null }));
        },
        dismissError() {
          media.set((now) => ({ ...now, error: null }));
        },
      },
      play(intent: PlayIntent) {
        scenario.played.push(intent);
        state.set(playing(intent));

        return "attempt";
      },
      resume: asked("resume"),
      retry() {
        scenario.retries++;
      },
    },
  };
});

vi.mock("../src/subtitles/runtime.ts", () => ({
  retainedFileSubtitle: async () => ({ subtitle: { language: "nl" } }),
}));

vi.mock("../src/downloads/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  const owner = {
    state: store({ rows: [] }),
    prompt: store<import("../src/downloads/replace.ts").ReplacePrompt | null>(null),
    replace: async (row: { id: string }) => {
      scenario.replacements.push(row.id);

      return "replaced";
    },
  };

  return { downloads: () => owner };
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
const { footOverlay } = await import("../src/navigation/screen.tsx");
const { player } = await import("../src/player/instance.ts");
const { watchHref } = await import("../src/player/intent.ts");
const { lists } = await import("../src/live/runtime.ts");

const estuary: PlayIntent = {
  kind: "live",
  sourceId: "source-1",
  channelId: "estuary",
  title: "Estuary Max",
};

const harbour: PlayIntent = { ...estuary, channelId: "harbour", title: "Harbour HD" };

function playing(intent: PlayIntent, change: Partial<Playing> = {}): Playing {
  return {
    kind: "playing",
    intent,
    attempt: "before",
    phase: "playing",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: intent.kind === "live",
    seekable: false,
    speed: 1,
    failure: null,
    tracks: [],
    ...change,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

/** Opens Watch as a link to `intent` does, or with no intent. */
function open(intent: PlayIntent | null) {
  const href = intent ? watchHref(intent) : { pathname: "/watch" };
  scenario.params = "params" in href ? href.params : {};
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Watch)));

  return container;
}

beforeEach(() => {
  scenario.pathname = "/watch";
  scenario.asked = [];
  scenario.played = [];
  scenario.retries = 0;
  scenario.media = [];
  player.state.set({ kind: "idle" });
  player.media.state.set(still);
});

afterEach(() => {
  vi.useRealTimers();
  footOverlay.set(0);
  act(() => root?.unmount());
  root = null;
  window.document.body.innerHTML = "";
});

describe("Watch", () => {
  it("plays the channel its link names when nothing plays, under its title", () => {
    const shown = open(estuary);
    expect(scenario.played).toEqual([estuary]);
    expect(shown.textContent).toContain("Estuary Max");
  });

  it("carries on with what plays when opened again for it, and replaces anything else", () => {
    player.state.set(playing(estuary, { positionMs: 60_000 }));
    open({ ...estuary });
    expect(scenario.played).toEqual([]);
    act(() => root?.unmount());
    open(harbour);
    expect(scenario.played).toEqual([harbour]);
  });

  it("leaves when it names nothing and nothing plays, with nothing played", () => {
    open(null);
    expect(scenario.asked).toEqual(["back"]);
    expect(scenario.played).toEqual([]);
  });

  it("leaves when what it showed is stopped from elsewhere", () => {
    player.state.set(playing(estuary));
    open(estuary);
    expect(scenario.asked).toEqual([]);

    act(() => player.state.set({ kind: "idle" }));
    expect(scenario.asked).toEqual(["back"]);
  });

  it("says why a stream was refused, and Try again tries it again", () => {
    player.state.set(
      playing(estuary, {
        phase: "failed",
        failure: {
          kind: "native",
          failure: { kind: "http", code: "IO_BAD_HTTP_STATUS", status: 403 },
        },
      }),
    );
    const shown = open(estuary);
    expect(shown.textContent).toContain(
      "If another device is watching on this subscription, stop it there first.",
    );

    const retry = Array.from(shown.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Try again"),
    );

    if (!(retry instanceof window.HTMLButtonElement)) throw new Error("No Try again");
    act(() => retry.click());
    expect(scenario.retries).toBe(1);
    expect(scenario.played).toEqual([]);
  });

  it("keeps its controls up while one has keyboard focus, and hides them a full wait after it leaves", () => {
    vi.useFakeTimers();

    const recording = (change: Partial<Playing> = {}) =>
      playing(estuary, { live: false, seekable: true, durationMs: 600_000, ...change });

    player.state.set(recording());
    const shown = open(estuary);
    const find = (label: string) => shown.querySelector(`[aria-label="${label}"]`);

    const focus = (label: string) => {
      const control = find(label);

      if (!(control instanceof window.HTMLElement)) throw new Error(`No ${label}`);
      act(() => control.focus());

      return control;
    };

    act(() => vi.advanceTimersByTime(4000));
    expect(find("Back")).toBeNull();

    // Paused elsewhere, the controls show; Back takes focus, then it plays on while focus moves
    // to Pause and the seek bar.
    act(() => player.state.set(recording({ phase: "paused" })));
    focus("Back");
    act(() => player.state.set(recording()));
    focus("Pause");
    const bar = focus("Position");
    act(() => vi.advanceTimersByTime(60_000));
    expect(find("Back")).not.toBeNull();

    act(() => bar.blur());
    act(() => vi.advanceTimersByTime(3999));
    expect(find("Back")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(find("Back")).toBeNull();
  });
});

describe("Watch's media controls", () => {
  const episode: PlayIntent = {
    kind: "title",
    sourceId: "source-1",
    media: "episode",
    id: "e3",
    container: "mkv",
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

  const subtitles = [
    track({
      id: "nl",
      type: "text",
      language: "nl",
      codec: "application/x-subrip",
      selected: true,
    }),
    track({ id: "en", type: "text", language: "en", codec: "application/x-subrip" }),
    track({ id: "de", type: "text", language: "de", codec: "application/pgs", supported: false }),
  ];

  const variants = [
    track({ id: "fhd", type: "video", height: 1080, label: "Estuary Max FHD", selected: true }),
    track({ id: "hd", type: "video", height: 720, label: "Estuary Max HD" }),
  ];

  const media = (change: Partial<MediaState>) =>
    act(() => player.media.state.set((now) => ({ ...now, ...change })));

  /** The buttons by what they show, as the viewer reads them. */
  const labels = (shown: Element) =>
    Array.from(shown.querySelectorAll("button")).map(
      (button) => button.getAttribute("aria-label") ?? button.textContent,
    );

  const press = (shown: Element, label: string) => {
    const button = Array.from(shown.querySelectorAll("button")).find(
      (each) => (each.getAttribute("aria-label") ?? each.textContent) === label,
    );

    if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${label}`);
    act(() => button.click());
  };

  const ticked = (shown: Element) =>
    Array.from(shown.querySelectorAll('[role="radio"][aria-checked="true"]')).map((row) =>
      row.getAttribute("aria-label"),
    );

  it("offers a title's Audio, Subtitles and Speed, and Live's Automatic and star in place of Speed", () => {
    player.state.set(playing(episode, { live: false, speed: 1.25 }));
    let shown = open(episode);
    expect(labels(shown)).toEqual(
      expect.arrayContaining(["Audio", "Subtitles", "Speed 1.25×", "Picture in picture"]),
    );
    expect(labels(shown)).not.toContain("Next episode");

    media({
      next: { intent: { ...episode, id: "e4", media: "episode" }, label: "S1 E4 · High Water" },
    });
    press(shown, "Next episode");
    expect(scenario.media).toEqual(["play next"]);
    act(() => root?.unmount());

    player.state.set(playing(estuary, { tracks: variants }));
    media({ next: null, tracksKnown: true });
    lists.read();
    shown = open(estuary);
    expect(labels(shown)).toEqual(
      expect.arrayContaining(["Audio", "Subtitles", "Automatic", "Add to Favourites"]),
    );
    expect(labels(shown).filter((label) => label?.startsWith("Speed"))).toEqual([]);
  });

  it("ticks the subtitles the player reports, not the ones tapped, and names those it can't show", () => {
    player.state.set(playing(episode, { live: false, tracks: subtitles }));
    media({ tracksKnown: true });
    const shown = open(episode);
    press(shown, "Subtitles");
    expect(ticked(shown)).toEqual(["Nederlands, SubRip"]);
    expect(shown.textContent).toContain("Can't show here: Deutsch (PGS).");

    press(shown, "English, SubRip");
    expect(scenario.media).toEqual(["text en"]);
    press(shown, "Subtitles");
    expect(ticked(shown)).toEqual(["Nederlands, SubRip"]);

    act(() =>
      player.state.set(
        playing(episode, {
          live: false,
          tracks: subtitles.map((each) => ({ ...each, selected: each.id === "en" })),
        }),
      ),
    );
    expect(ticked(shown)).toEqual(["English, SubRip"]);
  });

  it("says a channel's audio isn't known yet before its tracks are read", () => {
    player.state.set(playing(estuary));
    const shown = open(estuary);
    press(shown, "Audio");
    expect(shown.textContent).toContain("Not known yet. Try again in a moment.");
    expect(ticked(shown)).toEqual([]);
  });

  it("ticks Automatic with the variant it plays, and ticks a variant once the player reports it chosen", () => {
    player.state.set(playing(estuary, { tracks: variants }));
    media({ tracksKnown: true });
    const shown = open(estuary);
    press(shown, "Automatic");
    expect(ticked(shown)).toEqual(["Automatic"]);
    expect(labels(shown)).toContain("Full HD · Estuary Max FHD, Playing");

    media({ automatic: false });
    expect(ticked(shown)).toEqual(["Full HD · Estuary Max FHD"]);
  });

  it("closes media sheets and suppresses dialogs in PiP, and hides unsupported PiP", () => {
    player.state.set(playing(episode, { live: false }));
    const shown = open(episode);
    press(shown, "Subtitles");
    media({ pip: true, error: "text" });
    expect(shown.textContent).not.toContain("Couldn't show subtitles");
    expect(shown.querySelector("section")).toBeNull();
    media({ pip: false, error: null, pipSupported: false });
    expect(shown.querySelector("section")).toBeNull();
    expect(labels(shown)).not.toContain("Picture in picture");
  });

  it("names a Live quality with no reported label or height", () => {
    player.state.set(
      playing(estuary, { tracks: variants.map((t) => ({ ...t, label: null, height: null })) }),
    );
    media({ automatic: false });
    expect(labels(open(estuary))).toContain("Quality");
  });

  it("says a refused change in a dialog that OK closes", () => {
    player.state.set(playing(episode, { live: false }));
    const shown = open(episode);
    media({ error: "text" });
    expect(shown.textContent).toContain("Couldn't show subtitles");
    expect(shown.textContent).toContain("This phone refused the change. Try again.");

    press(shown, "OK");
    expect(shown.textContent).not.toContain("Couldn't show subtitles");
  });

  it("counts down to the next episode, and Cancel leaves Play again and Next episode", () => {
    player.state.set(playing(episode, { live: false, phase: "ended" }));
    media({
      next: { intent: { ...episode, id: "e4", media: "episode" }, label: "S1 E4 · High Water" },
      remaining: 8,
    });
    const shown = open(episode);
    expect(shown.textContent).toContain("S1 E4 · High Water");
    expect(shown.textContent).toContain("Plays in 8");
    expect(labels(shown)).toContain("Play next");

    press(shown, "Cancel");
    expect(scenario.media).toEqual(["cancel next"]);
    expect(shown.textContent).not.toContain("Plays in");
    expect(labels(shown)).toEqual(expect.arrayContaining(["Play again", "Next episode"]));
  });
});

describe("the mini player", () => {
  function mount() {
    const container = window.document.createElement("div");
    window.document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(createElement(MiniPlayer)));
  }

  it("covers the screens' foot by its height while it shows, and by nothing once stopped", () => {
    scenario.pathname = "/";
    player.state.set(playing(estuary));
    mount();
    expect(footOverlay.get()).toBe(72);

    act(() => player.state.set({ kind: "idle" }));
    expect(footOverlay.get()).toBe(0);
  });

  it("covers nothing while Watch shows or once it is gone", () => {
    player.state.set(playing(estuary));
    mount();
    expect(footOverlay.get()).toBe(0);
    act(() => root?.unmount());

    scenario.pathname = "/";
    mount();
    expect(footOverlay.get()).toBe(72);
    act(() => root?.unmount());
    expect(footOverlay.get()).toBe(0);
  });
});

describe("downloaded Watch end", () => {
  const row = {
    id: "next-copy",
    key: "key",
    sourceId: "source",
    title: "Series",
    sourceLabel: "Provider",
    kind: "episode",
    mediaId: "second",
    container: "mp4",
    state: "complete",
    bytes: 100,
    total: 100,
    reason: "",
    season: 1,
    episode: 2,
  } as const;

  function end(
    next: import("../src/downloads/offline-next.ts").OfflineNext,
    remaining: number | null = null,
  ) {
    player.state.set(
      playing({ kind: "file", path: "/current", title: "Series" }, { phase: "ended" }),
    );
    player.media.state.set({ ...still, offline: next, remaining });

    return open(null);
  }

  function click(shown: Element, text: string) {
    const button = [...shown.querySelectorAll("button")].findLast(
      (button) => button.textContent === text,
    );

    if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${text}`);
    act(() => button.click());
  }

  it.each(["downloading", "not-saved", "read"] as const)(
    "offers Downloads without advancing for %s",
    (kind) => {
      const shown = end({
        kind,
        row: { ...row, state: kind === "downloading" ? "running" : "complete" },
      });

      expect(shown.textContent).toContain(
        kind === "downloading"
          ? "still downloading"
          : kind === "read"
            ? "Couldn't read downloads."
            : "isn't on this device",
      );
      expect(shown.textContent).not.toContain("Replace");
      expect(shown.textContent).not.toContain("Play next");

      for (const control of ["Audio", "Subtitles", "Speed"])
        expect(shown.textContent).toContain(control);
      click(shown, "Downloads");
      expect(scenario.asked).toContain("downloads");
      expect(scenario.media).not.toContain("play next");
      click(shown, "Play again");
      expect(scenario.media).toContain("resume");
      expect(scenario.played).toEqual([]);
    },
  );
  it.each(["missing", "changed"] as const)(
    "replaces %s with the existing confirmation rules",
    async (kind) => {
      scenario.replacements = [];
      const { downloads } = await import("../src/downloads/runtime.ts");
      downloads().prompt.set(null);

      const shown = end({
        kind,
        row: { ...row, reason: kind === "missing" ? "missing" : "file-changed" },
      });

      expect(shown.textContent).toContain(kind === "missing" ? "File missing" : "File changed");
      click(shown, "Replace");
      await act(async () => {
        await vi.waitFor(() =>
          expect(
            kind === "changed" ? downloads().prompt.get()?.kind : scenario.replacements[0],
          ).toBe(kind === "changed" ? "confirm" : row.id),
        );
      });

      if (kind === "changed") {
        expect(scenario.replacements).toEqual([]);
        expect(shown.textContent).toContain("Replace the copy of");
        click(shown, "Replace");
        await act(async () => {
          await Promise.resolve();
        });
        expect(scenario.replacements).toEqual([row.id]);
      }

      expect(scenario.played).toEqual([]);
      expect(scenario.media).not.toContain("play next");
    },
  );
  it("shows the checked countdown and retained language; cancellation leaves manual Next", async () => {
    const next = { kind: "ready", row, path: "/next" } as const;
    const shown = end(next, 8);
    await act(async () => {
      await import("../src/subtitles/runtime.ts");
      await Promise.resolve();
    });
    expect(shown.textContent).toContain("Downloaded · Nederlands · Plays in 8");
    expect(scenario.played).toEqual([]);
    click(shown, "Cancel");
    expect(shown.textContent).not.toContain("Plays in");
    click(shown, "Play next");
    expect(scenario.media).toContain("play next");
    act(() => player.media.state.set({ ...still, offline: next }));
    expect(shown.textContent).not.toContain("Plays in");
  });
});
