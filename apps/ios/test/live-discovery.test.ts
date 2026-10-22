import * as React from "react";
import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Live's Find countries or categories as the viewer meets it, over the app's own owners: account.ts
// signs in to two of the desktop tests' fake Xtream panels, whose ids and names collide, and
// library.ts joins their channels as Live shows them. The real Live, discovery and category
// screens run with React DOM on a happy-dom window, as live-browse.test.ts does. Navigation is
// recorded and acted out: a push draws the screen pushed, Back the one under it, which stays as
// it was. The native player records what it is given, and every request to a panel is counted, so
// a test sees that finding and opening plays nothing and asks nothing of a provider.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** What the player was given, in order. */
  played: [] as string[],
  /** Requests to the panels' API and streams, by path and action. */
  requests: [] as string[],
  /** Where the screens went, in order. */
  routes: [] as string[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => scenario.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void scenario.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void scenario.keychain.delete(key),
}));
vi.mock("expo-video", () => ({
  VideoView: () => null,
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async (source: { uri: string } | null) => {
      if (source) scenario.played.push(source.uri);
    },
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string; accessibilityLabel?: string };
  const box = ({ children, testID, accessibilityLabel }: Props) =>
    createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel }, children);
  const node = (part: unknown) =>
    part === undefined || part === null || typeof part !== "function"
      ? (part as React.ReactNode)
      : createElement(part as React.ComponentType);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Image: () => null,
    Pressable: ({
      children,
      testID,
      onPress,
      accessibilityLabel,
    }: Props & { onPress?: () => void }) =>
      createElement(
        "button",
        { "data-testid": testID, "aria-label": accessibilityLabel, onClick: onPress },
        typeof children === "function" ? null : children,
      ),
    TextInput: ({
      value,
      onChangeText,
      testID,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      testID?: string;
    }) =>
      createElement("input", {
        "data-testid": testID,
        value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    FlatList: <T>({
      data,
      renderItem,
      ListHeaderComponent,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      ListHeaderComponent?: unknown;
      testID?: string;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        node(ListHeaderComponent),
        data.map((item, index) =>
          createElement(Fragment, { key: index }, renderItem({ item, index })),
        ),
      ),
    SectionList: <T>({
      sections,
      renderItem,
      renderSectionHeader,
      testID,
    }: {
      sections: readonly { title: string; data: readonly T[] }[];
      renderItem: (info: { item: T }) => React.ReactNode;
      renderSectionHeader: (info: { section: { title: string; data: readonly T[] } }) => unknown;
      testID?: string;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        sections.map((section) =>
          createElement(
            "section",
            { key: section.title },
            renderSectionHeader({ section }) as React.ReactNode,
            section.data.map((item, index) =>
              createElement(Fragment, { key: index }, renderItem({ item })),
            ),
          ),
        ),
      ),
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    Alert: { alert: () => undefined },
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    DynamicColorIOS: () => "#000000",
    AppState: { currentState: "active", addEventListener: () => undefined },
    AccessibilityInfo: {
      isReduceTransparencyEnabled: async () => false,
      isReduceMotionEnabled: async () => false,
      addEventListener: () => undefined,
      announceForAccessibility: () => undefined,
      announceForAccessibilityWithOptions: () => undefined,
    },
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const { createElement } = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", null, children),
  };
});
vi.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isGlassEffectAPIAvailable: () => false,
  isLiquidGlassAvailable: () => false,
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  router: {
    push: (href: string) => void scenario.routes.push(href),
    back: () => void scenario.routes.push("back"),
  },
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  // The provider's API and its streams; channel logos Live's rows show are pictures, not asked here.
  if (!url.pathname.startsWith("/logos/")) {
    scenario.requests.push(`${url.pathname}?${url.searchParams.get("action") ?? ""}`);
  }
  return passThrough(input, init);
});

interface FakeChannel {
  readonly streamId: number;
}
interface FakeProvider {
  readonly url: string;
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  failCatalogue(status: number | null): void;
  hold(what: "channels"): { readonly arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, QUALITY_STREAM_IDS } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
    readonly second?: boolean;
  }): Promise<FakeProvider>;
  QUALITY_STREAM_IDS: number;
};
/** The streams of the one channel in three qualities: its category, Belgium's Kwaliteit, has no other. */
const QUALITIES = [0, 1, 2].map((at) => QUALITY_STREAM_IDS + at);

let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 400, titles: 4 }),
    startFakeProvider({
      username: "two",
      password: "two+Pw@2",
      channels: 400,
      titles: 4,
      second: true,
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 4_000) throw new Error(`Timed out waiting for ${what}`);
    await React.act(() => new Promise((done) => setTimeout(done, 10)));
  }
}

