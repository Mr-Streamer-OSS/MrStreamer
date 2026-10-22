import * as React from "react";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary, type Channel } from "../src/library.ts";
import { native } from "./native-files.ts";

// Favourites as the viewer meets them: Live's Favourites row and its rows' stars, the list with
// its editor, and Home's row. The real screens run with React DOM on a happy-dom window, as
// live-browse.test.ts does, over the real viewing record (viewing.ts), whose file is written to
// the files stand-in (native-files.ts), and a library library.ts builds from two fake providers
// whose stream ids collide. Playback, navigation and the system's alerts are recorded.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Shown {
  readonly title: string;
  readonly buttons?: readonly { readonly text: string; readonly onPress?: () => void }[];
}

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  /** What the screens did, in order. */
  did: [] as string[],
  alerts: [] as Shown[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => {
  const { createElement, Fragment, isValidElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string; accessibilityLabel?: string };
  const box = ({ children, testID, accessibilityLabel }: Props) =>
    createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel }, children);
  const node = (part: unknown) =>
    part === undefined || part === null
      ? null
      : isValidElement(part)
        ? part
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
      disabled,
      accessibilityLabel,
    }: Props & { onPress?: () => void; disabled?: boolean }) =>
      createElement(
        "button",
        { "data-testid": testID, "aria-label": accessibilityLabel, disabled, onClick: onPress },
        typeof children === "function" ? null : children,
      ),
    FlatList: <T>({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
      ListEmptyComponent,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      ListHeaderComponent?: unknown;
      ListFooterComponent?: unknown;
      ListEmptyComponent?: unknown;
      testID?: string;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        node(ListHeaderComponent),
        data.length === 0
          ? node(ListEmptyComponent)
          : data.map((item, index) =>
              createElement(Fragment, { key: index }, renderItem({ item, index })),
            ),
        node(ListFooterComponent),
      ),
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    Alert: {
      alert: (title: string, _message: string, buttons?: Shown["buttons"]) =>
        void scenario.alerts.push({ title, ...(buttons ? { buttons } : {}) }),
    },
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
vi.mock("expo-video", () => ({ VideoView: () => null, createVideoPlayer: () => ({}) }));
vi.mock("expo-router", () => ({
  router: {
    push: (href: string) => void scenario.did.push(`push ${href}`),
    navigate: (href: string) => void scenario.did.push(`navigate ${href}`),
  },
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, { watch }: { watch: boolean }) =>
    void scenario.did.push(`play ${channel.key}${watch ? " in Watch" : ""}`),
  retry: () => undefined,
  retryChannels: () => undefined,
  reloadAllChannels: () => undefined,
}));
vi.mock("../src/playback.ts", async (original) => ({
  channelStatus: (await original<typeof import("../src/playback.ts")>()).channelStatus,
  usePlayback: () => ({ phase: { kind: "idle" }, watch: false, pip: false, muted: true }),
  openWatch: () => undefined,
  player: () => null,
  retry: () => undefined,
  setMuted: () => undefined,
}));
vi.mock("../src/storage.ts", () => ({
  useSavedState: () => ({ recentChannels: [] }),
  writeState: () => undefined,
}));
// Home's movie rows stand aside: lists that failed show nothing in their place.
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => ({ kind: "failed" }),
  titlesWorkedOut: () => false,
  useMetadataVersion: () => 0,
  useCollections: () => null,
  named: <T>(title: T) => title,
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: () => undefined,
  resume: () => undefined,
  useContinueWatching: () => [],
}));

const viewing = await import("../src/viewing.ts");
const { LiveHome } = await import("../src/live-screen.tsx");
const { FavouritesScreen } = await import("../src/favourites-screen.tsx");
const { default: Home } = await import("../src/app/(tabs)/(home)/index.tsx");

const channel = (id: string, name: string): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds: ["1"],
  guideId: null,
  catchupDays: null,
});
const listing = (...channels: ProviderChannel[]): LiveCatalogue => ({
  categories: [{ id: "1", name: "NL | News" }],
  channels,
});
// The second panel numbers its channels as the first does.
const library = buildLibrary([
  {
    subscriptionId: "a",
    label: "Home",
    catalogue: listing(
      channel("10", "NL | NOS Journaal HD"),
      channel("14", "NL | NOS Journaal FHD"),
      channel("11", "NL | Ziggo Sport"),
    ),
  },
  {
    subscriptionId: "b",
    label: "Cabin",
    catalogue: listing(channel("10", "NL | RTL Nieuws"), channel("11", "NL | Zappelin")),
  },
]);

