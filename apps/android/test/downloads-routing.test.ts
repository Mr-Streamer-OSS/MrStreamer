import { setLanguage } from "@mrstreamer/core/i18n";
import { Window, type Element, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Render the production root, Watch and mini player. Native views and routing are stand-ins;
// stores, route guards and user actions run through the production components.

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  pathname: "/watch",
  asked: [] as string[],
  played: [] as unknown[],
  retries: 0,
  sources: [] as import("../src/connect/sources.ts").ConnectedSource[],
  restoring: false,
  focused: true,
  canGoBack: true,
  rootRenders: 0,
  redirects: {} as Record<string, string | undefined>,
  restore: vi.fn(async () => {}),
  start: vi.fn(() => () => {}),
}));

vi.mock("react-native", async () => {
  const { createElement: h, useLayoutEffect } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    style?: import("react").CSSProperties;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };

  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, onPress, onFocus, onBlur, onLayout, style }: Props) => {
      useLayoutEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 412, height: 72 } } }),
        [],
      );

      return h(
        tag,
        {
          style,
          "aria-label": accessibilityLabel,
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
    StatusBar: () => null,
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    AppState: { addEventListener: () => ({ remove() {} }) },
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

vi.mock("expo-router", async () => {
  const { createElement: h, Fragment, Children, isValidElement } = await import("react");

  const Stack = Object.assign(
    ({ children }: { children?: ReactNode }) => {
      scenario.rootRenders++;

      return h(Fragment, null, children);
    },
    {
      Screen: ({ name }: { name: string }) => h("span", { "data-route": name }),
      Protected: ({
        guard,
        redirectTo,
        children,
      }: {
        guard: boolean;
        redirectTo?: string;
        children?: ReactNode;
      }) => {
        Children.forEach(children, (child) => {
          if (isValidElement<{ name: string }>(child))
            scenario.redirects[child.props.name] = redirectTo;
        });

        return guard ? h(Fragment, null, children) : null;
      },
    },
  );

  return {
    Stack,
    DarkTheme: { colors: {} },
    ThemeProvider: ({ children }: { children?: ReactNode }) => h(Fragment, null, children),
    useLocalSearchParams: () => scenario.params,
    useIsFocused: () => scenario.focused,
    usePathname: () => scenario.pathname,
    router: {
      canGoBack: () => scenario.canGoBack,
      back: () => scenario.asked.push("back"),
      replace: (href: string) => scenario.asked.push(`replace ${href}`),
      push: (href: { pathname: string }) => scenario.asked.push(JSON.stringify(href)),
    },
  };
});

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/reminders/runtime.ts", () => ({ startReminders: () => () => {} }));

vi.mock("../src/reminders/routing.ts", () => ({ useReminderRouting: () => {} }));

vi.mock("../src/play-entry/runtime.ts", () => ({ startPlayEntries: () => () => {} }));

vi.mock("../src/home/index.ts", () => ({ startViewing: () => () => {} }));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const state = store<PlayerState>({ kind: "idle" });

  return {
    player: {
      state,
      media: {
        state: store({
          tracksKnown: false,
          automatic: true,
          remaining: null,
          pip: false,
          pipSupported: true,
          error: null,
          next: null,
        }),
        enterPip: vi.fn(),
        reconcile: vi.fn(),
        cancelNext: vi.fn(),
        watch: vi.fn(),
      },
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
  createRoot(container: Element): { render(node: ReactNode): void; unmount(): void };
};

vi.mock("../src/player/media-controls.tsx", () => ({
  MediaRow: () => null,
  MediaDialog: () => null,
  MediaSheets: () => null,
}));

const { default: Watch } = await import("../src/app/watch.tsx");

const { footOverlay } = await import("../src/navigation/screen.tsx");
const { player } = await import("../src/player/instance.ts");
const { watchHref } = await import("../src/player/intent.ts");

const estuary: PlayIntent = {
  kind: "live",
  sourceId: "source-1",
  channelId: "estuary",
  title: "Estuary Max",
};

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
  act(() => root?.render(createElement(Watch, { offline: scenario.pathname === "/offline/play" })));

  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  scenario.params = {};
  scenario.sources = [];
  scenario.restoring = false;
  scenario.focused = true;
  scenario.canGoBack = true;
  scenario.rootRenders = 0;
  scenario.redirects = {};
  player.media.state.set({
    tracksKnown: false,
    automatic: true,
    remaining: null,
    pip: false,
    pipSupported: true,
    error: null,
    next: null,
  });
  sourceState.set({ kind: "ready", sources: [] });
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
  setLanguage({ locale: "en-US", formats: "en-US" });
  window.document.body.innerHTML = "";
});

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    sources: {
      restore: scenario.restore,
      state: store<import("../src/connect/sources.ts").Sources>({ kind: "ready", sources: [] }),
    },
  };
});

