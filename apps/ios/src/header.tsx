import {
  router,
  useNavigation,
  useRootNavigationState,
  type NativeStackHeaderItem,
  type NativeStackNavigationOptions,
} from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useMemo, useRef } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { DownloadStatusButton } from "./download-status.tsx";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/navigation.ts";
import { tabSides } from "./content-width.ts";
import { useStore } from "./store.ts";
import { colors } from "./ui.tsx";

// The top bar every tab's screens share, layout A: the brand on the left, after the system's back
// button on a pushed screen, and Search, Settings and Downloads on the right. UIKit places the
// custom Downloads status after the system's Search and Settings buttons. Downloads, Settings and
// its provider form and Licences open on the tab they were asked from; leaving that tab closes
// them again, while Movies' and Series' details stay. Search opens above the tabs
// (`app/search.tsx`) and closes back to the screen it opened over.

const TABS = ["(home)", "live", "films", "series"] as const;

/** A tab of the system's tab bar, with its own stack. */
export type Tab = (typeof TABS)[number];

/** A screen the top bar pushes on the tab it shows on. */
export type TabScreen = "downloads" | "settings" | "provider" | "licences" | "licence";

const SHARED: readonly string[] = [
  "downloads",
  "settings",
  "provider",
  "licences",
  "licence",
] satisfies TabScreen[];

const BASE = { "(home)": "", live: "/live", films: "/films", series: "/series" } as const;

/** Where `screen` opens on `tab`: Home's at the root, the others' under their tab. */
export const tabHref = (tab: Tab, screen: TabScreen) => `${BASE[tab]}/${screen}` as const;

/** Whether a route names a tab. */
const isTab = (segment: string | undefined): segment is Tab => TABS.some((tab) => tab === segment);

/** Navigation state as far as finding the tabs and their stacks needs it. */
interface Navigated {
  readonly key?: string;
  readonly index?: number;
  readonly routes: readonly {
    readonly key?: string;
    readonly name: string;
    readonly params?: object | undefined;
    readonly state?: Navigated;
  }[];
}

/**
 * Where the tabs are: the tab selected in them, and how many screens over all the tabs, such as
 * Search, lie above them in their stack.
 */
export interface TabsAt {
  readonly tab: Tab;
  readonly above: number;
}

/**
 * The `(tabs)` route nearest under what shows, in navigation's `state`: down the focused routes,
 * the one at or below each stack's focus, with how many routes lie above it in that stack.
 */
function nearestTabs(
  state: Navigated | undefined,
): { readonly tabs: Navigated | undefined; readonly above: number } | null {
  if (!state) return null;
  const focus = state.index ?? state.routes.length - 1;
  for (let at = focus; at >= 0; at--) {
    const route = state.routes[at];
    if (route?.name === "(tabs)") return { tabs: route.state, above: focus - at };
  }
  return nearestTabs(state.routes[focus]?.state);
}

/**
 * The tabs nearest under what shows, in navigation's `state`, as `nearestTabs` finds them. Null
 * when there are none: with no provider saved, the root shows Connect and offline Downloads
 * instead.
 */
export function tabsAt(state: Navigated | undefined): TabsAt | null {
  const found = nearestTabs(state);
  if (!found) return null;
  const name = found.tabs?.routes[found.tabs.index ?? 0]?.name;
  return { tab: isTab(name) ? name : "(home)", above: found.above };
}

/** `tab`'s own stack in navigation's `state`, under the tabs nearest under what shows. */
export function tabStack(state: Navigated | undefined, tab: Tab): Navigated | undefined {
  return nearestTabs(state)?.tabs?.routes.find((route) => route.name === tab)?.state;
}

/** The tabs under what shows, from navigation's own state, as `tabsAt` finds them. */
export function useTabs(): TabsAt | null {
  return tabsAt(useRootNavigationState());
}

/**
 * Opens `screen` on the selected tab's own stack, from anywhere over the tabs: the screens above
 * them close first, so it goes on top of what that tab showed and Back returns there. The router
 * runs both in the order asked, each against the state the one before left.
 */
export function openOnTabs({ tab, above }: TabsAt, screen: TabScreen) {
  if (above > 0) router.dismiss(above);
  router.push(tabHref(tab, screen));
}

/**
 * Selects `tab` as its button in the tab bar does, keeping its stack, from anywhere over the tabs:
 * the screens above them close first. `navigation` is any navigation the tabs are under.
 */
export function selectTab(
  navigation: { dispatch(action: { type: string; payload: object; target: string }): void },
  state: Navigated | undefined,
  tab: Tab,
) {
  const found = nearestTabs(state);
  const target = found?.tabs?.key;
  if (!found || !target) return;
  if (found.above > 0) router.dismiss(found.above);
  navigation.dispatch({ type: "JUMP_TO", payload: { name: tab }, target });
}

