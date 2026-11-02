import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { expect, it, vi } from "vitest";

// Where the tabs' screens lay out, as the window's side safe area changes: iPhone Duo's closed
// panel gives UIKit's status bar, top bar buttons and tab bar a column down its right side, and
// iPhone landscape a margin beside the Dynamic Island. The real tabs layout reads the insets; each
// tab's stack keeps its content inside them and the content's widths follow. Native layout itself
// needs the exact app on the simulators.

const scenario = vi.hoisted(() => ({
  window: { width: 466, height: 678, fontScale: 1 },
  insets: { top: 0, bottom: 34, left: 0, right: 84 },
}));

vi.mock("expo-router/native-tabs", () => {
  const NativeTabs = Object.assign(({ children }: { children?: unknown }) => children, {
    BottomAccessory: () => null,
    Trigger: Object.assign(() => null, { Icon: () => null, Label: () => null }),
  });
  return { NativeTabs };
});
vi.mock("expo-router", () => ({
  router: { push: () => undefined, dismiss: () => undefined, back: () => undefined },
  useNavigation: () => ({ dispatch: () => undefined }),
  useRootNavigationState: () => undefined,
  usePathname: () => "/live",
  useSegments: () => ["(tabs)", "live"],
}));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => scenario.insets }));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Settings: { get: () => ["en-US"] },
  useWindowDimensions: () => scenario.window,
}));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/accessory.tsx", () => ({ NowPlaying: () => null }));
vi.mock("../src/tab-bar.ts", () => ({ useVirtualisedScreen: () => false }));
vi.mock("../src/live-screen.tsx", () => ({ closeDetail: () => false }));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" }, watch: false, pip: false, external: false }),
}));

const { default: TabsLayout } = await import("../src/app/(tabs)/_layout.tsx");
const { useTabScreenOptions } = await import("../src/header.tsx");
const { useListWidth } = await import("../src/ui.tsx");

/** What a tab's screens get: their stack's content style and Live's list column. */
let shown: { content: unknown; list: ReturnType<typeof useListWidth> } | null = null;
function LiveStack() {
  const content = useTabScreenOptions("live")({ route: { name: "index" } }).contentStyle;
  shown = { content, list: useListWidth() };
  return null;
}

it("keeps the tabs' screens and their widths inside the side safe area as it changes", () => {
  // The tabs, and Live's stack beside them, as it draws under them in the app.
  const tabs = createRoot(document.createElement("div"));
  const root = createRoot(document.createElement("div"));
  React.act(() => tabs.render(React.createElement(TabsLayout)));
  React.act(() => root.render(React.createElement(LiveStack)));
  // Duo's closed panel: content 382 points wide, the column on the right kept clear.
  expect(shown).toEqual({
    content: { backgroundColor: "#000000", paddingLeft: 0, paddingRight: 84 },
    list: { split: false, width: 382, gutter: 16 },
  });

  // iPhone landscape: both sides clear, and the list a column of what is left beside the detail.
  scenario.window = { width: 874, height: 402, fontScale: 1 };
  scenario.insets = { top: 0, bottom: 21, left: 62, right: 62 };
  React.act(() => tabs.render(React.createElement(TabsLayout)));
  expect(shown).toEqual({
    content: { backgroundColor: "#000000", paddingLeft: 62, paddingRight: 62 },
    list: { split: true, width: 426, gutter: 20 },
  });

  // Without the tabs, as with no provider saved, nothing is held back.
  React.act(() => tabs.unmount());
  expect(shown).toEqual({
    content: { backgroundColor: "#000000", paddingLeft: 0, paddingRight: 0 },
    list: { split: true, width: 445, gutter: 20 },
  });
  React.act(() => root.unmount());
});
