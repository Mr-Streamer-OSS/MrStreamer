import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Watch as the viewer meets it: it plays the intent its link names unless that already plays,
// leaves when it names none and nothing plays, and words a failure with Try again. Watch renders
// with React DOM on a happy-dom window; React Native's views are elements, the router records
// what it is asked, and the player is a store with play() that records each intent.

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  asked: [] as string[],
  played: [] as unknown[],
  retries: 0,
}));

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");
  type Props = { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void };
  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, onPress }: Props) =>
      h(tag, { "aria-label": accessibilityLabel, onClick: onPress }, children);
  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    StatusBar: () => null,
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
  usePathname: () => "/watch",
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
      async retry() {
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
  createRoot(container: object): { render(node: unknown): void; unmount(): void };
};
const { default: Watch } = await import("../src/app/watch.tsx");
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
  scenario.asked = [];
  scenario.played = [];
  scenario.retries = 0;
  player.state.set({ kind: "idle" });
});

afterEach(() => {
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
    act(() => (retry as unknown as { click(): void }).click());
    expect(scenario.retries).toBe(1);
    expect(scenario.played).toEqual([]);
  });
});
