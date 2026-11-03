import { Window } from "happy-dom";
import { act, createElement as h, type ReactNode } from "react";
import { vi } from "vitest";

const ui = vi.hoisted(() => ({
  width: 400,
  fontScale: 1,
  params: { query: "news", country: "" },
  push: vi.fn(),
  schedule: vi.fn(),
  search: vi.fn(),
  visible: 30,
  stale: false,
  revision: 0,
  swipe: (_dx: number, _dy: number) => {},
}));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));

vi.mock("expo-router", () => ({
  useSegments: () => ["(tabs)", "(live)"],
  useLocalSearchParams: () => ui.params,
  router: {
    push: ui.push,
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
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => h("button", { onClick: onPress, "aria-label": accessibilityLabel }, children),
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
  Still: ({ text }: { text: string }) => h("p", {}, text),
  Field: ({ value, onChangeText }: { value: string; onChangeText: (s: string) => void }) =>
    h("input", {
      value,
      onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
    }),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => h("div", {}, children),
  Text: ({ children }: { children: ReactNode }) => h("span", {}, children),
  ScrollView: ({ children }: { children: ReactNode }) => h("div", {}, children),
  useWindowDimensions: () => ({ width: ui.width, fontScale: ui.fontScale }),
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
    onViewableItemsChanged,
  }: {
    data: unknown[];
    renderItem: (p: { item: unknown; index: number }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    onViewableItemsChanged?: (p: { viewableItems: { item: unknown }[] }) => void;
  }) => {
    // Native viewability can report more than the contract permits. The screen must bound it.
    return h(
      "section",
      {},
      h(
        "button",
        {
          onClick: () =>
            onViewableItemsChanged?.({
              viewableItems: data.slice(0, ui.visible).map((item) => ({ item })),
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

vi.mock("../src/guide/guide-sources.ts", () => ({ guides: { useLinks: () => [] } }));

vi.mock("../src/guide/hooks.ts", () => ({
  useGuideStart() {},
  useListingRevision: () => ui.revision,
  useProgramme: () => ({ pending: false, value: null, failed: false }),
}));

vi.mock("../src/guide/runtime.ts", () => ({
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
    status: () => ({ availability: "available", stale: ui.stale, error: null }),
    schedule: ui.schedule,
    search: ui.search,
  },
}));

const window = new Window();

Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: ReturnType<typeof window.document.createElement>): {
    render(node: ReactNode): void;
    unmount(): void;
  };
};

export async function mount(node: ReactNode) {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Show visible")
      ?.click(),
  );

  return {
    container,
    render: async (node: ReactNode) => act(async () => root.render(node)),
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