const {
  sources: { state: sourceState },
} = await import("../src/bootstrap/sources.ts");

vi.mock("../src/downloads/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const owner = { state: store({ rows: [], error: null }), start: () => () => {} };

  return { startDownloads: scenario.start, downloads: () => owner };
});

const rootModule = await import("../src/app/_layout.tsx");
const { default: RootLayout } = rootModule;

function renderRoot() {
  sourceState.set(
    scenario.restoring ? { kind: "restoring" } : { kind: "ready", sources: scenario.sources },
  );
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(RootLayout)));

  return container;
}

it("starts downloads during cold restore and keeps Offline outside provider guards", () => {
  scenario.restoring = true;
  scenario.sources = [];
  const stop = vi.fn();
  scenario.start.mockReturnValueOnce(stop);
  const shown = renderRoot();
  expect(scenario.start).toHaveBeenCalled();
  expect(scenario.restore).toHaveBeenCalled();
  expect(scenario.start.mock.invocationCallOrder[0]).toBeLessThan(
    scenario.restore.mock.invocationCallOrder[0]!,
  );
  expect(shown.querySelector("[data-route]")).toBeNull();
  scenario.restoring = false;
  act(() => sourceState.set({ kind: "ready", sources: scenario.sources }));
  expect(
    [...shown.querySelectorAll("[data-route]")].map((el) => el.getAttribute("data-route")),
  ).toEqual(["offline", "connect"]);
  expect(scenario.redirects).toEqual({ "(tabs)": "/connect", watch: "/connect", connect: "/" });
  scenario.sources = [
    { id: "source", kind: "m3u", label: "Source", channels: { kind: "ready", rows: [] } },
  ];
  act(() => sourceState.set({ kind: "ready", sources: scenario.sources }));
  expect(
    [...shown.querySelectorAll("[data-route]")].map((el) => el.getAttribute("data-route")),
  ).toEqual(["offline", "(tabs)", "watch"]);
  act(() => root?.unmount());
  root = null;
  expect(stop).toHaveBeenCalledTimes(1);
});