const account = await import("../src/account.ts");
const { LiveHome, CategoryScreen } = await import("../src/live-screen.tsx");
const { DiscoverScreen } = await import("../src/live-discover.tsx");

const libraryOf = () => {
  const now = account.currentCatalogue();
  return now.kind === "ready" ? now.library : null;
};

let a = "";
let b = "";
/** What discovery said while the first provider's channels were still to come. */
let firstLoad = "";
beforeAll(async () => {
  await account.restore();
  const held = one.hold("channels");
  a = (await account.add({ server: one.url, username: "one", password: "one+Pw@1" })) ?? "";
  await held.arrived;
  const shown = document.createElement("div");
  const early = createRoot(shown);
  React.act(() => early.render(React.createElement(DiscoverScreen)));
  firstLoad = shown.textContent ?? "";
  React.act(() => early.unmount());
  held.release();
  b =
    (await account.add({
      server: two.url,
      username: "two",
      password: "two+Pw@2",
      name: "Cabin",
    })) ?? "";
  await until(() => libraryOf()?.labels.size === 2 && account.channelsWorkedOut(), "both lists");
});

/**
 * The screens on Live's stack, bottom first, as the recorded navigation leaves them: a push adds
 * the screen it names, Back takes the top one away and shows the one under it as it was.
 */
