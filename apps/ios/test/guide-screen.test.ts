import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { Catalogue } from "../src/account.ts";
import type { Channel } from "../src/library.ts";
import type { Query, Result } from "../src/guide-native.ts";
import type { createGuide } from "../src/guide.ts";
import { currentSource, dropSource, setSource } from "../src/sources.ts";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import type { guideFixture } from "./native-guide.ts";
import { finish } from "@mrstreamer/core/steps";
import { combine, partSteps } from "../src/library.ts";

const state = vi.hoisted(() => ({
  catalogue: { kind: "loading" } as Catalogue,
  owner: null as ReturnType<typeof createGuide> | null,
  fixture: null as ReturnType<typeof guideFixture> | null,
  params: {} as { channel?: string; detail?: string },
  focused: true,
  focusContext: null as React.Context<boolean> | null,
  window: { width: 390, height: 844, fontScale: 1 },
  /** What VoiceOver was moved to. */
  focus: [] as string[],
  /** Live's stack, as navigation's state has it under the tabs. */
  stack: undefined as
    { key: string; index: number; routes: { name: string; params?: object }[] } | undefined,
  visible: 12,
  /** The first row a list shows, as scrolled. */
  first: 0,
  did: [] as unknown[],
  queries: [] as {
    ids: readonly string[];
    mode: string;
    from: number;
    until: number;
    after: number;
  }[],
  answer: null as
    | ((
        mode: string,
        ids: readonly string[],
        from: number,
        until: number,
        after: number,
        lease: string,
      ) => Promise<Result<Query>>)
    | null,
}));
vi.mock("../src/guide.ts", async (original) => {
  const actual = await original<typeof import("../src/guide.ts")>();
  const { guideFixture } = await import("./native-guide.ts");
  state.fixture = guideFixture();
  state.fixture.native.query = async (
    _lease,
    _generation,
    _job,
    ids,
    _at,
    mode,
    from,
    until,
    after,
  ) => {
    state.queries.push({ ids, mode, from, until, after });
    return state.answer
      ? state.answer(mode, ids, from, until, after, _lease)
      : { kind: "ok", value: { guideId: null, rows: [], more: false } };
  };
  state.owner = actual.createGuide(
    () => state.fixture!.native,
    () => Date.now(),
    (await import("../src/sources.ts")).currentSource,
  );
  return { ...actual, guide: state.owner };
});
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-router", async () => {
  const { createContext, useContext } = await import("react");
  state.focusContext = createContext(true);
  const navigation = { dispatch: (action: unknown) => state.did.push(action) };
  return {
    useIsFocused: () => useContext(state.focusContext!) && state.focused,
    useLocalSearchParams: () => state.params,
    useNavigation: () => navigation,
    useRootNavigationState: () => state.stack,
    router: {
      push: (href: unknown) => state.did.push(href),
      navigate: (href: unknown) => state.did.push(href),
      setParams: (params: unknown) => state.did.push({ setParams: params }),
    },
  };
});
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => state.catalogue,
  useRoster: () => ({ kind: "ready", members: [] }),
  playChannel: (channel: Channel, _place: string, options: { watch: boolean }) =>
    state.did.push({ play: channel.key, ...options }),
  retry: () => {},
  retryChannels: () => {},
  reloadAllChannels: () => {},
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (tab: string, name: string) => (tab === "live" ? `/live/${name}` : `/${name}`),
  tabStack: (_state: unknown, tab: string) => (tab === "live" ? state.stack : undefined),
}));
vi.mock("../src/loading.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Docked: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    useDockInset: () => 0,
    libraryStatus: () => null,
    loadingStatus: () => null,
    PlaceholderRows: () => null,
    Placeholders: () => null,
    Shape: () => null,
  };
});
vi.mock("../src/favourites.ts", () => ({
  useFavouriteKeys: () => new Set(),
  starChannel: () => {},
  useFavourites: () => null,
}));
vi.mock("../src/favourites-screen.tsx", () => ({ FavouritesEntry: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({
      label,
      onPress,
      testID,
    }: {
      label: string;
      onPress: () => void;
      testID: string;
    }) => createElement("button", { onClick: onPress, "data-testid": testID }, label),
  };
});
vi.mock("../src/playback.ts", () => ({
  channelStatus: () => null,
  usePlayback: () => ({ phase: { kind: "idle" }, watch: false }),
  player: () => ({}),
  retry: () => {},
  setMuted: () => {},
  openWatch: () => state.did.push("watch"),
}));
vi.mock("../src/storage.ts", () => ({ useSavedState: () => ({}), writeState: () => {} }));
vi.mock("../src/resume.ts", () => ({
  useContinueWatching: () => [],
  openDetails: () => {},
  resume: () => {},
}));
vi.mock("../src/viewing.ts", () => ({ removeFromContinue: () => {} }));
vi.mock("../src/watchlist.ts", () => ({ useWatchlist: () => [], watchlistRows: () => [] }));
vi.mock("../src/titles.ts", () => ({
  useCollections: () => null,
  useTitleLists: () => ({ kind: "failed" }),
  useHasTitles: () => false,
  useMetadataVersion: () => 0,
  titlesWorkedOut: () => false,
  named: () => "",
}));
vi.mock("expo-video", () => ({ VideoView: () => null }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", async () => {
  const { createElement, useEffect, isValidElement } = await import("react");
  const { reactNative } = await import("./react-native.ts");
  type Props = {
    children?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { now?: number };
    ref?: React.Ref<HTMLDivElement>;
  };
  const box = ({ children, testID, accessibilityRole, accessibilityValue, ref }: Props) =>
    createElement(
      "div",
      {
        ref,
        "data-testid": testID,
        role: accessibilityRole,
        "aria-valuenow": accessibilityValue?.now,
      },
      children,
    );
  const node = (value: unknown) =>
    !value ? null : isValidElement(value) ? value : createElement(value as React.ComponentType);
  return {
    ...reactNative,
    AccessibilityInfo: {
      ...reactNative.AccessibilityInfo,
      sendAccessibilityEvent: (shown: { textContent: string | null }, event: string) =>
        state.focus.push(`${event} ${shown.textContent ?? ""}`),
    },
    useWindowDimensions: () => state.window,
    View: box,
    ScrollView: box,
    Text: box,
    FlatList: <T>({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
      ListEmptyComponent,
      onViewableItemsChanged,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      ListHeaderComponent?: unknown;
      ListFooterComponent?: unknown;
      ListEmptyComponent?: unknown;
      testID?: string;
      onViewableItemsChanged?: (info: {
        viewableItems: { item: T; isViewable: boolean }[];
      }) => void;
    }) => {
      useEffect(() => {
        onViewableItemsChanged?.({
          viewableItems: data
            .slice(state.first, state.first + state.visible)
            .map((item) => ({ item, isViewable: true })),
        });
      }, [data, onViewableItemsChanged, state.first]);
      return createElement(
        "div",
        { "data-testid": testID },
        node(ListHeaderComponent),
        data.length
          ? data.map((item, index) =>
              createElement("div", { key: index }, renderItem({ item, index })),
            )
          : node(ListEmptyComponent),
        node(ListFooterComponent),
      );
    },
  };
});
const { LiveHome, LiveTab } = await import("../src/live-screen.tsx");
const { splitAt } = await import("../src/ui.tsx");
const { default: Home } = await import("../src/app/(tabs)/(home)/index.tsx");
const { ScheduleScreen, ProgrammeScreen, Programme } = await import("../src/guide-screen.tsx");
const { programmeRange } = await import("../src/guide-ui.tsx");
let root: ReturnType<typeof createRoot>;
let container: ReturnType<typeof document.createElement>;
const at = new Date(2026, 9, 24, 12).getTime();
const current: Programme = {
  title: "Actual ocean programme",
  start: at - 30 * 60_000,
  stop: at + 30 * 60_000,
  description: "A real fixture description",
};
const next: Programme = {
  title: "Actual next programme",
  start: current.stop,
  stop: current.stop + 3600_000,
  description: null,
};
const owner = () => {
  if (!state.owner) throw new Error("Owner missing");
  return state.owner;
};
const fixture = () => {
  if (!state.fixture) throw new Error("Fixture missing");
  return state.fixture;
};
function part(id = "a", count = 3) {
  return finish(
    partSteps({
      subscriptionId: id,
      catalogue: {
        categories: [{ id: "news", name: "NL|News" }],
        channels: Array.from({ length: count }, (_, i) => ({
          id: `${i + 1}`,
          name: `Channel ${i + 1}`,
          categoryIds: ["news"],
          guideId: i === 1 ? null : `trusted-${i + 1}`,
          logoUrl: null,
          adult: false,
          number: null,
          catchupDays: null,
        })),
      },
    }),
  );
}
async function install(id = "a", count = 3, age = 0) {
  const p = part(id, count);
  fixture().control.activations.set(id, {
    lease: `lease-${id}`,
    generation: { id: `db-${id}`, fetchedAt: Date.now() - age, until: Date.now() + 7 * 86400_000 },
  });
  await owner().restore([id]);
  owner().setPart(p);
  state.catalogue = { kind: "ready", failing: [], library: combine([{ label: id, part: p }]) };
}
async function draw(node: React.ReactNode) {
  await React.act(async () => {
    root.render(node);
  });
}
async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}
async function click(
  label: string,
  within: Pick<typeof container, "querySelectorAll"> = container,
) {
  const button = [...within.querySelectorAll("button")].find(
    (button) => button.textContent === label || button.getAttribute("data-testid") === label,
  );
  if (!button) throw new Error(`Missing button ${label}: ${container.textContent}`);
  await React.act(async () => button.click());
  await settle();
}
function answer(rows: readonly Programme[], more = false): Result<Query> {
  return { kind: "ok", value: { guideId: "trusted-1", rows, more } };
}
const tick = async () => {
  await React.act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  await settle();
};
function holdQueries(reply: NonNullable<typeof state.answer>) {
  const releases: (() => void)[] = [];
  let holding = true;
  state.answer = (...args) =>
    holding
      ? new Promise((resolve, reject) =>
          releases.push(() => {
            void reply(...args).then(resolve, reject);
          }),
        )
      : reply(...args);
  return {
    release: async () => {
      await React.act(async () => {
        holding = false;
        releases.splice(0).forEach((release) => release());
      });
      await settle();
    },
  };
}
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(at);
  for (const id of ["a", "b", "c"]) dropSource(id);
  state.focused = true;
  state.window = { width: 390, height: 844, fontScale: 1 };
  state.focus = [];
  state.stack = undefined;
  state.visible = 12;
  state.first = 0;
  state.params = {};
  state.did = [];
  state.queries = [];
  for (const id of ["a", "b", "c"]) await fixture().native.forget(id);
  fixture().control.activations.clear();
  state.answer = async (_mode, ids) =>
    ids[0] === "trusted-1" ? answer([current, next]) : answer([]);
  await install();
  owner().foreground();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  container.remove();
  owner().background();
  vi.useRealTimers();
});