/** Search, over the tabs. What it opens goes on the tab under it. */
export function openSearch() {
  router.push("/search");
}

const ACTIONS: readonly {
  readonly screen: "search" | "downloads" | "settings";
  readonly label: Parameters<typeof t>[0];
  readonly symbol: SFSymbol;
}[] = [
  { screen: "search", label: "Search", symbol: "magnifyingglass" },
  { screen: "downloads", label: "Downloads", symbol: "arrow.down.circle" },
  { screen: "settings", label: "Settings", symbol: "gearshape" },
];

/** The three buttons, less the one for the screen they show on, in the interface language. */
function actions(tab: Tab, current: string): NativeStackHeaderItem[] {
  return ACTIONS.filter(({ screen }) => screen !== current).map(({ screen, label, symbol }) =>
    screen === "downloads"
      ? {
          type: "custom",
          element: <DownloadStatusButton onPress={() => router.push(tabHref(tab, screen))} />,
        }
      : {
          type: "button",
          label: t(label),
          icon: { type: "sfSymbol", name: symbol },
          // The same item on the next screen, so the glass group carries over as a screen is pushed.
          identifier: screen,
          onPress: () => (screen === "search" ? openSearch() : router.push(tabHref(tab, screen))),
        },
  );
}

/**
 * The options every screen of `tab`'s stack starts from, as its layout's `screenOptions`: black,
 * white, the brand and the three buttons. Screens set their own title and transparency.
 * Content stays inside the window's `left` and `right` safe-area insets, the side column where
 * UIKit puts the status bar, the header's buttons and the tab bar on iPhone Duo's narrow panel
 * and beside the Dynamic Island in iPhone landscape. They are 0 on iPhone and iPad portrait.
 */
export function tabScreenOptions(tab: Tab, { left, right } = { left: 0, right: 0 }) {
  return ({ route }: { route: { name: string } }): NativeStackNavigationOptions => ({
    contentStyle: { backgroundColor: "#000000", paddingLeft: left, paddingRight: right },
    headerTintColor: "#FFFFFF",
    headerTitleStyle: { color: "#FFFFFF" },
    // The brand takes the left side; a pushed screen keeps the system's back button beside it.
    headerBackVisible: true,
    unstable_headerLeftItems: () => [
      { type: "custom", element: <Brand />, hidesSharedBackground: true },
    ],
    unstable_headerRightItems: () => actions(tab, route.name),
  });
}

/**
 * `tabScreenOptions(tab)` for a tab's stack layout, with `tabSides`, made again when the
 * interface language or those insets change: React Navigation keeps the other tabs'
 * stacks from rendering again on their own, so their buttons' labels would keep the language
 * they were made in.
 */
export function useTabScreenOptions(tab: Tab) {
  const locale = useLocale();
  const sides = useStore(tabSides);
  return useMemo(() => tabScreenOptions(tab, sides), [tab, locale, sides]);
}

/**
 * Closes what the top bar pushed on a tab's stack once another tab is selected, as Home always
 * did: Downloads, Settings, the provider form and Licences, and anything above them. What was
 * under them, such as Movies' details, stays. Called once, by the tabs' layout. It follows which
 * tab navigation's state selects, not a tab's blur: Search over the tabs blurs the tab first
 * without changing the selection, so nothing closes then, and a Search result in another tab
 * closes Search and selects that tab in one step, with no second blur to see.
 */
export function useCloseOnTabChange() {
  const navigation = useNavigation();
  const tabs = nearestTabs(useRootNavigationState())?.tabs;
  const selected = tabs?.routes[tabs.index ?? 0]?.key;
  const shown = useRef(selected);
  useEffect(() => {
    const left = shown.current;
    shown.current = selected;
    if (!tabs || !left || left === selected) return;
    const stack = tabs.routes.find((route) => route.key === left)?.state;
    if (!stack?.key) return;
    const focus = stack.index ?? stack.routes.length - 1;
    const top = stack.routes[focus]?.key;
    const first = stack.routes.findIndex((route) => SHARED.includes(route.name));
    if (!top || first < 1 || first > focus) return;
    // From the stack's top screen down to the first shared one. The tabs' navigation names its
    // own route as the action's source, which the stack can't find among its screens and then
    // pops nothing; the stack's own top screen as the source is what it pops from.
    navigation.dispatch({
      type: "POP",
      payload: { count: focus - first + 1 },
      source: top,
      target: stack.key,
    });
  }, [navigation, tabs, selected]);
}

/** The mark and the name, as the desktop's logo shows them. */
function Brand() {
  return (
    <View style={styles.brand} accessible accessibilityLabel="Mr. Streamer">
      <Image source={require("../assets/mark.png") as number} style={styles.mark} />
      <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.4}>
        Mr. Streamer
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: "row", alignItems: "center", gap: 6 },
  mark: { width: 20, height: 20 },
  name: { color: colors.text, fontSize: 17, fontWeight: "700" },
});
