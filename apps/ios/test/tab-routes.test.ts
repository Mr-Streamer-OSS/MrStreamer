import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the top bar's destinations land in navigation's state, from a tab and from over Search,
// as Expo Router 58 itself reduces them. What `openOnTabs` asks the router for is applied in order
// by the installed router's own destination resolver and stack and tab routers, on a state shaped
// like the app's: the root stack with the tabs and Search, each tab a stack. CI doesn't install
// the iOS app (pnpm-workspace.yaml leaves it out), so this runs where apps/ios/node_modules is.

const ios = join(import.meta.dirname, "..");
const installed = existsSync(join(ios, "node_modules/expo-router/package.json"));

type Intent = { readonly kind: "dismiss"; readonly count: number } | { kind: "push"; href: string };
const asked = vi.hoisted(() => [] as Intent[]);
vi.mock("expo-router", () => ({
  router: {
    dismiss: (count: number) => asked.push({ kind: "dismiss", count }),
    push: (href: string) => asked.push({ kind: "push", href }),
  },
}));
vi.mock("react-native", () => ({
  Image: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
}));
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF" } }));

const { openOnTabs, tabsAt } = await import("../src/header.tsx");

interface State {
  readonly stale: false;
  readonly type: "stack" | "tab";
  readonly key: string;
  readonly index: number;
  readonly routeNames: readonly string[];
  readonly routes: readonly {
    readonly key: string;
    readonly name: string;
    readonly state?: State;
  }[];
}
type Action = { readonly type: string; readonly payload?: object; readonly target?: string };
interface Expo {
  resolveNavigationDestination(options: object): Action;
  reduceNavigationTree(
    action: Action,
    registry: ReadonlyMap<string, object>,
    at: object,
  ): { handled: boolean; nextState: State };
  indexNavigationTree(state: State): { rootNode: object; nodes: Map<string, object> };
  resolveOrigin(root: object, nodes: Map<string, object>, registry: object): object;
  StackRouter(options: object): Router;
  TabRouter(options: object): Router;
}
interface Router {
  getStateForAction(state: State, action: Action, options: object): { state: State } | null;
}

function expo(): Expo {
  const require = createRequire(join(ios, "package.json"));
  const build = require.resolve("expo-router/package.json").replace("package.json", "build/");
  return {
    ...require(`${build}global-state/resolveNavigationDestination.js`),
    ...require(`${build}global-state/reduceNavigationTree.js`),
    ...require(`${build}react-navigation/routers/StackRouter.js`),
    ...require(`${build}react-navigation/routers/TabRouter.js`),
  } as Expo;
}

const TABS = ["(home)", "live", "films", "series"] as const;
const SCREENS = ["index", "settings", "downloads", "provider", "title/[id]"];

const stack = (key: string, names: readonly string[]): State => ({
  stale: false,
  type: "stack",
  key,
  index: names.length - 1,
  routeNames: SCREENS,
  routes: names.map((name) => ({ key: `${key}:${name}`, name })),
});

/** The app's root: the tabs on `tab`, Films showing a title's details, and `over` above them. */
function app(tab: (typeof TABS)[number], over: readonly string[] = []): State {
  const tabs: State = {
    stale: false,
    type: "tab",
    key: "tabs",
    index: TABS.indexOf(tab),
    routeNames: TABS,
    routes: TABS.map((name) => ({
      key: `tab:${name}`,
      name,
      state: stack(`stack:${name}`, name === "films" ? ["index", "title/[id]"] : ["index"]),
    })),
  };
  return {
    stale: false,
    type: "stack",
    key: "root",
    index: over.length,
    routeNames: ["(tabs)", "search", "connect", "offline", "proof"],
    routes: [
      { key: "root:tabs", name: "(tabs)", state: tabs },
      ...over.map((name) => ({ key: `root:${name}`, name })),
    ],
  };
}

const node = (route: string, children: readonly object[] = []) => ({
  route,
  type: children.length > 0 ? "layout" : "route",
  children,
  loadRoute: () => ({}),
});
const routeNode = node("", [
  node(
    "(tabs)",
    TABS.map((tab) =>
      node(
        tab,
        SCREENS.map((screen) => node(screen)),
      ),
    ),
  ),
  ...["search", "connect", "offline", "proof"].map((name) => node(name)),
]);