const member = (id: string, label: string, needsSecret = false): Member =>
  ({
    entry: { id, server: "http://example.test" },
    label,
    account: null,
    needsSecret,
    live: { kind: "ready", value: {}, from: "provider", fetchedAt: 0, took: 1 },
    titles: { kind: "idle" },
  }) as Member;

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function open(component: React.ComponentType) {
  if (root) React.act(() => root!.unmount());
  container = document.createElement("div");
  root = createRoot(container);
  React.act(() => root!.render(React.createElement(component)));
}
const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
const text = (testID: string) => find(testID)?.textContent ?? "";
function press(testID: string) {
  const button = find(testID) as { click(): void; disabled?: boolean } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  if (button.disabled) throw new Error(`${testID} is disabled`);
  React.act(() => button.click());
}
const disabled = (testID: string) => (find(testID) as { disabled?: boolean } | null)?.disabled;
/** The favourites the list shows, in order. */
const listed = () =>
  [...container.querySelectorAll('[data-testid^="favourite-"]')]
    .map((row) => row.getAttribute("data-testid")?.slice("favourite-".length) ?? "")
    .filter((key) => !key.endsWith("-star"));
const arranged = () =>
  [...container.querySelectorAll('[data-testid^="arranged-"]')]
    .map((row) => row.getAttribute("data-testid")?.slice("arranged-".length) ?? "")
    .filter((key) => !key.endsWith("-up") && !key.endsWith("-down"));
/** The record's favourites, as their subscriptions' ids. */
const saved = () =>
  (viewing.currentViewing()?.favourites ?? []).map((each) => `${each.subscriptionId}:${each.id}`);

/** Resolves once the record holds `keys`, drawing what changed. */
async function holds(keys: readonly string[]) {
  for (let waited = 0; JSON.stringify(saved()) !== JSON.stringify(keys); waited += 10) {
    if (waited > 4_000) throw new Error(`The favourites stayed ${JSON.stringify(saved())}`);
    await React.act(() => new Promise((done) => setTimeout(done, 10)));
  }
}
/** Lets the record's answer land and the screen draw it. */
const settle = () => React.act(() => new Promise((done) => setTimeout(done, 20)));
async function starred(...keys: string[]) {
  for (const key of keys) {
    const [subscriptionId = "", id = ""] = key.split(":");
    await viewing.setFavourite({ subscriptionId, id }, true);
  }
  await holds(keys);
}

beforeEach(async () => {
  Object.assign(scenario, {
    members: [member("a", "Home"), member("b", "Cabin")],
    catalogue: { kind: "ready", library, failing: [] },
    did: [],
    alerts: [],
  });
  viewing.setViewingOwners(["a", "b"]);
  viewing.setViewingChannels(library.byKey);
  await viewing.eraseViewing("a");
  await viewing.eraseViewing("b");
});
afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
  rmSync(join(native.root, "documents", "viewing.json.next"), { recursive: true, force: true });
});

describe("Live", () => {
  it("leads with Favourites, which opens the list with none saved too", () => {
    open(LiveHome);
    expect(text("live-favourites")).toBe("Favourites");
    press("live-favourites");
    expect(scenario.did).toEqual(["push /live/favourites"]);
  });

  it("stars a row's channel from its own provider, playing nothing", async () => {
    open(LiveHome);
    press("star-b:10");
    await holds(["b:10"]);
    await settle();
    expect(text("live-favourites")).toBe("Favourites1");
    // The same stream id of the other provider is its own channel, and stays unstarred.
    expect(find("channel-b:10")?.getAttribute("aria-label")).toBe("RTL Nieuws, favourite");
    expect(find("channel-a:10")?.getAttribute("aria-label")).toBe("NOS Journaal");
    press("star-b:10");
    await holds([]);
    expect(scenario.did).toEqual([]);
  });
});

