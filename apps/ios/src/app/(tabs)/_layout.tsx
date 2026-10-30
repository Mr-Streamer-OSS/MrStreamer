import { NativeTabs } from "expo-router/native-tabs";
import {
  router,
  useNavigation,
  usePathname,
  useRootNavigationState,
  useSegments,
} from "expo-router";
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
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "../../key-commands.ts";
import { closeDetail } from "../../live-screen.tsx";
import { usePlayback } from "../../playback.ts";
import { useVirtualisedScreen } from "../../tab-bar.ts";

/** The tabs' keyboard shortcuts, while Watch is closed: ⌘1 to ⌘4, ⌘F, ⌘, and ⌘[. */
const SHORTCUTS: readonly Shortcut<Tab | "search" | "settings" | "back">[] = [
  { id: "(home)", input: "1", command: true, title: "Home" },
  { id: "live", input: "2", command: true, title: "Live" },
  { id: "films", input: "3", command: true, title: "Movies" },
  { id: "series", input: "4", command: true, title: "Series" },
  { id: "search", input: "f", command: true, title: "Search" },
  { id: "settings", input: ",", command: true, title: "Settings" },
  { id: "back", input: "[", command: true, title: "Back" },
];

// The system tab bar, Liquid Glass from iOS 26: Home, Live, Movies and Series, with Search in
// every screen's top bar instead of a tab of its own. While Watch is closed with something in
// Picture in Picture, on AirPlay or set aside for Downloads or Settings, the now playing accessory
// sits above the bar. The bar shrinks as Home, the shelves of Movies and Series and their details
// scroll: iOS can't follow a virtualised list, as Live's and the poster grids are, so there it
// stays put. Selecting another tab closes the Downloads, Settings and provider form the last one
// had open (`useCloseOnTabChange`). With a keyboard, ⌘1 to ⌘4 select the tabs, ⌘F opens Search,
// ⌘, Settings and ⌘[ goes back, Live's detail column first (key-commands.ts).
export default function TabsLayout() {
  useCloseOnTabChange();
  const { phase, watch, pip, external, aside } = usePlayback();
  const segments: readonly string[] = useSegments();
  const virtualised = useVirtualisedScreen();
  const accessory = phase.kind !== "idle" && !watch && (pip || external || aside);
  const shrinks = ["(home)", "films", "series"].includes(segments[1] ?? "") && !virtualised;
  const navigation = useNavigation();
  const state = useRootNavigationState();
  const pathname = usePathname();
  useShortcuts(watch ? NO_SHORTCUTS : SHORTCUTS, (id) => {
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
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="live" testID="tab-live">
        <NativeTabs.Trigger.Icon sf="play.tv" />
        <NativeTabs.Trigger.Label>Live</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="films" testID="tab-films">
        <NativeTabs.Trigger.Icon sf="film" />
        <NativeTabs.Trigger.Label>Movies</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="series" testID="tab-series">
        <NativeTabs.Trigger.Icon sf="rectangle.stack" />
        <NativeTabs.Trigger.Label>Series</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