it("returns a providerless file from the mini player to the unprotected file route", () => {
  scenario.restoring = false;
  scenario.sources = [];
  scenario.pathname = "/connect";
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  const shown = renderRoot();
  expect(shown.textContent).toContain("Downloaded");

  const overlay = shown.querySelector(
    'button[aria-label="Saved movie, Downloaded"]',
  )?.parentElement;

  expect((overlay as HTMLElement | null)?.style.bottom).toBe("0px");
  expect((overlay as HTMLElement | null)?.style.left).toBe("0px");
  act(() => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
  expect(shown.textContent).toContain("Gedownload");
  act(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  expect(watchHref(file)).toEqual({ pathname: "/offline/play" });
  const button = shown.querySelector("button[aria-label='Saved movie, Downloaded']");
  expect(button).not.toBeNull();
  act(() => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  expect(scenario.asked).toEqual([JSON.stringify({ pathname: "/offline/play" })]);
  scenario.pathname = "/offline/play";
  act(() => root?.render(createElement(RootLayout)));
  expect(shown.textContent).not.toContain("Saved movie");
});

it("keeps the current local file when an offline URL carries a provider play parameter", () => {
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  scenario.pathname = "/offline/play";
  const shown = open(estuary);
  expect(shown.textContent).toContain("Downloaded");
  expect(scenario.played).toEqual([]);
  expect(player.state.get()).toMatchObject({ intent: file });
  act(() => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
  expect(shown.textContent).toContain("Gedownload");
});

vi.mock("../src/live/chrome.tsx", () => ({ Dialog: () => null, TextButton: () => null }));

const { default: OfflinePlay } = await import("../src/app/offline/play.tsx");

it("refuses provider playback on the unprotected file route and returns to Downloads", () => {
  player.state.set(playing(estuary));
  scenario.pathname = "/offline/play";
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  expect(container.textContent).toBe("");
  expect(scenario.asked).toEqual(["replace /offline"]);
  expect(scenario.played).toEqual([]);
});

it("reconciles offline Watch through PiP and restores its controls", () => {
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  scenario.pathname = "/offline/play";
  const shown = open(null);
  const pip = shown.querySelector('button[aria-label="Picture in picture"]');
  expect(pip).not.toBeNull();
  act(() => pip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  expect(player.media.enterPip).toHaveBeenCalledOnce();
  expect(player.media.reconcile).toHaveBeenCalled();
  expect(player.media.watch).toHaveBeenCalledWith(true);
  expect(shown.textContent).toContain("Downloaded");
  act(() => player.media.state.set({ ...player.media.state.get(), pip: true }));
  expect(shown.textContent).not.toContain("Downloaded");
  act(() => player.media.state.set({ ...player.media.state.get(), pip: false }));
  expect(shown.textContent).toContain("Downloaded");
  expect(scenario.played).toEqual([]);
  act(() => root?.unmount());
  root = null;
  expect(player.media.watch).toHaveBeenLastCalledWith(false);
});

it("restores and renders even when the Transfers module cannot start", () => {
  scenario.restoring = true;
  scenario.start.mockImplementationOnce(() => {
    throw new Error("Transfers unavailable");
  });
  scenario.restore.mockImplementationOnce(async () => {
    sourceState.set({ kind: "ready", sources: [] });
  });
  const shown = renderRoot();
  expect(scenario.restore).toHaveBeenCalledOnce();
  expect(shown.querySelector('[data-route="connect"]')).not.toBeNull();
});

it("does not replay a retained provider Watch when leaving Offline", () => {
  scenario.focused = false;
  scenario.pathname = "/offline/play";
  scenario.params = { play: JSON.stringify(estuary) };
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(Watch)));
  scenario.pathname = "/offline";
  act(() => root?.render(createElement(Watch)));
  expect(scenario.played).toEqual([]);
  expect(player.state.get()).toMatchObject({ intent: file });
});

it.each([true, false])("leaves a stopped copy once with Back available: %s", (back) => {
  scenario.canGoBack = back;
  player.state.set(playing({ kind: "file", path: "/private/copy", title: "Saved" }));
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  act(() => player.state.set({ kind: "idle" }));
  expect(scenario.asked).toEqual([back ? "back" : "replace /offline"]);
  expect(player.media.cancelNext).toHaveBeenCalled();
});

it.each([true, false])(
  "hands file notification links to OfflinePlay, signed in: %s",
  (signedIn) => {
    scenario.sources = signedIn
      ? [{ id: "source", kind: "m3u", label: "Source", channels: { kind: "ready", rows: [] } }]
      : [];
    player.state.set(playing({ kind: "file", path: "/private/copy", title: "Saved" }));
    const shown = renderRoot();
    expect(shown.querySelector('[data-route="watch"]')).not.toBeNull();
    act(() => root?.unmount());
    open(null);
    expect(scenario.asked).toEqual(["replace /offline/play"]);
  },
);

it("keeps the file on last-provider removal, lands on Connect, and ignores position ticks at root", () => {
  scenario.pathname = "/connect";
  scenario.sources = [
    { id: "source", kind: "m3u", label: "Source", channels: { kind: "ready", rows: [] } },
  ];
  const file: PlayIntent = { kind: "file", path: "/private/copy", title: "Saved" };
  player.state.set(playing(file));
  const shown = renderRoot();
  act(() => sourceState.set({ kind: "ready", sources: [] }));
  expect(scenario.redirects).toEqual({ "(tabs)": "/connect", watch: "/connect", connect: "/" });
  expect(shown.querySelector('[data-route="(tabs)"]')).toBeNull();
  expect(shown.textContent).toContain("Saved");
  const renders = scenario.rootRenders;
  act(() => player.state.set(playing(file, { positionMs: 1000 })));
  expect(scenario.rootRenders).toBe(renders);
});

it("ignores a retained provider parameter in OfflinePlay itself", () => {
  scenario.params = { play: JSON.stringify(estuary) };
  player.state.set(playing({ kind: "file", path: "/private/copy", title: "Saved" }));
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  expect(scenario.played).toEqual([]);
  expect(container.textContent).toContain("Downloaded");
});

it("leaves only once when a stopped offline screen regains focus", () => {
  player.state.set(playing({ kind: "file", path: "/private/copy", title: "Saved" }));
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  scenario.focused = false;
  act(() => root?.render(createElement(OfflinePlay)));
  act(() => player.state.set({ kind: "idle" }));
  expect(scenario.asked).toEqual([]);
  scenario.focused = true;
  act(() => root?.render(createElement(OfflinePlay)));
  expect(scenario.asked).toEqual(["back"]);
});

it("does not seed Connect ahead of signed-in cold-start targets", () => {
  expect(rootModule).not.toHaveProperty("unstable_settings.anchor");
});

it("R2a: a retained provider Watch regaining focus over a playing copy does not replay", () => {
  scenario.params = { play: JSON.stringify(estuary) };
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(Watch)));
  expect(scenario.played).toHaveLength(1);
  scenario.focused = false;
  act(() => root?.render(createElement(Watch)));
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  act(() => player.state.set(playing(file)));
  scenario.focused = true;
  act(() => root?.render(createElement(Watch)));
  expect(scenario.played).toHaveLength(1);
  expect(player.state.get()).toMatchObject({ intent: file });
});

it("R2b: a provider Watch stopped while covered leaves on refocus without replaying", () => {
  scenario.params = { play: JSON.stringify(estuary) };
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(Watch)));
  scenario.focused = false;
  act(() => root?.render(createElement(Watch)));
  act(() => player.state.set({ kind: "idle" }));
  scenario.focused = true;
  act(() => root?.render(createElement(Watch)));
  expect(scenario.asked).toEqual(["back"]);
  expect(scenario.played).toHaveLength(1);
  expect(player.state.get().kind).toBe("idle");
});

