import {
  router,
  useNavigation,
  useRootNavigationState,
  useRoute,
  type NativeStackHeaderItem,
  type NativeStackNavigationOptions,
} from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { useEffect } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { colors } from "./ui.tsx";

// The top bar every tab's screens share, layout A: the brand on the left, after the system's back
// button on a pushed screen, and Search, Downloads and Settings on the right as the system's own
// glass buttons. Downloads, Settings and the provider form open on the tab they were asked from;
// leaving that tab closes them again, while Movies' and Series' details stay. Search opens above
// the tabs (`app/search.tsx`) and closes back to the screen it opened over.

const TABS = ["(home)", "live", "films", "series"] as const;

/** A tab of the system's tab bar, with its own stack. */
export type Tab = (typeof TABS)[number];

/** A screen the top bar pushes on the tab it shows on. */
export type TabScreen = "downloads" | "settings" | "provider";

const SHARED: readonly string[] = ["downloads", "settings", "provider"] satisfies TabScreen[];

const BASE = { "(home)": "", live: "/live", films: "/films", series: "/series" } as const;

/** Where `screen` opens on `tab`: Home's at the root, the others' under their tab. */
export const tabHref = (tab: Tab, screen: TabScreen) => `${BASE[tab]}/${screen}` as const;

/** Whether a route names a tab. */
const isTab = (segment: string | undefined): segment is Tab => TABS.some((tab) => tab === segment);

/** Navigation state as far as finding the tabs needs it. */
interface Navigated {
  readonly index?: number;
  readonly routes: readonly { readonly name: string; readonly state?: Navigated }[];
}

/** The tab selected in the tabs `state` holds, or null when it holds none. */
function tabIn(state: Navigated | undefined): Tab | null {
  for (const route of state?.routes ?? []) {
    if (route.name === "(tabs)") {
      const tabs = route.state;
      const name = tabs?.routes[tabs.index ?? 0]?.name;
      return isTab(name) ? name : "(home)";
    }
    const found = tabIn(route.state);
    if (found) return found;
  }
  return null;
}

/**
 * The tab selected in the tabs, also under a screen over all of them such as Search, read from
 * navigation's own state. Null when there are no tabs: with no provider saved, the root shows
 * Connect and offline Downloads instead.
 */
export function useTab(): Tab | null {
  return tabIn(useRootNavigationState());
}

/** Search, over the tabs. What it opens goes on the tab under it. */
export function openSearch() {
  router.push("/search");
}

const ACTIONS: readonly {
  readonly screen: "search" | "downloads" | "settings";
  readonly label: string;
  readonly symbol: SFSymbol;
}[] = [
  { screen: "search", label: "Search", symbol: "magnifyingglass" },
  { screen: "downloads", label: "Downloads", symbol: "arrow.down.circle" },
  { screen: "settings", label: "Settings", symbol: "gearshape" },
];

/** The three buttons, less the one for the screen they show on. */
function actions(tab: Tab, current: string): NativeStackHeaderItem[] {
  return ACTIONS.filter(({ screen }) => screen !== current).map(({ screen, label, symbol }) => ({
    type: "button",
    label,
    icon: { type: "sfSymbol", name: symbol },
    // The same item on the next screen, so the glass group carries over as a screen is pushed.
    identifier: screen,
    onPress: () => (screen === "search" ? openSearch() : router.push(tabHref(tab, screen))),
  }));
}

/**
 * The options every screen of `tab`'s stack starts from, as its layout's `screenOptions`: black,
 * white, the brand and the three buttons. Screens set their own title and transparency.
 */
export function tabScreenOptions(tab: Tab) {
  return ({ route }: { route: { name: string } }): NativeStackNavigationOptions => ({
    contentStyle: { backgroundColor: "#000000" },
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
 * Closes what the top bar pushed on the calling tab's stack as the viewer leaves for another tab,
 * as Home always did: Downloads, Settings and the provider form, and anything above them. What
 * was under them, such as Movies' details, stays. A screen over all the tabs, as Search or Runtime
 * proof, isn't leaving the tab, so it leaves them open to go back to.
 */
export function useCloseOnLeave() {
  const navigation = useNavigation();
  const { key } = useRoute();
  useEffect(
    () =>
      navigation.addListener("blur", () => {
        const tabs = navigation.getState();
        if (!tabs || tabs.routes[tabs.index]?.key === key) return;
        const stack = tabs.routes.find((route) => route.key === key)?.state;
        if (!stack?.key) return;
        const first = stack.routes.findIndex((route) => SHARED.includes(route.name));
        if (first < 1) return;
        navigation.dispatch({
          type: "POP",
          payload: { count: stack.routes.length - first },
          target: stack.key,
        });
      }),
    [navigation, key],
  );
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
