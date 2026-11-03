import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Watch as the viewer meets it: it plays the intent its link names unless that already plays,
// leaves when it names none and nothing plays, words a failure with Try again, and keeps its
// controls up while one has keyboard focus. The mini player, off Watch, says how far it covers
// the screens' foot. Both render with React DOM on a happy-dom window; React Native's views are
// elements that lay out once at a stand-in height, the router records what it is asked, and the
// player is a store with play() that records each intent.

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  pathname: "/watch",
  asked: [] as string[],
  played: [] as unknown[],
  retries: 0,
}));

vi.mock("react-native", async () => {
  const { createElement: h, useLayoutEffect } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };

  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, onPress, onFocus, onBlur, onLayout }: Props) => {
      useLayoutEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 412, height: 72 } } }),
        [],
      );

      return h(
        tag,
        { "aria-label": accessibilityLabel, onClick: onPress, onFocus, onBlur, tabIndex: -1 },
        children,
      );
    };

  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    StatusBar: () => null,
    useWindowDimensions: () => ({ width: 412, height: 900 }),
    AccessibilityInfo: {
      isScreenReaderEnabled: () => new Promise<boolean>(() => {}),
      addEventListener: () => ({ remove() {} }),
    },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => scenario.params,
  useIsFocused: () => true,
  usePathname: () => scenario.pathname,
  router: {
    canGoBack: () => true,
    back: () => scenario.asked.push("back"),
    replace: (href: string) => scenario.asked.push(`replace ${href}`),
    push: () => scenario.asked.push("push"),
  },
}));

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const state = store<PlayerState>({ kind: "idle" });

  return {
    player: {
      state,
      play(intent: PlayIntent) {
        scenario.played.push(intent);
        state.set(playing(intent));

        return "attempt";
      },
      retry() {
        scenario.retries++;
      },
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: Element): { render(node: unknown): void; unmount(): void };
};

const { default: Watch } = await import("../src/app/watch.tsx");
const { MiniPlayer } = await import("../src/player/mini-player.tsx");
const { footOverlay } = await import("../src/navigation/screen.tsx");
const { player } = await import("../src/player/instance.ts");
const { watchHref } = await import("../src/player/intent.ts");

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
  player.state.set({ kind: "idle" });
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
