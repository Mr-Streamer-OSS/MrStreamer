import { createRoot, document, Event, type Root } from "./dom.ts";
import * as React from "react";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary, type Channel } from "../src/library.ts";
import { native } from "./native-files.ts";

// Channel lists as the viewer meets them (custom-lists-screen.tsx): a row's sheet on Live and in
// Favourites, Live's rows for the lists, and a list's screen with its editor. The real screens run
// with React DOM on a happy-dom window, as favourites-screen.test.ts does, over the real lists
// (custom-lists.ts) and viewing record, whose files are written to the files stand-in
// (native-files.ts), and a library from two fake providers whose stream ids collide. Playback,
// navigation, the system's sheets, alerts and prompts are recorded; a hold is a context menu.

interface Button {
  readonly text: string;
  readonly onPress?: (typed?: string) => void;
}
interface Shown {
  readonly title: string;
  readonly message?: string;
  readonly buttons?: readonly Button[];
  /** What a prompt shows typed in it. */
  readonly typed?: string;
}
interface Sheet {
  readonly title: string;
  readonly options: readonly string[];
  readonly choose: (index: number) => void;
}

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  did: [] as string[],
  alerts: [] as Shown[],
  prompts: [] as Shown[],
  sheets: [] as Sheet[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => {
  const { createElement, useEffect } = await import("react");
  const { box, reactNative } = await import("./react-native.ts");
  return {
    ...reactNative,
    View: ({
      onLayout,
      ...props
    }: Parameters<typeof box>[0] & {
      onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
    }) => {
      useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 390, height: 600 } } }), []);
      return box(props);
    },
    /** A button pressed by a click and held by a context menu. */
    Pressable: ({
      children,
      testID,
      accessibilityLabel,
      disabled,
      onPress,
      onLongPress,
    }: {
      children?: React.ReactNode;
      testID?: string;
      accessibilityLabel?: string;
      disabled?: boolean;
      onPress?: () => void;
      onLongPress?: (event: { currentTarget: null }) => void;
    }) =>
      createElement(
        "button",
        {
          "data-testid": testID,
          "aria-label": accessibilityLabel,
          disabled,
          onClick: onPress,
          onContextMenu: () => onLongPress?.({ currentTarget: null }),
        },
        children,
      ),
    findNodeHandle: () => null,
    Alert: {
      alert: (title: string, message?: string, buttons?: readonly Button[]) =>
        void scenario.alerts.push({
          title,
          ...(message ? { message } : {}),
          ...(buttons ? { buttons } : {}),
        }),
      prompt: (
        title: string,
        message: string | undefined,
        buttons: readonly Button[],
        _type: string,
        typed: string,
      ) => void scenario.prompts.push({ title, ...(message ? { message } : {}), buttons, typed }),
    },
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        { title, options }: { title: string; options: string[] },
        choose: (index: number) => void,
      ) => void scenario.sheets.push({ title, options, choose }),
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
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isGlassEffectAPIAvailable: () => false,
  isLiquidGlassAvailable: () => false,
}));
vi.mock("expo-video", () => ({ VideoView: () => null, createVideoPlayer: () => ({}) }));
vi.mock("expo-router", () => ({
  router: {
    push: (href: string) => void scenario.did.push(`push ${href}`),
    navigate: (href: string) => void scenario.did.push(`navigate ${href}`),
    back: () => void scenario.did.push("back"),
  },
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));
vi.mock("../src/account.ts", () => ({
  currentRoster: () => ({ kind: "ready", members: scenario.members }),
  onRoster: () => () => {},
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  useCatalogue: () => scenario.catalogue,
  currentCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, { watch }: { watch: boolean }) =>
    void scenario.did.push(`play ${channel.key}${watch ? " in Watch" : ""}`),
  retry: () => undefined,
  retryChannels: () => undefined,
  reloadAllChannels: () => undefined,
}));
vi.mock("../src/subscriptions.ts", () => ({ readRegistry: () => null }));
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
vi.mock("../src/loading.tsx", async (original) => ({
  ...(await original<typeof import("../src/loading.tsx")>()),
  PlaceholderRows: () => null,
}));