describe("selected A public guide UI with the real guide owner", () => {
  it("shows actual Home programmes and keeps tile preview separate from Schedule", async () => {
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(current.title);
    expect(container.textContent).toContain(next.title);
    expect(container.querySelector('[data-testid="home-stage"]')?.textContent).toContain(
      current.title,
    );
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "50",
    );
    await click("home-channel-a:1");
    expect(state.did).toContainEqual({ play: "a:1", watch: false });
    state.did = [];
    await click("home-schedule-a:1");
    expect(state.did).toEqual([{ pathname: "/schedule", params: { channel: "a:1" } }]);
  });

  it("shows actual Live programmes and category fallback, with Guide separate from Play", async () => {
    await draw(React.createElement(LiveHome));
    await settle();
    await click("All");
    expect(container.textContent).toContain(current.title);
    expect(container.querySelector('[data-testid="channel-a:2"]')?.textContent).toContain("News");
    state.did = [];
    await click("channel-a:1");
    expect(state.did).toEqual([{ play: "a:1", watch: true }]);
    await click("Guide");
    expect(container.textContent).toContain(current.title);
    state.did = [];
    await click("schedule-a:1");
    expect(state.did).toEqual([{ pathname: "/live/schedule", params: { channel: "a:1" } }]);
  });

  it("pages the schedule, inspects one programme and plays only through Watch live", async () => {
    state.params = { channel: "a:1" };
    state.answer = async (mode, _ids, _from, _until, after) =>
      mode === "detail" ? answer([current]) : after < 0 ? answer([current], true) : answer([next]);
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(state.did).toEqual([]);
    await click("Show more");
    expect(container.textContent).toContain(next.title);
    await click(`programme-${current.start}`);
    const route = state.did[0] as { pathname: string; params: { channel: string; detail: string } };
    expect(route.pathname).toBe("/live/programme");
    expect(route.params.detail).toMatch(/^g/);
    state.params = route.params;
    await draw(React.createElement(ProgrammeScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain(current.description);
    expect(state.did).toHaveLength(1);
    await click("Watch live");
    expect(state.did[1]).toEqual({ play: "a:1", watch: true });
    // Returning to the existing Schedule screen reads its original channel without playing.
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("Today");
    expect(state.did).toHaveLength(2);
  });

  it("retires a held day read on day changes and provider replacement, and settles unavailable reads", async () => {
    state.params = { channel: "a:1" };
    let release: ((value: Result<Query>) => void) | undefined;
    state.answer = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    await settle();
    const first = state.queries.at(-1)!;
    state.answer = async () => answer([]);
    await click("Next day");
    expect(state.queries.at(-1)!.from).toBe(first.until);
    await React.act(async () => {
      release?.(answer([current]));
    });
    await settle();
    expect(container.textContent).not.toContain(current.title);
    expect(container.textContent).toContain("No programme information");
    await React.act(async () => {
      await install("b");
    });
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    expect(container.textContent).toContain("Channel unavailable");
    state.params = { channel: "b:1" };
    state.answer = async () => {
      throw new Error("private error must not escape");
    };
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    await settle();
    expect(container.textContent).toContain("Guide unavailable");
    expect(container.textContent).not.toContain("private error");
  });

  it("keeps stale last-good programmes and has honest cold, gap and failed states", async () => {
    await install("a", 3, 7 * 3600_000);
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("Guide may be out of date");
    expect(container.textContent).toContain(current.title);
    state.answer = async () => answer([]);
    await React.act(async () => owner().foreground());
    await settle();
    expect(container.textContent).toContain(current.title);
    await React.act(async () => owner().forget("a"));
    await settle();
    expect(container.textContent).toContain("No programme information");
    expect(container.textContent).not.toContain("Loading schedule");
  });

  it("bounds Live to 40 visible keys and Home to 12, with no per-row clocks", async () => {
    await install("a", 75);
    state.visible = 60;
    await draw(React.createElement(LiveHome));
    await settle();
    state.queries = [];
    await click("All");
    expect(state.queries.length).toBeLessThanOrEqual(52);
    expect(new Set(state.queries.flatMap((query) => query.ids))).toHaveLength(39);
    expect(state.queries.some((query) => query.ids.includes("trusted-41"))).toBe(false);
    state.queries = [];
    await draw(React.createElement(Home));
    await settle();
    expect(state.queries.length).toBeLessThanOrEqual(12);
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(state.queries.length).toBeLessThanOrEqual(24);
  });

  it("reconciles Today at midnight and issues local calendar bounds across DST", async () => {
    state.params = { channel: "a:1" };
    state.answer = async () => answer([]);
    vi.setSystemTime(new Date(2026, 9, 24, 23, 59, 30));
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    const before = state.queries.at(-1)!;
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(state.queries.at(-1)!.from).toBe(before.until);
    expect(container.textContent).toContain("Today");
    const oldZone = process.env.TZ;
    process.env.TZ = "Europe/Amsterdam";
    try {
      vi.setSystemTime(new Date(2026, 9, 25, 12));
      await React.act(async () => owner().foreground());
      await settle();
      let query = state.queries.at(-1)!;
      expect(query.until - query.from).toBe(25 * 3600_000);
      vi.setSystemTime(new Date(2026, 2, 29, 12));
      await React.act(async () => owner().foreground());
      await settle();
      // Restore a currently usable fixture generation for the spring clock.
      await React.act(async () => install());
      await settle();
      query = state.queries.at(-1)!;
      expect(query.until - query.from).toBe(23 * 3600_000);
    } finally {
      if (oldZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldZone;
    }
  });
  it("navigates real local day boundaries when midnight is skipped", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      vi.setSystemTime(new Date(2026, 8, 6, 12));
      state.params = { channel: "a:1" };
      state.answer = async () => answer([]);
      await install();
      await draw(React.createElement(ScheduleScreen, { origin: "live" }));
      await settle();
      const from = new Date(2026, 8, 6).getTime();
      const until = new Date(2026, 8, 7).getTime();
      expect(state.queries.at(-1)).toMatchObject({ from, until });
      expect(until - from).toBe(23 * 3600_000);
      expect(container.textContent).not.toContain("Guide unavailable");
      await click("Next day");
      expect(state.queries.at(-1)).toMatchObject({
        from: until,
        until: new Date(2026, 8, 8).getTime(),
      });
      await click("Previous day");
      expect(state.queries.at(-1)).toMatchObject({ from, until });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("retires held listings on provider removal and never paints the old channel after replacement", async () => {
    const releases: ((value: Result<Query>) => void)[] = [];
    state.answer = (_mode, _ids, _from, _until, _after, lease) =>
      lease === "lease-a"
        ? new Promise((resolve) => {
            releases.push(resolve);
          })
        : Promise.resolve(answer([]));
    await draw(React.createElement(Home));
    await settle();
    await React.act(async () => {
      await owner().forget("a");
      await install("b");
    });
    state.answer = async () => answer([]);
    await draw(React.createElement(Home));
    await settle();
    await React.act(async () => {
      for (const release of releases) release(answer([current]));
    });
    await settle();
    expect(container.textContent).not.toContain(current.title);
    expect(container.querySelector('[data-testid="home-channel-b:1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-channel-a:1"]')).toBeNull();
  });

  it("uses the owner minute tick for progress and drops subscriptions and reads on blur", async () => {
    await draw(React.createElement(Home));
    await settle();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "50",
    );
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "52",
    );
    state.focused = false;
    await draw(React.createElement(Home));
    await settle();
    const count = state.queries.length;
    await React.act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await settle();
    expect(state.queries).toHaveLength(count);
    state.focused = true;
    await draw(React.createElement(Home));
    await settle();
    expect(state.queries.length).toBeGreaterThan(count);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "55",
    );
  });

  it("shows a real next programme in a gap without fabricated progress and settles read-admission refusal", async () => {
    state.answer = async () => answer([next]);
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(next.title);
    expect(container.querySelector('[data-testid="home-stage"]')?.textContent).toContain(
      next.title,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain("News");
    fixture().native.revoke("a");
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("No programme information");
    expect(container.textContent).not.toContain("Loading schedule");
  });
  it("shows unavailable guide recovery through existing settings without inventing a retry queue", async () => {
    const restore = fixture().native.restore;
    try {
      fixture().native.restore = async () => {
        throw new Error("private native description");
      };
      await install("c");
      await draw(React.createElement(LiveHome));
      await settle();
      await click("Guide");
      expect(container.textContent).toContain("Guide unavailable");
      expect(container.textContent).not.toContain("private native description");
      await click("Provider settings");
      expect(state.did).toEqual(["/live/settings"]);
    } finally {
      fixture().native.restore = restore;
    }
  });

  it.each([
    ["Home", Home],
    ["Live", LiveHome],
  ] as const)(
    "keeps settled %s programmes mounted through a held minute read and failure",
    async (name, Screen) => {
      await draw(React.createElement(Screen));
      await settle();
      if (name === "Live") await click("All");
      const gate = holdQueries(async () =>
        answer([{ ...current, title: "Updated broadcast" }, next]),
      );
      await tick();
      expect(container.textContent).toContain(current.title);
      expect(container.textContent).not.toContain("Loading programme");
      await gate.release();
      expect(container.textContent).toContain("Updated broadcast");
      state.answer = async () => {
        throw new Error("private read failure");
      };
      await tick();
      expect(container.textContent).toContain("Updated broadcast");
      expect(container.textContent).not.toContain("private read failure");
    },
  );

  it("retains the represented schedule span across a held tick, mounted Programme and Back, then replaces both pages atomically", async () => {
    state.params = { channel: "a:1" };
    const pages = async (
      _mode: string,
      _ids: readonly string[],
      _from: number,
      _until: number,
      after: number,
    ) => (after < 0 ? answer([current], true) : answer([next]));
    state.answer = pages;
    let inspection = false;
    const stack = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          state.focusContext!.Provider,
          { value: !inspection },
          React.createElement(ScheduleScreen, { origin: "home" }),
        ),
        inspection
          ? React.createElement(
              state.focusContext!.Provider,
              { value: true },
              React.createElement(ProgrammeScreen, { origin: "home" }),
            )
          : null,
      );
    await draw(stack());
    await settle();
    await click("Next day");
    const representedDay = state.queries.at(-1)!.from;
    await click("Show more");
    const schedule = container.querySelector('[data-testid="guide-schedule"]')!;
    const row = schedule.querySelector(`[data-testid="programme-${next.start}"]`);
    let gate = holdQueries(pages);
    await tick();
    expect(schedule.textContent).toContain(current.title);
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.querySelector(`[data-testid="programme-${next.start}"]`)).toBe(row);
    await gate.release();
    expect(schedule.textContent).toContain(next.title);
    await click(`programme-${current.start}`);
    state.params = (state.did.at(-1) as { params: typeof state.params }).params;
    state.answer = async (mode, ids, from, until, after) =>
      mode === "detail" ? answer([current]) : pages(mode, ids, from, until, after);
    inspection = true;
    await draw(stack());
    await settle();
    expect(schedule.textContent).toContain(next.title);
    const dayReads = state.queries.filter((query) => query.mode === "day").length;
    await tick();
    expect(state.queries.filter((query) => query.mode === "day")).toHaveLength(dayReads);
    gate = holdQueries(pages);
    inspection = false;
    await draw(stack());
    await settle();
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.textContent).not.toContain("Loading schedule");
    expect(state.queries.filter((query) => query.mode === "day").at(-1)!.from).toBe(representedDay);
    await gate.release();
    expect(schedule.textContent).toContain(next.title);
    let releaseSecond: (() => void) | undefined;
    state.answer = async (_mode, _ids, _from, _until, after) =>
      after < 0
        ? answer([{ ...current, title: "New first page" }], true)
        : new Promise((resolve) => {
            releaseSecond = () => resolve(answer([{ ...next, title: "New second page" }]));
          });
    const activation = fixture().control.activations.get("a")!;
    fixture().control.activations.set("a", {
      ...activation,
      generation: {
        id: "new-generation",
        fetchedAt: Date.now() + 1,
        until: Date.now() + 86400_000,
      },
    });
    await React.act(async () => {
      await owner().restore(["a"]);
    });
    await settle();
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.textContent).not.toContain("New first page");
    expect(releaseSecond).toBeDefined();
    await React.act(async () => releaseSecond?.());
    await settle();
    expect(schedule.textContent).toContain("New first page");
    expect(schedule.textContent).toContain("New second page");
    expect(schedule.textContent).not.toContain(current.title);
    expect(schedule.textContent).not.toContain(next.title);
    state.answer = async () => {
      throw new Error("private refresh error");
    };
    await tick();
    expect(schedule.textContent).toContain("New second page");
    expect(schedule.textContent).toContain("Couldn't update schedule");
  });

  it("fences source replacement with the same catalogue and retires held answers from the previous login", async () => {
    const provider = xtreamProvider(
      { server: "https://fixture.test", username: "fixture", password: "canary" },
      { userAgent: "fixture" },
    );
    await React.act(async () => {
      setSource("a", { revision: 1, provider, login: [] });
      await owner().attach("a");
    });
    const catalogue = state.catalogue;
    const oldLease = fixture().control.activations.get("a")!.lease;
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(current.title);
    const gate = holdQueries(async (_mode, _ids, _from, _until, _after, lease) =>
      answer([
        { ...current, title: lease === oldLease ? "Retired source title" : "New source title" },
      ]),
    );
    await tick();
    await React.act(async () => {
      setSource("a", { revision: 2, provider, login: [] });
      await owner().attach("a");
    });
    await settle();
    expect(state.catalogue).toBe(catalogue);
    expect(container.textContent).not.toContain(current.title);
    await gate.release();
    expect(container.textContent).toContain("New source title");
    expect(container.textContent).not.toContain("Retired source title");
    expect(currentSource("a")?.revision).toBe(2);
  });

  it.each([true, false])(
    "keeps separate provider lines on two providers, populated guide: %s",
    async (populated) => {
      const a = part("a"),
        b = part("b");
      state.answer = async () => answer(populated ? [current, next] : []);
      fixture().control.activations.set("b", {
        lease: "lease-b",
        generation: { id: "db-b", fetchedAt: Date.now(), until: Date.now() + 86400_000 },
      });
      await owner().restore(["a", "b"]);
      owner().setPart(a);
      owner().setPart(b);
      state.catalogue = {
        kind: "ready",
        failing: [],
        library: combine([
          { label: "line.alpha-tv.example", part: a },
          { label: "line.beta-tv.example", part: b },
        ]),
      };
      await draw(React.createElement(LiveHome));
      await settle();
      await click("All");
      state.did = [];
      for (const [id, label] of [
        ["a", "line.alpha-tv.example"],
        ["b", "line.beta-tv.example"],
      ] as const) {
        const row = container.querySelector(`[data-testid="channel-${id}:1"]`)!;
        if (populated) expect(row.textContent).toContain(current.title);
        expect(row.textContent).toContain(label);
        expect(row.getAttribute("aria-label")).toContain(label);
        expect(row.getAttribute("aria-label")!.split(label)).toHaveLength(2);
        if (populated) expect(row.getAttribute("aria-label")).toContain(current.title);
        await click(`channel-${id}:1`);
        expect(state.did).toContainEqual({ play: `${id}:1`, watch: true });
      }
      await click("Guide");
      for (const [id, label] of [
        ["a", "line.alpha-tv.example"],
        ["b", "line.beta-tv.example"],
      ] as const) {
        expect(
          container.querySelector(`[data-testid="schedule-${id}:1"]`)?.getAttribute("aria-label"),
        ).toContain(label);
        if (populated)
          expect(
            container
              .querySelector(`[data-testid="grid-${id}:1-${current.start}"]`)
              ?.getAttribute("aria-label"),
          ).toContain(label);
        await click(`schedule-${id}:1`);
        expect(state.did).toContainEqual({
          pathname: "/live/schedule",
          params: { channel: `${id}:1` },
        });
      }
      await draw(React.createElement(Home));
      await settle();
      state.did = [];
      for (const [id, label] of [
        ["a", "line.alpha-tv.example"],
        ["b", "line.beta-tv.example"],
      ] as const) {
        const tile = container.querySelector(`[data-testid="home-channel-${id}:1"]`)!;
        if (populated) expect(tile.textContent).toContain(current.title);
        expect(tile.textContent).toContain(label);
        expect([...tile.querySelectorAll("div")].some((line) => line.textContent === label)).toBe(
          true,
        );
        expect(tile.getAttribute("aria-label")).toContain(label);
        if (populated) expect(tile.getAttribute("aria-label")).toContain(current.title);
        expect(
          container
            .querySelector(`[data-testid="home-schedule-${id}:1"]`)
            ?.getAttribute("aria-label"),
        ).toContain(label);
        await click(`home-channel-${id}:1`);
        await click(`home-schedule-${id}:1`);
        expect(state.did).toContainEqual({ play: `${id}:1`, watch: false });
        expect(state.did).toContainEqual({ pathname: "/schedule", params: { channel: `${id}:1` } });
      }
    },
  );

  it("keeps inspected programme text mounted across a held minute read and settles retired details", async () => {
    state.params = { channel: "a:1" };
    state.answer = async () => answer([current]);
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    await click(`programme-${current.start}`);
    state.params = (state.did.at(-1) as { params: typeof state.params }).params;
    await draw(React.createElement(ProgrammeScreen, { origin: "live" }));
    await settle();
    const detail = container.querySelector('[data-testid="guide-programme"]')!;
    const text = detail.textContent;
    const gate = holdQueries(async () => answer([current]));
    await tick();
    expect(detail.textContent).toBe(text);
    expect(detail.textContent).toContain(current.description);
    await gate.release();
    fixture().control.activations.set("a", {
      ...fixture().control.activations.get("a")!,
      generation: { id: "replacement", fetchedAt: Date.now() + 1, until: Date.now() + 86400_000 },
    });
    await React.act(async () => owner().restore(["a"]));
    await settle();
    expect(detail.textContent).toContain("Programme unavailable");
    expect(detail.textContent).not.toContain("Loading programme");
  });

  it("does not append a held Show more reply over a refresh and keeps known rows after failed pagination", async () => {
    state.params = { channel: "a:1" };
    const pages = async (
      _mode: string,
      _ids: readonly string[],
      _from: number,
      _until: number,
      after: number,
    ) => (after < 0 ? answer([current], true) : answer([next]));
    state.answer = pages;
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    const gate = holdQueries(pages);
    await click("Show more");
    await tick();
    expect(container.textContent).toContain(current.title);
    await gate.release();
    expect(container.querySelectorAll(`[data-testid="programme-${current.start}"]`)).toHaveLength(
      1,
    );
    await click("Show more");
    expect(container.querySelectorAll(`[data-testid="programme-${next.start}"]`)).toHaveLength(1);
    // Start a new day so its own initial page has an independent valid cursor.
    await click("Next day");
    state.answer = async () => {
      throw new Error("private pagination error");
    };
    await click("Show more");
    expect(container.textContent).toContain(current.title);
    expect(container.textContent).toContain("Couldn't update schedule");
    expect(container.textContent).not.toContain("private pagination error");
  });
});