it("handles changed provider parameters and defers a new intent until first focus", () => {
  scenario.focused = false;
  open(estuary);
  expect(scenario.played).toEqual([]);
  scenario.focused = true;
  act(() => root?.render(createElement(Watch)));
  expect(scenario.played).toEqual([estuary]);
  const next: PlayIntent = { ...estuary, title: "Next", channelId: "next" };
  scenario.params = { play: JSON.stringify(next) };
  act(() => root?.render(createElement(Watch)));
  expect(scenario.played).toEqual([estuary, next]);
});

it("refuses a provider replacing a retained copy, and exits only once when focused", () => {
  player.state.set(playing({ kind: "file", path: "/private/copy", title: "Saved" }));
  const container = window.document.createElement("div");
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  scenario.focused = false;
  act(() => root?.render(createElement(OfflinePlay)));
  act(() => player.state.set(playing(estuary)));
  expect(container.textContent).not.toContain("Estuary Max");
  expect(scenario.asked).toEqual([]);
  scenario.focused = true;
  act(() => root?.render(createElement(OfflinePlay)));
  act(() => player.state.set(playing(estuary, { positionMs: 1000 })));
  expect(scenario.asked).toEqual(["replace /offline"]);
  expect(player.state.get()).toMatchObject({ intent: estuary });
  expect(scenario.played).toEqual([]);
});