const viewing = await import("../src/viewing.ts");
const lists = await import("../src/custom-lists.ts");
const { LiveHome } = await import("../src/live-screen.tsx");
const { FavouritesScreen } = await import("../src/favourites-screen.tsx");
const { ChannelListScreen } = await import("../src/custom-lists-screen.tsx");

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
const NOS = channel("10", "NL | NOS Journaal HD");
const ZIGGO = channel("11", "NL | Ziggo Sport");
const RTL = channel("10", "NL | RTL Nieuws");
const ZAPPELIN = channel("11", "NL | Zappelin");

/** Home (a) lists `home`, Cabin (b) `cabin`, as Live shows them now. */
function shows(home: ProviderChannel[], cabin: ProviderChannel[]) {
  const library = buildLibrary([
    { subscriptionId: "a", label: "Home", catalogue: listing(...home) },
    { subscriptionId: "b", label: "Cabin", catalogue: listing(...cabin) },
  ]);
  scenario.catalogue = { kind: "ready", library, failing: [] };
  viewing.setViewingChannels(library.byKey);
}
const live = (key: string): Channel => {
  const found = scenario.catalogue.kind === "ready" && scenario.catalogue.library.byKey.get(key);
  if (!found) throw new Error(`Live doesn't list ${key}`);
  return found;
};

const member = (id: string, label: string): Member => ({
  entry: { id, kind: "xtream", server: "http://example.test", username: "fixture", name: null },
  label,
  account: null,
  needsSecret: false,
  live: { kind: "ready", value: listing(), from: "provider", fetchedAt: 0, took: 1 },
  titles: { kind: "idle" },
});

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
let shown: React.ComponentType | null = null;
function open(component: React.ComponentType) {
  shown = component;
  if (root) React.act(() => root!.unmount());
  container = document.createElement("div");
  root = createRoot(container);
  React.act(() => root!.render(React.createElement(component)));
}
/** Draws the screen again, as a change of the channels shown would. */
const redraw = () => React.act(() => root!.render(React.createElement(shown!)));
/** A list's screen, as its route opens it. */
const listScreen = (id: string) => () => React.createElement(ChannelListScreen, { id });

const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
const text = (testID: string) => find(testID)?.textContent ?? "";
function press(testID: string) {
  const button = find(testID) as { click(): void; disabled?: boolean } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  if (button.disabled) throw new Error(`${testID} is disabled`);
  React.act(() => button.click());
}
function hold(testID: string) {
  const row = find(testID);
  if (!row) throw new Error(`No ${testID} on screen`);
  React.act(() => void row.dispatchEvent(new Event("contextmenu", { bubbles: true })));
}
const lastSheet = () => scenario.sheets.at(-1)!;
/** Chooses `option` in the sheet shown last. */
function choose(option: string) {
  const index = lastSheet().options.indexOf(option);
  if (index < 0) throw new Error(`No ${option} in ${lastSheet().options.join(", ")}`);
  React.act(() => lastSheet().choose(index));
}
/** Presses `button` of the prompt shown last, with `typed` in it. */
function answer(button: string, typed: string) {
  const prompt = scenario.prompts.at(-1)!;
  React.act(() => prompt.buttons?.find((each) => each.text === button)?.onPress?.(typed));
}
/** Presses `button` of the alert shown last. */
function confirm(button: string) {
  const alert = scenario.alerts.at(-1)!;
  React.act(() => alert.buttons?.find((each) => each.text === button)?.onPress?.());
}
const prefixed = (prefix: string, ...not: string[]) =>
  [...container.querySelectorAll(`[data-testid^="${prefix}"]`)]
    .map((row) => row.getAttribute("data-testid")!.slice(prefix.length))
    .filter((id) => !not.some((suffix) => id.endsWith(suffix)));
/** A list's rows on screen, by channel key, or entry for one that doesn't open. */
const rows = () => prefixed("list-row-", "-remove");
const arranged = () => prefixed("arranged-", "-up", "-down", "-remove");
/** What the lists hold now: each by name, then its channels by key or name. */
const saved = () =>
  lists
    .currentChannelLists()
    .map(
      (list) =>
        `${list.name}: ${list.entries.map((entry) => (entry.kind === "listed" ? entry.channel.key : entry.name)).join(", ")}`,
    );
const idOf = (name: string) => lists.currentChannelLists().find((list) => list.name === name)!.id;
const alertTitles = () => scenario.alerts.map((alert) => alert.title);
const failWrites = () => {
  native.sync = (operation) => {
    if (operation === "write") throw new Error("There isn't enough space on this iPhone.");
  };
};

