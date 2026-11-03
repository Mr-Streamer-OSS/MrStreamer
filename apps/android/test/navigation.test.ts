import { Window } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Paper A's navigation as the viewer meets it: the destinations along the bottom on a phone and
// down a rail from 600dp, with Search, Downloads and Settings opening on the stack of the
// destination showing. The real tabs layout, bar, rail and top app bar render with React DOM on a
// happy-dom window; React Native's views are elements, and the router records what it is asked.
// Expo Router's own tab and stack reducers (Back to Live, then out; a reselected tab back to its
// root) aren't installed in CI, so the layout's settings for them are checked here and their
// effect on a device.

const scenario = vi.hoisted(() => ({
  width: 412,
  segments: ["(tabs)", "(live)"] as string[],
  asked: [] as string[],
  /** What the tabs layout gave the navigator, but its children and bar. */
  navigator: {} as Record<string, unknown>,
  /** The layout's initial route, where the navigator opens. */
  initial: "",
}));

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");
  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
  };
  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, accessibilityRole, accessibilityState, onPress }: Props) =>
      h(
        tag,
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "aria-selected": accessibilityState?.selected,
          onClick: onPress,
        },
        children,
      );
  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    useWindowDimensions: () => ({ width: scenario.width, height: 900 }),
  };
});
vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));
vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");
  const insets = { top: 24, bottom: 16, left: 0, right: 0 };
  return {
    SafeAreaInsetsContext: createContext(insets),
    useSafeAreaInsets: () => insets,
  };
});
vi.mock("expo-router", () => ({
  router: {
    navigate: (href: string) => scenario.asked.push(`navigate ${href}`),
    back: () => scenario.asked.push("back"),
  },
  useSegments: () => scenario.segments,
}));
vi.mock("expo-router/js-tabs", async () => {
  const { Children, isValidElement } = await import("react");
  type Bar = (props: object) => ReactElement;
  const Screen: (props: { name: string }) => null = () => null;
  /** The navigator on its initial route, drawing only its bar. */
  const Tabs = ({
    tabBar,
    children,
    ...rest
  }: {
    tabBar: Bar;
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    scenario.navigator = rest;
    const routes = Children.toArray(children)
      .filter(isValidElement<{ name: string }>)
      .map(({ props: { name } }) => ({ key: `${name}-key`, name }));
    return tabBar({
      state: { index: routes.findIndex(({ name }) => name === scenario.initial), routes },
      descriptors: {},
      insets: { top: 24, bottom: 16, left: 0, right: 0 },
      emitter: {
        emit: ({ type, target }: { type: string; target: string }) => {
          scenario.asked.push(`${type} ${target}`);
          return { defaultPrevented: false };
        },
      },
      navigateToTab: (key: string) => scenario.asked.push(`show ${key}`),
    });
  };
  return { Tabs: Object.assign(Tabs, { Screen }) };
});

const window = new Window();
Object.assign(globalThis, { window, document: window.document });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REACT_DOM = "react-dom/client";
const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: object): { render(node: unknown): void; unmount(): void };
};

const { default: DestinationsLayout, unstable_settings } =
  await import("../src/app/(tabs)/_layout.tsx");
scenario.initial = unstable_settings.initialRouteName;
const { Screen } = await import("../src/navigation/screen.tsx");

let root: ReturnType<typeof createRoot> | null = null;

function show(node: ReactElement) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

const labels = (container: ReturnType<typeof show>, selector: string) =>
  Array.from(container.querySelectorAll(selector), (each) => each.getAttribute("aria-label"));

function press(container: ReturnType<typeof show>, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`No ${label}`);
  act(() => (button as unknown as { click(): void }).click());
}

beforeEach(() => {
  scenario.width = 412;
  scenario.segments = ["(tabs)", "(live)"];
  scenario.asked = [];
});
afterEach(() => {
  act(() => root?.unmount());
  window.document.body.innerHTML = "";
});

describe("the destinations", () => {
  it("open on Live along the bottom of a phone, and Back returns to Live before leaving", () => {
    const shown = show(createElement(DestinationsLayout));
    expect(labels(shown, '[aria-selected="true"]')).toEqual(["Live"]);
    expect(scenario.navigator).toMatchObject({ backBehavior: "initialRoute" });
    expect(labels(shown, '[role="tab"]')).toEqual(["Home", "Live", "Movies", "Series"]);
    expect(labels(shown, 'button:not([role="tab"])')).toEqual([]);
  });

  it("show another destination's stack as it was, and return the one showing to its root", () => {
    const shown = show(createElement(DestinationsLayout));
    press(shown, "Movies");
    press(shown, "Live");
    // The stack under a reselected tab answers its tabPress by returning to its root.
    expect(scenario.asked).toEqual([
      "tabPress movies-key",
      "show movies-key",
      "tabPress (live)-key",
    ]);
  });

  it("move to a rail from 600dp, with Search above and Downloads and Settings below", () => {
    scenario.width = 599;
    expect(labels(show(createElement(DestinationsLayout)), "button")).toHaveLength(4);
    act(() => root?.unmount());

    scenario.width = 600;
    const shown = show(createElement(DestinationsLayout));
    expect(labels(shown, "button")).toEqual([
      "Search",
      "Home",
      "Live",
      "Movies",
      "Series",
      "Downloads",
      "Settings",
    ]);
    press(shown, "Search");
    press(shown, "Settings");
    expect(scenario.asked).toEqual(["navigate /search", "navigate /settings"]);
  });
});

describe("a screen's top app bar", () => {
  it("opens Search, Downloads and Settings on the phone's destination showing, not beside the rail", () => {
    scenario.segments = ["(tabs)", "movies"];
    const shown = show(createElement(Screen, { title: "Movies" }));
    expect(labels(shown, "button")).toEqual(["Search", "Downloads", "Settings"]);
    press(shown, "Downloads");
    act(() => root?.unmount());
    scenario.segments = ["(tabs)", "(live)"];
    press(show(createElement(Screen, { title: "Live" })), "Search");
    expect(scenario.asked).toEqual(["navigate /movies/downloads", "navigate /search"]);
    act(() => root?.unmount());

    scenario.width = 840;
    expect(labels(show(createElement(Screen, { title: "Live" })), "button")).toEqual([]);
  });

  it("offers Back alone on a pushed screen", () => {
    const shown = show(createElement(Screen, { title: "Settings", pushed: true }));
    expect(labels(shown, "button")).toEqual(["Back"]);
    press(shown, "Back");
    expect(scenario.asked).toEqual(["back"]);
  });
});
