import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The keyboard shortcuts as the tabs offer them to the native key commands module: which keys are
// listed, and what each press asks of navigation. The module itself, iOS's listing while ⌘ is held
// and the keys reaching it are native, and need the exact app on an iPad or Duo with a keyboard.

type Shortcut = { id: string; input: string; command: boolean; title: string };

const scenario = vi.hoisted(() => ({
  installed: [] as Shortcut[],
  press: null as ((event: { id: string }) => void) | null,
  did: [] as unknown[],
  state: undefined as object | undefined,
  pathname: "/live",
  watch: false,
  detailOpen: false,
  canGoBack: true,
}));

vi.mock("expo-router/native-tabs", () => {
  const NativeTabs = Object.assign(() => null, {
    BottomAccessory: () => null,
    Trigger: Object.assign(() => null, { Icon: () => null, Label: () => null }),
  });
  return { NativeTabs };
});
vi.mock("expo-router", async () => {
  const navigation = { dispatch: (action: unknown) => scenario.did.push(action) };
  return {
    router: {
      push: (href: unknown) => scenario.did.push(`push ${String(href)}`),
      dismiss: (count: number) => scenario.did.push(`dismiss ${count}`),
      back: () => scenario.did.push("back"),
      canGoBack: () => scenario.canGoBack,
    },
    useNavigation: () => navigation,
    useRootNavigationState: () => scenario.state,
    usePathname: () => scenario.pathname,
    useSegments: () => ["(tabs)", "live"],
  };
});
vi.mock("react-native", () => ({
  Image: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
}));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF" } }));
vi.mock("../src/accessory.tsx", () => ({ NowPlaying: () => null }));
vi.mock("../src/tab-bar.ts", () => ({ useVirtualisedScreen: () => false }));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({
    phase: { kind: "idle" },
    watch: scenario.watch,
    pip: false,
    external: false,
    aside: false,
  }),
}));
vi.mock("../src/live-screen.tsx", () => ({
  closeDetail: () => {
    const open = scenario.detailOpen;
    if (open) scenario.did.push("close detail");
    scenario.detailOpen = false;
    return open;
  },
}));

Object.assign(globalThis, {
  expo: {
    modules: {
      KeyCommands: {
        set: (shortcuts: Shortcut[]) => {
          scenario.installed = shortcuts;
        },
        addListener: (_event: "command", listener: (event: { id: string }) => void) => {
          scenario.press = listener;
          return { remove: () => (scenario.press = null) };
        },
      },
    },
  },
});

const { default: TabsLayout } = await import("../src/app/(tabs)/_layout.tsx");

const TABS = ["(home)", "live", "films", "series"];
/** The root stack: the tabs on `tab`, Live's stack `live` deep, with `over` above the tabs. */
function root(tab: string, live = 1, over: readonly string[] = []) {
  const routes = TABS.map((name) =>
    name === "live"
      ? {
          name,
          state: {
            key: "live-stack",
            index: live - 1,
            routes: ["index", "schedule", "programme"].slice(0, live).map((each) => ({
              name: each,
            })),
          },
        }
      : { name },
  );
  return {
    index: over.length,
    routes: [
      { name: "(tabs)", state: { key: "tabs", index: TABS.indexOf(tab), routes } },
      ...over.map((name) => ({ name })),
    ],
  };
}

let view: ReturnType<typeof createRoot>;
async function draw() {
  await React.act(async () => view.render(React.createElement(TabsLayout)));
}
async function press(id: string) {
  scenario.did = [];
  await React.act(async () => scenario.press?.({ id }));
  return scenario.did;
}

beforeEach(() => {
  Object.assign(scenario, {
    installed: [],
    press: null,
    did: [],
    state: root("live"),
    pathname: "/live",
    watch: false,
    detailOpen: false,
    canGoBack: true,
  });
  view = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await React.act(async () => view.unmount());
});

describe("the tabs' keyboard shortcuts", () => {
  it("lists ⌘1 to ⌘4, ⌘F, ⌘, and ⌘[ while Watch is closed, and none while it shows", async () => {
    await draw();
    expect(scenario.installed.map(({ input, command, title }) => [input, command, title])).toEqual([
      ["1", true, "Home"],
      ["2", true, "Live"],
      ["3", true, "Movies"],
      ["4", true, "Series"],
      ["f", true, "Search"],
      [",", true, "Settings"],
      ["[", true, "Back"],
    ]);
    scenario.watch = true;
    await draw();
    expect(scenario.installed).toEqual([]);
  });

  it("selects a tab as its button does, closing Search over the tabs first", async () => {
    await draw();
    expect(await press("films")).toEqual([
      { type: "JUMP_TO", payload: { name: "films" }, target: "tabs" },
    ]);
    scenario.state = root("films", 1, ["search"]);
    await draw();
    expect(await press("live")).toEqual([
      "dismiss 1",
      { type: "JUMP_TO", payload: { name: "live" }, target: "tabs" },
    ]);
  });

  it("opens Search and the tab's Settings, but not over themselves", async () => {
    await draw();
    expect(await press("search")).toEqual(["push /search"]);
    expect(await press("settings")).toEqual(["push /live/settings"]);
    scenario.pathname = "/live/settings";
    await draw();
    expect(await press("settings")).toEqual([]);
  });

  it("goes back from Live's detail column first, then as the stack's Back does", async () => {
    scenario.detailOpen = true;
    await draw();
    expect(await press("back")).toEqual(["close detail"]);
    expect(await press("back")).toEqual(["back"]);
    scenario.detailOpen = true;
    scenario.state = root("live", 2);
    await draw();
    // A screen pushed over Live's list goes first; the column stays as it was.
    expect(await press("back")).toEqual(["back"]);
    expect(scenario.detailOpen).toBe(true);
  });
});