beforeEach(async () => {
  native.sync = null;
  Object.assign(scenario, {
    members: [member("a", "Home"), member("b", "Cabin")],
    did: [],
    alerts: [],
    prompts: [],
    sheets: [],
  });
  shows([NOS, ZIGGO], [RTL, ZAPPELIN]);
  for (const list of lists.currentChannelLists()) lists.deleteList(list.id);
  viewing.setViewingOwners(["a", "b"]);
  await viewing.eraseViewing("a");
  await viewing.eraseViewing("b");
});
afterEach(() => {
  native.sync = null;
  if (root) React.act(() => root!.unmount());
  root = null;
});

describe("a row's lists", () => {
  it("make a list from a Live row, holding its channel, under Favourites", () => {
    open(LiveHome);
    expect(container.querySelector('[data-testid^="live-list-"]')).toBeNull();
    hold("channel-a:11");
    expect(lastSheet().title).toBe("Ziggo Sport");
    expect(lastSheet().options).toEqual(["New list…", "Cancel"]);
    choose("New list…");
    expect(scenario.prompts.at(-1)).toMatchObject({
      title: "New list",
      message: "Ziggo Sport goes in it.",
    });
    answer("Create", "   ");
    expect(saved()).toEqual([]);

    hold("channel-a:11");
    choose("New list…");
    answer("Create", "  Sport ");
    expect(saved()).toEqual(["Sport: a:11"]);
    const id = idOf("Sport");
    expect(find(`live-list-${id}`)?.getAttribute("aria-label")).toBe("Sport, 1");

    // A name another list has, apart from case, asks again with the text kept.
    hold("channel-b:10");
    choose("New list…");
    answer("Create", "sport");
    expect(scenario.prompts.at(-1)).toMatchObject({
      title: "New list",
      message: "There's already a list called Sport.",
      typed: "sport",
    });
    expect(saved()).toEqual(["Sport: a:11"]);

    press(`live-list-${id}`);
    expect(scenario.did).toEqual([`push /live/list?id=${encodeURIComponent(id)}`]);
  });

  it("add a channel at a list's end and take it out, saying when a write changed nothing", () => {
    lists.createList("Sport", live("a:11"));
    lists.createList("Kids");
    open(LiveHome);
    hold("channel-b:10");
    expect(lastSheet().options).toEqual(["Sport", "Kids", "New list…", "Cancel"]);
    choose("Sport");
    expect(saved()).toEqual(["Sport: a:11, b:10", "Kids: "]);
    expect(find(`live-list-${idOf("Sport")}`)?.getAttribute("aria-label")).toBe("Sport, 2");

    hold("channel-b:10");
    expect(lastSheet().options).toEqual(["✓ Sport", "Kids", "New list…", "Cancel"]);
    choose("✓ Sport");
    expect(saved()).toEqual(["Sport: a:11", "Kids: "]);

    failWrites();
    hold("channel-b:10");
    choose("Kids");
    expect(scenario.alerts).toEqual([
      { title: "Kids wasn't changed", message: "There isn't enough space on this iPhone." },
    ]);
    expect(saved()).toEqual(["Sport: a:11", "Kids: "]);
    expect(scenario.did).toEqual([]);
  });
});