describe("the favourites list", () => {
  it("says none are saved yet", () => {
    open(FavouritesScreen);
    expect(text("favourites")).toContain("No favourites yet.");
  });

  it("plays a row in Watch, and takes one out with its star without playing", async () => {
    await starred("a:10", "b:10");
    open(FavouritesScreen);
    expect(listed()).toEqual(["a:10", "b:10"]);
    press("favourite-a:10");
    expect(scenario.did).toEqual(["play a:10 in Watch"]);
    press("favourite-b:10-star");
    await holds(["a:10"]);
    await settle();
    expect(listed()).toEqual(["a:10"]);
    expect(scenario.did).toEqual(["play a:10 in Watch"]);
  });

  it("saves an order made with Move up and Move down, and Cancel throws one away", async () => {
    await starred("a:10", "b:10", "a:11");
    open(FavouritesScreen);
    press("favourites-edit");
    expect(arranged()).toEqual(["a:10", "b:10", "a:11"]);
    expect(disabled("arranged-a:10-up")).toBe(true);
    expect(disabled("arranged-a:11-down")).toBe(true);
    press("arranged-a:11-up");
    press("arranged-a:11-up");
    expect(arranged()).toEqual(["a:11", "a:10", "b:10"]);
    press("favourites-cancel");
    expect(listed()).toEqual(["a:10", "b:10", "a:11"]);
    expect(saved()).toEqual(["a:10", "b:10", "a:11"]);

    press("favourites-edit");
    press("arranged-a:10-down");
    press("favourites-save");
    await holds(["b:10", "a:10", "a:11"]);
    await settle();
    expect(listed()).toEqual(["b:10", "a:10", "a:11"]);
    expect(find("favourites-save")).toBeNull();
    // Arranging plays nothing.
    expect(scenario.did).toEqual([]);
  });

  it("keeps a provider's favourites that need its password in their places, saying so", async () => {
    await starred("b:10", "a:10", "b:11", "a:11");
    scenario.members = [member("a", "Home"), member("b", "Cabin", true)];
    open(FavouritesScreen);
    expect(listed()).toEqual(["a:10", "a:11"]);
    expect(text("favourites-hidden")).toBe("2 saved from Cabin: password needed in Settings");
    press("favourite-a:11");
    expect(scenario.did).toEqual(["play a:11 in Watch"]);

    press("favourites-edit");
    press("arranged-a:11-up");
    press("favourites-save");
    await holds(["b:10", "a:11", "b:11", "a:10"]);
  });

  it("says a favourite no list shows is saved, without making it a row", async () => {
    await starred("a:11");
    // Saved as a stream Live no longer lists.
    await viewing.setFavourite({ subscriptionId: "a", id: "99" }, true);
    await holds(["a:11", "a:99"]);
    open(FavouritesScreen);
    expect(listed()).toEqual(["a:11"]);
    expect(text("favourites-hidden")).toBe("Saved from Home: no longer listed");
  });

  it("moves nothing when the favourites changed while they were arranged", async () => {
    await starred("a:10", "b:10");
    open(FavouritesScreen);
    press("favourites-edit");
    press("arranged-b:10-up");
    await starred("a:10", "b:10", "a:11");
    press("favourites-save");
    await settle();
    expect(scenario.alerts.map((alert) => alert.title)).toEqual(["Favourites changed"]);
    expect(saved()).toEqual(["a:10", "b:10", "a:11"]);
    expect(find("favourites-save")).toBeNull();
    expect(listed()).toEqual(["a:10", "b:10", "a:11"]);
  });

  it("keeps the order to send again when it isn't saved, and sends it on Try again", async () => {
    await starred("a:10", "b:10");
    open(FavouritesScreen);
    press("favourites-edit");
    press("arranged-b:10-up");
    // The record's file can't be replaced: its write beside it fails.
    mkdirSync(join(native.root, "documents", "viewing.json.next"));
    press("favourites-save");
    await settle();
    expect(scenario.alerts.map((alert) => alert.title)).toEqual(["Couldn't save the order"]);
    expect(saved()).toEqual(["a:10", "b:10"]);
    expect(arranged()).toEqual(["b:10", "a:10"]);

    rmSync(join(native.root, "documents", "viewing.json.next"), { recursive: true });
    const again = scenario.alerts[0]?.buttons?.find((button) => button.text === "Try again");
    React.act(() => again?.onPress?.());
    await holds(["b:10", "a:10"]);
  });
});

describe("Home", () => {
  it("shows the Favourites heading with none saved, opening the list", () => {
    open(Home);
    expect(container.querySelector('[data-testid^="home-favourite-"]')).toBeNull();
    expect(find("favourites-heading")?.getAttribute("aria-label")).toBe("Favourites, all 0");
    press("favourites-heading");
    expect(scenario.did).toEqual(["push /favourites"]);
  });

  it("previews a favourite on the Stage, in their order", async () => {
    await starred("b:11", "a:10");
    open(Home);
    const tiles = [...container.querySelectorAll('[data-testid^="home-favourite-"]')].map((tile) =>
      tile.getAttribute("data-testid"),
    );
    expect(tiles).toEqual(["home-favourite-b:11", "home-favourite-a:10"]);
    press("home-favourite-a:10");
    expect(scenario.did).toEqual(["play a:10"]);
  });
});
