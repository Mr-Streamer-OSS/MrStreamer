import { NativeTabs } from "expo-router/native-tabs";
import {
  router,
  useNavigation,
  usePathname,
  useRootNavigationState,
  useSegments,
} from "expo-router";
import { useMemo } from "react";
import { NowPlaying } from "../../accessory.tsx";
import {
  openOnTabs,
  openSearch,
  selectTab,
  tabsAt,
  tabStack,
  useCloseOnTabChange,
  type Tab,
} from "../../header.tsx";
import { t } from "../../i18n/navigation.ts";
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "../../key-commands.ts";
import { useInterfaceLanguage } from "../../language.ts";
import { closeDetail } from "../../live-screen.tsx";
import { usePlayback } from "../../playback.ts";
import { useVirtualisedScreen } from "../../tab-bar.ts";

/**
 * The tabs' keyboard shortcuts, while Watch is closed: ⌘1 to ⌘4, ⌘F, ⌘, and ⌘[, titled in the
 * interface language.
 */
const shortcuts = (): readonly Shortcut<Tab | "search" | "settings" | "back">[] => [
  { id: "(home)", input: "1", command: true, title: t("Home") },
  { id: "live", input: "2", command: true, title: t("Live") },
  { id: "films", input: "3", command: true, title: t("Movies") },
  { id: "series", input: "4", command: true, title: t("Series") },
  { id: "search", input: "f", command: true, title: t("Search") },
  { id: "settings", input: ",", command: true, title: t("Settings") },
  { id: "back", input: "[", command: true, title: t("Back") },
];

// The system tab bar, Liquid Glass from iOS 26: Home, Live, Movies and Series, with Search in
// every screen's top bar instead of a tab of its own. While Watch is closed with something in
// Picture in Picture, on AirPlay or set aside for Downloads or Settings, the now playing accessory
// sits above the bar. The bar shrinks as Home, the shelves of Movies and Series and their details
// scroll: iOS can't follow a virtualised list, as Live's and the poster grids are, so there it
// stays put. Selecting another tab closes the Downloads, Settings and provider form the last one
// had open (`useCloseOnTabChange`). With a keyboard, ⌘1 to ⌘4 select the tabs, ⌘F opens Search,
// ⌘, Settings and ⌘[ goes back, Live's detail column first (key-commands.ts). The labels and
// shortcuts follow the interface language as Settings changes it.
export default function TabsLayout() {
  const { locale } = useInterfaceLanguage();
  // Made again for a new language only: the native module installs them whenever they change.
  const titled = useMemo(shortcuts, [locale]);
  useCloseOnTabChange();
  const { phase, watch, pip, external, aside } = usePlayback();
  const segments: readonly string[] = useSegments();
  const virtualised = useVirtualisedScreen();
  const accessory = phase.kind !== "idle" && !watch && (pip || external || aside);
  const shrinks = ["(home)", "films", "series"].includes(segments[1] ?? "") && !virtualised;
  const navigation = useNavigation();
  const state = useRootNavigationState();
  const pathname = usePathname();
  useShortcuts(watch ? NO_SHORTCUTS : titled, (id) => {
    const at = tabsAt(state);
    if (!at) return;
    if (id === "search") {
      if (pathname !== "/search") openSearch();
    } else if (id === "settings") {
      if (!pathname.endsWith("/settings")) openOnTabs(at, "settings");
    } else if (id === "back") {
      // Live's detail column goes back first, while it is what shows of Live's stack. At a tab's
      // root there is no Back, as on the iPhone: the tabs' own history isn't followed.
      const pushed = at.above > 0 || Boolean(tabStack(state, at.tab)?.index);
      if (!pushed && at.tab === "live" && closeDetail()) return;
      if (pushed) router.back();
    } else {
      selectTab(navigation, state, id);
    }
  });
  return (
    <NativeTabs
      tintColor="#FFFFFF"
      backgroundColor="#000000"
      disableTransparentOnScrollEdge
      minimizeBehavior={shrinks ? "onScrollDown" : "never"}
    >
      {accessory ? (
        <NativeTabs.BottomAccessory>
          <NowPlaying />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="(home)" testID="tab-home">
        <NativeTabs.Trigger.Icon sf="house.fill" />
        <NativeTabs.Trigger.Label>{t("Home")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="live" testID="tab-live">
        <NativeTabs.Trigger.Icon sf="play.tv" />
        <NativeTabs.Trigger.Label>{t("Live")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="films" testID="tab-films">
        <NativeTabs.Trigger.Icon sf="film" />
        <NativeTabs.Trigger.Label>{t("Movies")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="series" testID="tab-series">
        <NativeTabs.Trigger.Icon sf="rectangle.stack" />
        <NativeTabs.Trigger.Label>{t("Series")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