describe("Live on iPad and Duo windows", () => {
  const detail = () => container.querySelector('[data-testid="live-detail"]');
  const pushes = () => state.did.filter((did) => typeof did === "object" && did && "type" in did);
  afterEach(async () => {
    const { closeDetail } = await import("../src/live-screen.tsx");
    while (closeDetail());
  });

  it("splits by window width alone: from 700 points, or 1000 at accessibility text sizes", () => {
    // iPhone, Duo outer, Duo inner portrait and an iPad half-width window stay compact.
    for (const width of [402, 466, 669, 684]) expect(splitAt(width, 1)).toBe(false);
    // Duo inner landscape and iPad portrait and landscape split.
    for (const width of [700, 951, 1032, 1376]) expect(splitAt(width, 1)).toBe(true);
    expect(splitAt(951, 1.786)).toBe(false);
    expect(splitAt(1032, 1.786)).toBe(true);
  });

  it("shows a Schedule and its programme beside the list, keeping the day, without navigating", async () => {
    state.window = { width: 1032, height: 1376, fontScale: 1 };
    state.answer = async (mode, ids) =>
      mode === "detail" || ids[0] === "trusted-1" ? answer([current, next]) : answer([]);
    await draw(React.createElement(LiveTab));
    await settle();
    expect(detail()?.textContent).toBe("Choose a channel's Schedule");
    await click("Guide");
    state.did = [];
    await click("schedule-a:1");
    expect(detail()?.textContent).toContain("Channel 1");
    expect(state.focus).toEqual(["focus Channel 1"]);
    expect(detail()?.textContent).toContain("Today");
    await click("Next day", detail()!);
    const tomorrow = new Date(at + 86400_000).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    expect(detail()?.textContent).toContain(tomorrow);
    // Its Schedule pressed again keeps the day shown.
    await click("schedule-a:1");
    expect(detail()?.textContent).toContain(tomorrow);
    await click(`programme-${current.start}`);
    expect(detail()?.textContent).toContain(current.description);
    state.focus = [];
    await click("Back to Schedule");
    expect(detail()?.textContent).not.toContain(current.description);
    expect(state.focus).toEqual(["focus Channel 1"]);
    expect(detail()?.textContent).toContain(tomorrow);
    // The list and the column changed; no screen was pushed and nothing played.
    expect(state.did).toEqual([]);

    // Narrowed at the list, the Schedule goes on Live's stack on the day it showed.
    state.stack = { key: "live-stack", index: 0, routes: [{ name: "index" }] };
    state.window = { width: 669, height: 951, fontScale: 1 };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(state.did).toEqual([
      {
        type: "PUSH",
        payload: {
          name: "schedule",
          params: { channel: "a:1", day: String(new Date(2026, 9, 25).getTime()) },
        },
        target: "live-stack",
      },
    ]);
  });

  it("moves a pushed Schedule into the column as the window widens, and back as it narrows", async () => {
    const day = new Date(2026, 9, 25).getTime();
    state.answer = async (mode) => (mode === "detail" ? answer([current]) : answer([next]));
    state.stack = {
      key: "live-stack",
      index: 2,
      routes: [
        { name: "index" },
        { name: "schedule", params: { channel: "a:1", day: String(day) } },
        { name: "programme", params: { channel: "a:1", detail: "g-detail" } },
      ],
    };
    state.window = { width: 951, height: 669, fontScale: 1 };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(pushes()).toEqual([{ type: "POP_TO_TOP", target: "live-stack" }]);
    state.stack = { key: "live-stack", index: 0, routes: [{ name: "index" }] };
    await draw(React.createElement(LiveTab));
    await settle();
    // The programme shows over its Schedule, which stays on the day the stack had.
    expect(container.querySelector('[data-testid="guide-programme"]')).not.toBeNull();
    await click("Back to Schedule");
    expect(container.querySelector('[data-testid="guide-programme"]')).toBeNull();
    expect(detail()?.textContent).toContain(next.title);
    expect(detail()?.textContent).toContain(
      new Date(day).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    );
    await click(`programme-${next.start}`);

    // A fold back to the outer display puts both screens back on Live's stack, on the same day.
    state.did = [];
    state.window = { width: 466, height: 678, fontScale: 1 };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(detail()).toBeNull();
    const [schedule, programme] = pushes();
    expect(schedule).toEqual({
      type: "PUSH",
      payload: { name: "schedule", params: { channel: "a:1", day: String(day) } },
      target: "live-stack",
    });
    expect(programme).toEqual({
      type: "PUSH",
      payload: {
        name: "programme",
        params: { channel: "a:1", detail: expect.stringMatching(/^g/) },
      },
      target: "live-stack",
    });
  });

  it("moves a Schedule only while it, or the list, is the top of Live's stack", async () => {
    state.stack = {
      key: "live-stack",
      index: 2,
      routes: [
        { name: "index" },
        { name: "schedule", params: { channel: "a:1" } },
        { name: "settings" },
      ],
    };
    state.window = { width: 1376, height: 1032, fontScale: 1 };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(pushes()).toEqual([]);
    state.stack = { ...state.stack, index: 1, routes: state.stack.routes.slice(0, 2) };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(pushes()).toEqual([{ type: "POP_TO_TOP", target: "live-stack" }]);

    // Narrowed with Settings over the list, the column closes: Back returns to the list alone.
    state.did = [];
    state.stack = {
      key: "live-stack",
      index: 1,
      routes: [{ name: "index" }, { name: "settings" }],
    };
    state.window = { width: 684, height: 1032, fontScale: 1 };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(pushes()).toEqual([]);
    state.stack = { key: "live-stack", index: 0, routes: [{ name: "index" }] };
    await draw(React.createElement(LiveTab));
    await settle();
    expect(pushes()).toEqual([]);
  });

  it("moves VoiceOver to a column programme's channel once the channel is there", async () => {
    const ready = state.catalogue;
    state.catalogue = { kind: "loading" };
    const column = () =>
      React.createElement(Programme, {
        channel: "a:1",
        detail: "g-detail",
        origin: "live",
        onBack: () => {},
      });
    await draw(column());
    await settle();
    expect(state.focus).toEqual([]);
    state.catalogue = ready;
    await draw(column());
    await settle();
    expect(state.focus).toEqual(["focus Channel 1"]);
  });

  it("keeps a pushed Schedule's chosen day in its route, for the column to take over", async () => {
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    await click("Next day");
    await click("Today");
    expect(state.did).toEqual([
      { setParams: { day: String(new Date(2026, 9, 25).getTime()) } },
      { setParams: { day: undefined } },
    ]);
  });

  it("keeps the compact layout at accessibility text sizes below 1000 points", async () => {
    state.window = { width: 951, height: 669, fontScale: 2.143 };
    await draw(React.createElement(LiveTab));
    await settle();
    await click("Guide");
    state.did = [];
    await click("schedule-a:1");
    expect(detail()).toBeNull();
    expect(state.did).toEqual([{ pathname: "/live/schedule", params: { channel: "a:1" } }]);
  });
});