describe("a list's screen", () => {
  it("plays a row in Watch, and nothing once its entry is another channel", () => {
    const id = lists.createList("Sport", live("a:11"));
    lists.setMember(id, live("b:10"), true);
    open(listScreen(id));
    expect(rows()).toEqual(["a:11", "b:10"]);
    press("list-row-b:10");
    expect(scenario.did).toEqual(["play b:10 in Watch"]);

    // Cabin stops listing RTL before the screen draws again.
    shows([NOS, ZIGGO], [ZAPPELIN]);
    press("list-row-b:10");
    expect(alertTitles()).toEqual(["RTL Nieuws didn't play"]);
    expect(scenario.did).toEqual(["play b:10 in Watch"]);

    redraw();
    expect(text("list")).toContain("Cabin: no longer listed");
    const [gone] = prefixed("list-row-").filter((row) => row.endsWith("-remove"));
    press(`list-row-${gone}`);
    expect(rows()).toEqual(["a:11"]);
    expect(saved()).toEqual(["Sport: a:11"]);
  });

  it("saves an edit's order and removals together, and Cancel throws one away", () => {
    const id = lists.createList("Sport", live("a:10"));
    lists.setMember(id, live("a:11"), true);
    lists.setMember(id, live("b:10"), true);
    open(listScreen(id));
    press("list-edit");
    expect(arranged()).toEqual(["a:10", "a:11", "b:10"]);
    expect((find("arranged-a:10-up") as { disabled?: boolean }).disabled).toBe(true);
    press("arranged-b:10-up");
    press("arranged-b:10-up");
    press("arranged-a:11-remove");
    expect(arranged()).toEqual(["b:10", "a:10"]);
    press("list-cancel");
    expect(rows()).toEqual(["a:10", "a:11", "b:10"]);
    expect(saved()).toEqual(["Sport: a:10, a:11, b:10"]);

    press("list-edit");
    press("arranged-b:10-up");
    press("arranged-a:10-remove");
    press("list-save");
    expect(saved()).toEqual(["Sport: b:10, a:11"]);
    expect(rows()).toEqual(["b:10", "a:11"]);
    expect(find("list-save")).toBeNull();
    // Editing plays nothing.
    expect(scenario.did).toEqual([]);
  });

  it("keeps the draft when the write is refused, and saves it on Try again", () => {
    const id = lists.createList("Sport", live("a:10"));
    lists.setMember(id, live("b:10"), true);
    open(listScreen(id));
    press("list-edit");
    press("arranged-b:10-up");
    failWrites();
    press("list-save");
    expect(scenario.alerts.at(-1)).toMatchObject({
      title: "Couldn't save Sport",
      message: "There isn't enough space on this iPhone.",
    });
    expect(saved()).toEqual(["Sport: a:10, b:10"]);
    expect(arranged()).toEqual(["b:10", "a:10"]);

    native.sync = null;
    confirm("Try again");
    expect(saved()).toEqual(["Sport: b:10, a:10"]);
    expect(rows()).toEqual(["b:10", "a:10"]);
  });

  it("moves and removes nothing when the list changed while it was edited", () => {
    const id = lists.createList("Sport", live("a:10"));
    lists.setMember(id, live("b:10"), true);
    open(listScreen(id));
    press("list-edit");
    press("arranged-b:10-up");
    press("arranged-a:10-remove");
    lists.setMember(id, live("a:11"), true);
    press("list-save");
    expect(alertTitles()).toEqual(["Sport changed"]);
    expect(saved()).toEqual(["Sport: a:10, b:10, a:11"]);
    expect(find("list-save")).toBeNull();
    expect(rows()).toEqual(["a:10", "b:10", "a:11"]);
  });

  it("renames and deletes a list from Edit, which an empty list has too", () => {
    lists.createList("News");
    const id = lists.createList("Kids");
    open(listScreen(id));
    expect(text("list")).toContain("No channels in Kids.");
    press("list-edit");
    press("list-rename");
    expect(scenario.prompts.at(-1)).toMatchObject({ title: "Rename list", typed: "Kids" });
    answer("Rename", "news");
    expect(scenario.prompts.at(-1)?.message).toBe("There's already a list called News.");
    answer("Rename", "Kinderen");
    expect(saved()).toEqual(["News: ", "Kinderen: "]);

    press("list-delete");
    expect(scenario.alerts.at(-1)).toMatchObject({
      title: "Delete Kinderen?",
      message: "Its channels stay in Live.",
    });
    confirm("Delete");
    expect(saved()).toEqual(["News: "]);
    expect(scenario.did).toEqual(["back"]);
  });
});

describe("Favourites", () => {
  it("stay their own list while a favourite goes in and out of a list", async () => {
    await viewing.setFavourite(live("a:10"), true);
    open(FavouritesScreen);
    hold("favourite-a:10");
    expect(lastSheet()).toMatchObject({
      title: "NOS Journaal",
      options: ["New list…", "Cancel"],
    });
    choose("New list…");
    answer("Create", "News");
    expect(saved()).toEqual(["News: a:10"]);

    hold("favourite-a:10");
    choose("✓ News");
    expect(saved()).toEqual(["News: "]);
    const favourites = viewing.currentViewing()?.favourites ?? [];
    expect(favourites.map((each) => `${each.subscriptionId}:${each.id}`)).toEqual(["a:10"]);
    expect(scenario.did).toEqual([]);
  });
});
