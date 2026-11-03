import { Window } from "happy-dom";
import { act, createElement as h, useImperativeHandle, type ReactNode } from "react";
import { vi } from "vitest";

const ui = vi.hoisted(() => ({
  scroll: (_offset: number) => {},
  scrollToOffset: vi.fn(),
  focused: true,
  accessibilityFocus: vi.fn(),
  params: { query: "news", country: "" },
  push: vi.fn(),
  back: vi.fn(),
  input: (_s: string) => {},
  backHandler: (): boolean => false,
  dimensions: { width: 400, fontScale: 1 },
  status: { availability: "available", stale: false, error: null as string | null },
  links: [] as { id: string }[],
  retryChannels: vi.fn(),
  schedule: vi.fn(),
  search: vi.fn(),
  swipe: (_dx: number, _dy: number) => {},
}));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("expo-router", () => ({
  useIsFocused: () => ui.focused,
  useSegments: () => ["(tabs)", "(live)"],
  useLocalSearchParams: () => ui.params,
  router: {
    push: ui.push,
    back: ui.back,
    setParams: (p: Partial<typeof ui.params>) => Object.assign(ui.params, p),
  },
}));

vi.mock("../src/navigation/open.ts", () => ({
  destinationIn: () => "(live)",
  useOpenShared: () => vi.fn(),
}));

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

vi.mock("../src/navigation/screen.tsx", () => ({
  Screen: ({ children, detail }: { children: ReactNode; detail?: { content: ReactNode } }) =>
    h("main", {}, children, detail?.content),
}));

vi.mock("../src/guide/ui.tsx", () => ({
  text: {},
  guideColors: {},
  Press: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    style,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    style?: unknown;
  }) =>
    h(
      "button",
      {
        onClick: onPress,
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected,
        "data-style": JSON.stringify(style),
      },
      children,
    ),
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
  Still: ({ text }: { text: string }) => h("p", {}, text),
  Icon: () => null,
  Progress: () => null,
  OutOfDate: ({ label }: { label: string }) => h("p", {}, label),
}));

vi.mock("../src/live/chrome.tsx", () => ({
  useFrame: () => ({ layout: "bar", framed: {} }),
  Frame: ({ bar, children }: { bar: ReactNode; children: ReactNode }) =>
    h("main", {}, bar, children),
  Body: ({ children }: { children: ReactNode }) => h("div", {}, children),
  Bar: ({
    title,
    trailing,
    leading,
  }: {
    title: ReactNode;
    trailing?: ReactNode;
    leading: { onPress: () => void };
  }) => h("header", {}, h("button", { onClick: leading.onPress }, "Back"), title, trailing),
  TextButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
}));

vi.mock("react-native", () => ({
  View: ({ children, style }: { children: ReactNode; style?: unknown }) =>
    h("div", { "data-style": JSON.stringify(style) }, children),
  AccessibilityInfo: { sendAccessibilityEvent: ui.accessibilityFocus },
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => h("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (s: string) => void }) => {
    ui.input = onChangeText;

    return h("input", {
      value,
      onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
    });
  },
  BackHandler: {
    addEventListener: (_name: string, handler: () => boolean) => {
      ui.backHandler = handler;

      return {
        remove() {
          ui.backHandler = () => false;
        },
      };
    },
  },
  Text: ({ children, ref }: { children: ReactNode; ref?: React.Ref<HTMLSpanElement> }) =>
    h("span", { ref }, children),
  ScrollView: ({ children, style }: { children: ReactNode; style?: unknown }) =>
    h("div", { "data-style": JSON.stringify(style) }, children),
  useWindowDimensions: () => ui.dimensions,
  PanResponder: {
    create: (handlers: {
      onMoveShouldSetPanResponder: (event: null, gesture: { dx: number; dy: number }) => boolean;
      onPanResponderRelease: (event: null, gesture: { dx: number; dy: number }) => void;
    }) => {
      ui.swipe = (dx, dy) => {
        if (handlers.onMoveShouldSetPanResponder(null, { dx, dy }))
          handlers.onPanResponderRelease(null, { dx, dy });
      };

      return { panHandlers: {} };
    },
  },
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListHeaderComponent,
    onViewableItemsChanged,
    ref,
    onScroll,
  }: {
    ref?: React.Ref<{ scrollToOffset: typeof ui.scrollToOffset }>;
    onScroll?: (e: { nativeEvent: { contentOffset: { y: number } } }) => void;
    data: unknown[];
    renderItem: (p: { item: unknown; index: number }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    ListHeaderComponent?: ReactNode;
    onViewableItemsChanged?: (p: { viewableItems: { item: unknown }[] }) => void;
  }) => {
    useImperativeHandle(ref, () => ({ scrollToOffset: ui.scrollToOffset }));
    ui.scroll = (y) => onScroll?.({ nativeEvent: { contentOffset: { y } } });

    // Native viewability can report more than the contract permits. The screen must bound it.
    return h(
      "section",
      {},
      ListHeaderComponent,
      h(
        "button",
        {
          onClick: () =>
            onViewableItemsChanged?.({
              viewableItems: data.slice(0, 30).map((item) => ({ item })),
            }),
        },
        "Show visible",
      ),
      data.length
        ? data.map((item, index) => h("div", { key: index }, renderItem({ item, index })))
        : ListEmptyComponent,
    );
  },
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { sources: { state: store({ kind: "ready", sources: [] }) } };
});

vi.mock("../src/guide/guide-sources.ts", () => ({ guides: { useLinks: () => ui.links } }));

vi.mock("../src/guide/hooks.ts", () => ({
  useGuideStart() {},
  useListingRevision: () => 0,
  useProgramme: () => ({ pending: false, value: null, failed: false }),
}));

vi.mock("../src/guide/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    catalogueFailures: store(new Set<string>()),
    retryGuideChannels: ui.retryChannels,
    useGuideStatus() {},
    guide: {
      channels: () =>
        new Map([
          [
            "source",
            Array.from({ length: 40 }, (_, i) => ({
              key: `source:${i}`,
              id: String(i),
              title: `Channel ${i}`,
            })),
          ],
        ]),
      channel: (key: string) => ({ title: `Channel ${key.split(":").at(-1)}` }),
      withdrawals: { subscribe: () => () => {} },
      withdrawn: () => 0,
      status: () => ui.status,
      schedule: ui.schedule,
      search: ui.search,
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: ReturnType<typeof window.document.createElement>): {
    render(node: ReactNode): void;
    unmount(): void;
  };
};

export async function mount(node: ReactNode, resetWindow = true) {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Show visible")
      ?.click(),
  );

  const now = [...container.querySelectorAll("button")].find((b) => b.textContent === "Now");

  if (now && resetWindow) await act(async () => now.click());

  return {
    container,
    render: async (next: ReactNode) => act(async () => root.render(next)),
    close: async () => act(async () => root.unmount()),
    click: async (label: string) =>
      act(async () => {
        const button = [...container.querySelectorAll("button")].find(
          (b) => b.textContent === label || b.getAttribute("aria-label") === label,
        );

        if (!button) throw new Error(`Missing ${label}`);
        button.click();
      }),
  };
}

export { ui };