describe("Live's Guide grid", () => {
  it("keeps a visible row when a different row's render is suspended", async () => {
    const { useGuideGrid, localDay } = await import("../src/guide-ui.tsx");
    if (state.catalogue.kind !== "ready") throw new Error("Catalogue missing");
    const catalogue = state.catalogue.library;
    const waiting = new Promise<void>(() => {});
    let suspended = false;
    function Grid({ keys, suspend }: { keys: string[]; suspend: boolean }) {
      const { rows } = useGuideGrid(keys, localDay(at), catalogue);
      if (suspend) {
        suspended = true;
        throw waiting;
      }
      return React.createElement(
        "div",
        null,
        [...rows.values()].flatMap((row) => row.programmes.map((programme) => programme.title)),
      );
    }
    const screen = (keys: string[], suspend = false) =>
      React.createElement(
        React.Suspense,
        { fallback: "Loading" },
        React.createElement(Grid, { keys, suspend }),
      );
    const gate = holdQueries(async () => answer([current]));
    await draw(screen(["a:1"]));
    await React.act(async () => {
      React.startTransition(() => root.render(screen(["a:3"], true)));
    });
    expect(suspended).toBe(true);
    await gate.release();
    expect(container.textContent).toContain(current.title);
  });

  const cell = (key: string, programme: Programme) =>
    container.querySelector(`[data-testid="grid-${key}-${programme.start}"]`);
  const detail = () => container.querySelector('[data-testid="live-detail"]');
  /** Live on its Guide, around now. */
  async function guide(screen: React.ComponentType = LiveTab) {
    await draw(React.createElement(screen));
    await settle();
    await click("Guide");
    if (container.textContent?.includes("Now")) await click("Now");
  }
  afterEach(async () => {
    const { closeDetail } = await import("../src/live-screen.tsx");
    while (closeDetail());
  });

  it("reads the rows in view and reads each programme to VoiceOver with its channel, time and now", async () => {
    await install("a", 40);
    state.visible = 40;
    await guide();
    expect(cell("a:1", current)?.getAttribute("data-role")).toBe("button");
    expect(cell("a:1", current)?.getAttribute("aria-label")).toBe(
      `Channel 1, ${programmeRange(current)}, ${current.title}, now`,
    );
    expect(cell("a:1", next)?.getAttribute("aria-label")).toBe(
      `Channel 1, ${programmeRange(next)}, ${next.title}`,
    );
    expect(container.querySelector('[data-testid="live-guide"]')?.textContent).toContain(
      "No programme information",
    );
    const read = new Set(
      state.queries.filter((query) => query.mode === "day").flatMap((query) => query.ids),
    );
    expect(read.size).toBeLessThanOrEqual(24);
    expect(read.has("trusted-30")).toBe(false);
  });

  it("moves its window by Earlier and Later, and its day, back to now", async () => {
    await guide();
    await click("Later");
    expect(cell("a:1", current)).toBeNull();
    expect(cell("a:1", next)).not.toBeNull();
    await click("Earlier");
    await click("Earlier");
    expect(cell("a:1", current)).not.toBeNull();
    expect(cell("a:1", next)).toBeNull();
    state.queries = [];
    await click("Next day");
    expect(state.queries.at(-1)?.from).toBe(new Date(2026, 9, 25).getTime());
    expect(container.textContent).toContain(
      new Date(2026, 9, 25).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    );
    await click("Now");
    expect(container.textContent).toContain("Today");
    expect(cell("a:1", current)).not.toBeNull();
    expect(cell("a:1", next)).not.toBeNull();
    expect(container.textContent).not.toContain("Now");
  });

  it("reads an empty day again on the owner's next minute, so a refused read recovers", async () => {
    state.answer = async () => answer([]);
    await guide();
    expect(cell("a:1", current)).toBeNull();
    expect(container.querySelector('[data-testid="live-guide"]')?.textContent).toContain(
      "No programme information",
    );
    state.answer = async (_mode, ids) =>
      ids[0] === "trusted-1" ? answer([current, next]) : answer([]);
    await tick();
    expect(cell("a:1", current)).not.toBeNull();
  });

  it("says where a window past the pages read, or between programmes, has gone", async () => {
    // Every page says there is more, so the grid stops after its own pages, before noon.
    state.answer = async (_mode, _ids, _from, _until, after) => {
      const start = Math.max(after, current.start - 6 * 3600_000) + 60_000;
      return answer([{ ...current, start, stop: start + 60_000 }], true);
    };
    await guide();
    expect(container.textContent).toContain("More in Schedule");
    state.answer = async () => answer([current]);
    await install();
    await guide();
    await click("Later");
    await click("Later");
    expect(container.textContent).toContain("Nothing in this window");
  });

  it("reads its rows again after the app returns from the background, so their cells still open", async () => {
    state.window = { width: 1032, height: 1376, fontScale: 1 };
    state.answer = async (mode, ids) =>
      mode === "detail" || ids[0] === "trusted-1" ? answer([current, next]) : answer([]);
    await guide();
    state.queries = [];
    await React.act(async () => owner().background());
    await settle();
    expect(state.queries).toEqual([]);
    await React.act(async () => owner().foreground());
    await settle();
    await click(`grid-a:1-${current.start}`);
    expect(detail()?.textContent).toContain(current.title);
    expect(detail()?.textContent).not.toContain("Programme unavailable");
  });

  it("reads a row again once another read evicts its tokens, so its cells still open", async () => {
    state.window = { width: 1032, height: 1376, fontScale: 1 };
    const base = state.answer!;
    state.answer = async (mode, ids, ...rest) =>
      mode === "detail" ? answer([current]) : base(mode, ids, ...rest);
    await guide();
    // Another screen reads a day of more programmes than the owner keeps tokens for.
    const many = Array.from({ length: 8200 }, (_, i) => ({
      title: `Filler ${i}`,
      start: current.start + i,
      stop: current.start + i + 1,
      description: null,
    }));
    // That read only: a native page holds at most 128, so a grid row never holds this many.
    const withMany = state.answer;
    state.answer = async (mode, ids, ...rest) => {
      if (ids[0] !== "trusted-3") return withMany(mode, ids, ...rest);
      state.answer = withMany;
      return answer(many);
    };
    await React.act(async () => {
      await owner().schedule("a:3", {
        from: new Date(2026, 9, 24).getTime(),
        until: new Date(2026, 9, 25).getTime(),
      });
    });
    await settle();
    await click(`grid-a:1-${current.start}`);
    expect(detail()?.textContent).toContain(current.description);
  });

  it("reads each row of a new day once, while its tokens evict the last day's", async () => {
    await install("a", 20);
    state.visible = 20;
    // 400 programmes a row through the day, so a day's rows hold most of the owner's tokens.
    state.answer = async (_mode, _ids, from) =>
      answer(
        Array.from({ length: 400 }, (_, i) => ({
          title: `Programme ${i}`,
          start: from + i * 216_000,
          stop: from + (i + 1) * 216_000,
          description: null,
        })),
      );
    await guide();
    state.queries = [];
    await click("Next day");
    const reads = state.queries
      .filter((query) => query.mode === "day")
      .map((query) => query.ids.join());
    expect(reads).toHaveLength(20);
    expect(new Set(reads).size).toBe(20);
    for (let i = 1; i <= 20; i++)
      expect(container.querySelector(`[data-testid^="grid-a:${i}-"]`)).not.toBeNull();
  });

  it("starts no more reads in the background, even of a day being read", async () => {
    await guide();
    const gate = holdQueries(state.answer!);
    await click("Next day");
    await React.act(async () => owner().background());
    state.queries = [];
    await gate.release();
    expect(state.queries).toEqual([]);
    await React.act(async () => owner().foreground());
    await settle();
    expect(state.queries.filter((query) => query.mode === "day")).not.toEqual([]);
  });

  it("reads a new day's rows at once while the last day's reads still hang", async () => {
    await guide();
    const gate = holdQueries(state.answer!);
    await click("Next day");
    state.queries = [];
    await click("Next day");
    expect(state.queries.map((query) => query.from)).toContain(new Date(2026, 9, 26).getTime());
    await gate.release();
  });

  it("keeps one provider's rows reading while another provider changes", async () => {
    const a = part("a"),
      b = part("b");
    fixture().control.activations.set("b", {
      lease: "lease-b",
      generation: { id: "db-b", fetchedAt: Date.now(), until: Date.now() + 86400_000 },
    });
    await owner().restore(["a", "b"]);
    owner().setPart(a);
    owner().setPart(b);
    state.catalogue = {
      kind: "ready",
      failing: [],
      library: combine([
        { label: "a", part: a },
        { label: "b", part: b },
      ]),
    };
    const base = state.answer!;
    const held: (() => void)[] = [];
    let readsOfB = 0;
    state.answer = (mode, ids, from, until, after, lease) => {
      if (lease !== "lease-b") return base(mode, ids, from, until, after, lease);
      if (mode === "day" && ids[0] === "trusted-1" && from === new Date(2026, 9, 24).getTime())
        readsOfB++;
      return new Promise((resolve) =>
        held.push(() => void base(mode, ids, from, until, after, lease).then(resolve)),
      );
    };
    await guide();
    expect(readsOfB).toBe(1);
    // Provider a signs in again while b's rows are still being read.
    await React.act(async () => {
      setSource("a", {
        revision: 1,
        provider: xtreamProvider(
          { server: "https://fixture.test", username: "fixture", password: "canary" },
          { userAgent: "fixture" },
        ),
        login: [],
      });
    });
    await settle();
    while (held.length) {
      await React.act(async () => held.splice(0).forEach((release) => release()));
      await settle();
    }
    expect(cell("b:1", current)).not.toBeNull();
    expect(readsOfB).toBe(1);
  });

  it("says a refused later page is in the Schedule, and reads it again in the next minute", async () => {
    let refuse = true;
    state.answer = async (_mode, _ids, _from, _until, after) =>
      after < 0
        ? answer(
            [
              {
                ...current,
                start: current.start - 6 * 3600_000,
                stop: current.start - 5 * 3600_000,
              },
            ],
            true,
          )
        : refuse
          ? { kind: "failed", error: "busy" }
          : answer([current]);
    await guide();
    expect(container.textContent).toContain("More in Schedule");
    refuse = false;
    await tick();
    expect(cell("a:1", current)).not.toBeNull();
  });

  it("opens a channel's Schedule over a grid programme, with Back to that Schedule", async () => {
    state.window = { width: 1032, height: 1376, fontScale: 1 };
    await guide();
    await click(`grid-a:1-${current.start}`);
    expect(detail()?.textContent).toContain("Back to Guide");
    await click("schedule-a:1");
    expect(detail()?.querySelector('[data-testid="guide-schedule"]')).not.toBeNull();
    await click(`programme-${current.start}`);
    expect(detail()?.textContent).toContain("Back to Schedule");
  });

  it("keeps a window moved by Earlier or Later on its day past midnight", async () => {
    await guide();
    await click("Later");
    await React.act(async () => {
      vi.setSystemTime(new Date(2026, 9, 25, 0, 1).getTime());
    });
    await tick();
    expect(container.textContent).not.toContain("Today");
    expect(cell("a:1", next)).not.toBeNull();
  });

  it("moves an hour's window by half an hour at large text", async () => {
    state.window = { width: 390, height: 844, fontScale: 1.786 };
    await guide();
    await click("Later");
    expect(cell("a:1", current)).not.toBeNull();
    await click("Later");
    expect(cell("a:1", current)).toBeNull();
  });

  it("opens a programme on Live's stack and keeps the day, window and the programme marked when it returns", async () => {
    await guide();
    state.did = [];
    await click(`grid-a:1-${current.start}`);
    expect(state.did).toEqual([
      {
        pathname: "/live/programme",
        params: { channel: "a:1", detail: expect.stringMatching(/^g/) },
      },
    ]);
    await click("Later");
    // Another screen and back, as Back, a tab or a resize can remount it.
    await draw(React.createElement(Home));
    await draw(React.createElement(LiveTab));
    await settle();
    expect(cell("a:1", current)).toBeNull();
    await click("Earlier");
    expect(cell("a:1", current)?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps a programme open beside it while many rows scroll by and a minute passes", async () => {
    state.window = { width: 1032, height: 1376, fontScale: 1 };
    await install("a", 80);
    // A realistic day, 48 programmes a row, so the rows read mint thousands of detail tokens.
    const day = [
      current,
      ...Array.from({ length: 47 }, (_, i) => ({
        title: `Later programme ${i}`,
        start: current.stop + i * 60_000,
        stop: current.stop + (i + 1) * 60_000,
        description: null,
      })),
    ];
    state.answer = async (mode) => (mode === "detail" ? answer([current]) : answer(day));
    state.visible = 16;
    await guide();
    state.did = [];
    await click(`grid-a:1-${current.start}`);
    expect(detail()?.textContent).toContain(current.description);
    for (const first of [16, 32, 48, 64]) {
      state.first = first;
      await draw(React.createElement(LiveTab));
      await settle();
    }
    expect(state.queries.some((query) => query.ids.includes("trusted-75"))).toBe(true);
    await tick();
    expect(detail()?.textContent).toContain(current.description);
    // Scrolled back, its row is read again with the programme still marked.
    state.first = 0;
    await draw(React.createElement(LiveTab));
    await settle();
    expect(cell("a:1", current)?.getAttribute("aria-pressed")).toBe("true");
    expect(state.did).toEqual([]);
    await click("Back to Guide");
    expect(detail()?.textContent).toBe("Choose a channel's Schedule");
  });
});