/** Runs what was asked, in order, as the router's queue does: each against the last state. */
function run(start: State, intents: readonly (Intent | { kind: "back" })[]): State {
  const { StackRouter, TabRouter, ...tree } = expo();
  const routers = { stack: StackRouter({}), tab: TabRouter({}) };
  let state = start;
  for (const intent of intents) {
    const registry = new Map<string, object>();
    const register = (each: State) => {
      const router = routers[each.type];
      registry.set(each.key, {
        reduce: (current: State, action: Action) =>
          router.getStateForAction(current, action, {
            routeNames: current.routeNames,
            routeParamList: {},
            routeGetIdList: {},
          }),
      });
      for (const route of each.routes) if (route.state) register(route.state);
    };
    register(state);
    const action: Action =
      intent.kind === "dismiss"
        ? { type: "POP", payload: { count: intent.count } }
        : intent.kind === "back"
          ? { type: "GO_BACK" }
          : tree.resolveNavigationDestination({
              targetState: targetOf(intent.href),
              navigationState: state,
              routeNode,
              registry,
              action: { type: "PUSH", payload: {} },
            });
    const index = tree.indexNavigationTree(state);
    const origin = tree.resolveOrigin(index.rootNode, index.nodes, registry);
    const reduced = tree.reduceNavigationTree(action, registry, { origin, tree: index });
    if (!reduced.handled) throw new Error(`${action.type} was not handled`);
    state = reduced.nextState;
  }
  return state;
}

/** "/live/settings" as the router's path parser gives it: the tabs, Live, Settings. */
function targetOf(href: string) {
  const [first, second] = href.split("/").slice(1);
  const [tab, screen] = second ? [first, second] : ["(home)", first];
  return {
    routes: [
      { name: "(tabs)", state: { routes: [{ name: tab, state: { routes: [{ name: screen }] } }] } },
    ],
  };
}

/** The keys of each stack and the tabs' selection, to compare whole states by. */
function shape(state: State): { root: string[]; tab: string; stacks: Record<string, string[]> } {
  const tabs = state.routes.find((route) => route.name === "(tabs)")!.state!;
  return {
    root: state.routes.map((route) => route.key),
    tab: tabs.routes[tabs.index]!.name,
    stacks: Object.fromEntries(
      tabs.routes.map((route) => [route.name, route.state!.routes.map((each) => each.key)]),
    ),
  };
}

beforeEach(() => {
  asked.length = 0;
});

describe.skipIf(!installed)("the top bar's destinations in Expo Router's own state", () => {
  it("closes Search and opens Settings on the existing Live stack, with one tabs", () => {
    const start = app("live", ["search"]);
    openOnTabs(tabsAt(start)!, "settings");
    const after = shape(run(start, asked));
    expect(after.root).toEqual(["root:tabs"]);
    expect(after.tab).toBe("live");
    expect(after.stacks["live"]).toEqual(["stack:live:index", expect.stringMatching(/^settings/)]);
    expect(after.stacks["films"]).toEqual(["stack:films:index", "stack:films:title/[id]"]);
  });

  it("opens Downloads over a title's details on Movies, and Back returns to those details", () => {
    const start = app("films");
    openOnTabs(tabsAt(start)!, "downloads");
    const opened = run(start, asked);
    expect(shape(opened).stacks["films"]).toEqual([
      "stack:films:index",
      "stack:films:title/[id]",
      expect.stringMatching(/^downloads/),
    ]);
    const back = shape(run(opened, [{ kind: "back" }]));
    expect(back.root).toEqual(["root:tabs"]);
    expect(back.stacks["films"]).toEqual(["stack:films:index", "stack:films:title/[id]"]);
  });

  it("finds the tabs nearest under what shows, not the first in history", () => {
    const start = app("series", ["search"]);
    expect(tabsAt(start)).toEqual({ tab: "series", above: 1 });
    expect(tabsAt({ index: 0, routes: [{ name: "connect" }] })).toBeNull();
    const twice = {
      index: 2,
      routes: [
        { name: "(tabs)", state: { index: 0, routes: [{ name: "(home)" }] } },
        { name: "search" },
        { name: "(tabs)", state: { index: 1, routes: [{ name: "(home)" }, { name: "live" }] } },
      ],
    };
    expect(tabsAt(twice)).toEqual({ tab: "live", above: 0 });
  });
});