let stack: React.ReactElement[] = [];
let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function draw() {
  React.act(() =>
    root!.render(
      React.createElement(
        React.Fragment,
        null,
        stack.map((screen, at) =>
          React.createElement(
            "div",
            { key: at, "data-screen": at, hidden: at !== stack.length - 1 },
            screen,
          ),
        ),
      ),
    ),
  );
}
const screenFor = (href: string): React.ReactElement => {
  if (href === "/live/discover") return React.createElement(DiscoverScreen);
  const category = /^\/live\/category\?region=([^&]*)&name=(.*)$/.exec(href);
  if (category) {
    return React.createElement(CategoryScreen, {
      region: decodeURIComponent(category[1] ?? ""),
      name: decodeURIComponent(category[2] ?? ""),
    });
  }
  throw new Error(`No screen for ${href}`);
};
/** Acts out the navigation the screens asked for since the last call. */
function navigate() {
  for (const route of scenario.routes.splice(0)) {
    if (route === "back") stack = stack.slice(0, -1);
    else stack = [...stack, screenFor(route)];
  }
  draw();
}
const top = () => container.querySelector(`[data-screen="${stack.length - 1}"]`)!;
const find = (testID: string) => top().querySelector(`[data-testid="${testID}"]`);
function press(testID: string) {
  const button = find(testID) as { click(): void } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
  navigate();
}
function type(text: string) {
  const field = find("discover-field") as unknown as {
    value: string;
    dispatchEvent(event: unknown): void;
  } | null;
  if (!field) throw new Error("No field on screen");
  React.act(() => {
    // React reads the new value through the field's own setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const value = () => (find("discover-field") as unknown as { value: string } | null)?.value;
/** Each result on the discovery screen: its name, kind and line, as VoiceOver reads it. */
const results = () =>
  [
    ...top().querySelectorAll(
      '[data-testid^="discover-country-"], [data-testid^="discover-category-"]',
    ),
  ].map((row) => row.getAttribute("aria-label") ?? "");
/** The channel rows on the screen showing, by their keys. */
const rows = () =>
  [...top().querySelectorAll('[data-testid^="channel-"]')].map(
    (row) => row.getAttribute("data-testid")?.slice("channel-".length) ?? "",
  );

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  stack = [React.createElement(LiveHome)];
  draw();
  // Live under the discovery screen shows its tiles rather than every provider's 800 rows.
  press("tab-categories");
  scenario.routes.length = 0;
  scenario.requests.length = 0;
  scenario.played.length = 0;
});
afterEach(() => {
  React.act(() => root!.unmount());
  root = null;
  // Nothing found or opened plays, or asks a provider for anything.
  expect(scenario.played).toEqual([]);
});

/** The system's back button, over the screen on top. */
function back() {
  scenario.routes.push("back");
  navigate();
}
const shelvesCalled = (name: string) =>
  libraryOf()!.regions.flatMap((region) =>
    region.shelves.filter((shelf) => shelf.title === name).map((shelf) => ({ region, shelf })),
  );

describe("finding a category", () => {
  it("finds every country's category of a name, each named by its country", () => {
    press("live-discover");
    expect(value()).toBe("");
    type("news");
    const news = shelvesCalled("News");
    // Far more than For you's six shelves, and every one of them.
    expect(news.length).toBeGreaterThan(6);
    expect(results()).toEqual(
      news.map(
        ({ region, shelf }) => `News, category, ${region.name} · ${shelf.channels.length} channels`,
      ),
    );
    expect(new Set(news.map(({ region }) => region.name)).size).toBe(news.length);
    expect(scenario.requests).toEqual([]);
  });

  it("opens the whole category, each provider's channels in it, and Back finds the results again", () => {
    press("live-discover");
    type("news");
    const before = results();
    // The last country's, far past For you's shelves.
    const shelf = shelvesCalled("News").at(-1)!.shelf;
    press(`discover-category-${shelf.id}`);
    expect(rows()).toEqual(shelf.channels.map((channel) => channel.key));
    // Both providers list a channel there, each its own though their ids are the same.
    expect(new Set(shelf.channels.map((channel) => channel.subscriptionId))).toEqual(
      new Set([a, b]),
    );
    back();
    expect(value()).toBe("news");
    expect(results()).toEqual(before);
    expect(scenario.requests).toEqual([]);
  });
});

describe("finding a country", () => {
  it("shows the country in Live on the tab it showed, and Cancel leaves Live as it was", () => {
    const tabbed = () => container.querySelector('[data-testid="live-categories"]') !== null;
    expect(tabbed()).toBe(true);
    press("live-discover");
    const [, second] = libraryOf()!.regions;
    type(second!.name);
    expect(results()[0]).toBe(`${second!.name}, country, ${second!.channels.length} channels`);
    press("discover-cancel");
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe("All countries");
    expect(tabbed()).toBe(true);

    press("live-discover");
    // Each opening starts with an empty field.
    expect(value()).toBe("");
    type(second!.name);
    press(`discover-country-${second!.name}`);
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe(second!.name);
    expect(tabbed()).toBe(true);
    press("live-country-clear");
  });
});

describe("the first channels", () => {
  it("are said to be loading until a provider's come, with the field there", () => {
    expect(firstLoad).toBe("CancelChannels are still loading.");
  });
});

describe("the field", () => {
  it("empties on Clear and stays open, and says when nothing has the name", () => {
    press("live-discover");
    type("kids");
    expect(results().length).toBeGreaterThan(0);
    press("discover-clear");
    expect(value()).toBe("");
    expect(results()).toEqual([]);
    expect(stack).toHaveLength(2);
    type("zzqx");
    expect(find("discover-results")).toBeNull();
    expect(top().textContent).toContain("No country or category is called “zzqx”.");
  });
});

describe("as the providers' lists change", () => {
  it("keeps finding the last channels while a reload fails, and says so", async () => {
    one.failCatalogue(503);
    account.reloadChannels(a);
    await until(() => account.members()[0]?.live.kind === "failed", "the failure");
    press("live-discover");
    type("news");
    expect(results()).toHaveLength(shelvesCalled("News").length);
    // The status line names it, as Live's does (loading-feedback.test.ts): its list is the last.
    const now = account.currentCatalogue();
    expect(now.kind === "ready" && now.failing.map((member) => member.entry.id)).toEqual([a]);
    one.failCatalogue(null);
    const before = libraryOf();
    account.reloadChannels(a);
    await until(() => libraryOf() !== before && account.channelsWorkedOut(), "the list again");
  });

  it("drops a category no provider lists any more, and its screen says it is gone", async () => {
    press("live-discover");
    type("kwaliteit");
    const [kwaliteit] = shelvesCalled("Kwaliteit");
    expect(results()).toEqual([`Kwaliteit, category, ${kwaliteit!.region.name} · 2 channels`]);
    press(`discover-category-${kwaliteit!.shelf.id}`);
    expect(rows()).toHaveLength(2);

    for (const panel of [one, two]) {
      panel.serveChannels((all) => all.filter((each) => !QUALITIES.includes(each.streamId)));
    }
    const before = libraryOf();
    account.reloadChannels(a);
    account.reloadChannels(b);
    await until(
      () =>
        libraryOf() !== before &&
        account.channelsWorkedOut() &&
        shelvesCalled("Kwaliteit").length === 0,
      "the lists without it",
    );
    draw();
    expect(top().textContent).toContain("This category isn't listed any more.");
    back();
    expect(results()).toEqual([]);
    expect(top().textContent).toContain("No country or category is called “kwaliteit”.");

    for (const panel of [one, two]) panel.serveChannels((all) => all);
    const without = libraryOf();
    account.reloadChannels(a);
    account.reloadChannels(b);
    await until(
      () => libraryOf() !== without && shelvesCalled("Kwaliteit").length === 1,
      "the lists with it again",
    );
  });
});
