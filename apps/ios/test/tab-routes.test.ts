import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the top bar's destinations go, from a tab and from over Search: which tab navigation's
// state has under what shows, and what the router is asked, in order. The router's own handling of
// those requests (a POP, then a PUSH onto the existing tab's stack) is Expo Router's, and was
// checked against its installed reducers outside this suite, which CI runs without the iOS install.

const asked = vi.hoisted(() => [] as string[]);
/** The window's safe area, as iOS reports it for the panel and orientation. */
const insets = vi.hoisted(() => ({ current: { top: 0, bottom: 0, left: 0, right: 0 } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => insets.current }));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("expo-router", () => ({
  router: {
    dismiss: (count: number) => asked.push(`dismiss ${count}`),
    push: (href: string) => asked.push(`push ${href}`),
  },
}));
vi.mock("react-native", () => ({
  Image: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
}));
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF" } }));

const { openOnTabs, tabStack, tabsAt, useTabScreenOptions } = await import("../src/header.tsx");

const TABS = ["(home)", "live", "films", "series"].map((name) => ({ name }));
/** The root stack: the tabs on `tab`, with `over` above them. */
const root = (tab: string, over: readonly string[] = []) => ({
  index: over.length,
  routes: [
    { name: "(tabs)", state: { index: TABS.findIndex((each) => each.name === tab), routes: TABS } },
    ...over.map((name) => ({ name })),
  ],
});

/** Opens `screen` from `state` and says what the router was asked. */
function open(state: Parameters<typeof tabsAt>[0], screen: "settings" | "downloads") {
  const at = tabsAt(state);
  if (!at) throw new Error("No tabs");
  openOnTabs(at, screen);
  return asked;
}

beforeEach(() => {
  asked.length = 0;
});

describe("the top bar's destinations", () => {
  it("close Search first, then open on the tab under it", () => {
    expect(open(root("live", ["search"]), "settings")).toEqual([
      "dismiss 1",
      "push /live/settings",
    ]);
  });

  it("open straight on the tab showing, Home's at the root", () => {
    expect(open(root("films"), "downloads")).toEqual(["push /films/downloads"]);
    asked.length = 0;
    expect(open(root("(home)"), "settings")).toEqual(["push /settings"]);
  });

  it("go by the tabs nearest under what shows, not the first in history", () => {
    const twice = {
      index: 2,
      routes: [
        { name: "(tabs)", state: { index: 0, routes: TABS } },
        { name: "search" },
        { name: "(tabs)", state: { index: 1, routes: TABS } },
      ],
    };
    expect(tabsAt(twice)).toEqual({ tab: "live", above: 0 });
  });

  it("find no tabs with no provider saved, where the root shows Connect and offline Downloads", () => {
    expect(tabsAt({ index: 1, routes: [{ name: "connect" }, { name: "offline" }] })).toBeNull();
  });
});

describe("a tab's own stack", () => {
  it("is found while another tab is selected, and under Search, for Live's iPad and Duo hand-back", () => {
    const live = { key: "live-stack", index: 1, routes: [{ name: "index" }, { name: "schedule" }] };
    const tabs = TABS.map((tab) => (tab.name === "live" ? { ...tab, state: live } : tab));
    const state = {
      index: 1,
      routes: [{ name: "(tabs)", state: { index: 2, routes: tabs } }, { name: "search" }],
    };
    expect(tabStack(state, "live")).toBe(live);
    expect(tabStack(state, "films")).toBeUndefined();
  });
});

describe("a tab's screens", () => {
  /** Where each tab's stack lays its screens' content, as the window's insets stand. */
  function content(root: ReturnType<typeof createRoot>) {
    const shown: unknown[] = [];
    function Stacks() {
      for (const tab of ["(home)", "live", "films", "series"] as const) {
        shown.push(useTabScreenOptions(tab)({ route: { name: "index" } }).contentStyle);
      }
      return null;
    }
    React.act(() => root.render(React.createElement(Stacks)));
    return shown.slice(-4);
  }

  it("keep their content out of the side column UIKit reserves, as iOS moves it", () => {
    const root = createRoot(document.createElement("div"));
    // iPhone Duo's closed panel: the status bar, top bar buttons and tab bar run down the right.
    insets.current = { top: 0, bottom: 34, left: 0, right: 84 };
    for (const style of content(root)) {
      expect(style).toEqual({ backgroundColor: "#000000", paddingLeft: 0, paddingRight: 84 });
    }
    // iPhone in landscape, with the Dynamic Island on the left.
    insets.current = { top: 0, bottom: 21, left: 62, right: 62 };
    for (const style of content(root)) {
      expect(style).toEqual({ backgroundColor: "#000000", paddingLeft: 62, paddingRight: 62 });
    }
    React.act(() => root.unmount());
  });
});
