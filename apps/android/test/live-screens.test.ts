import { Window } from "happy-dom";
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const view = ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    h(onPress ? "button" : "div", { onClick: onPress }, children);

  return {
    View: view,
    Text: view,
    ScrollView: view,
    Pressable: view,
    TextInput: view,
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
    }: {
      data: unknown[];
      renderItem: (value: { item: unknown; index: number }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
    }) =>
      h(
        "div",
        {},
        ListHeaderComponent,
        data.length
          ? data.map((item, i) => h("div", { key: i }, renderItem({ item, index: i })))
          : ListEmptyComponent,
        ListFooterComponent,
      ),
    BackHandler: { addEventListener: () => ({ remove() {} }) },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

const params = vi.hoisted(() => ({ id: "custom", country: "" }));

vi.mock("expo-router", () => ({
  useSegments: () => ["(tabs)", "(live)"],
  useLocalSearchParams: () => params,
  useIsFocused: () => true,
  router: { back() {}, push: vi.fn() },
}));

vi.mock("../src/ui/focus.ts", () => ({
  useKeyboardFocus: () => ({ focused: false, handlers: {} }),
}));

vi.mock("../src/ui/icon-button.tsx", () => ({ IconButton: () => null }));

vi.mock("../src/ui/top-app-bar.tsx", () => ({ TopAppBar: () => null }));

vi.mock("../src/ui/sheet.tsx", () => ({ Sheet: () => null }));

vi.mock("../src/connect/connect-screen.tsx", () => ({ ConnectScreen: () => null }));

vi.mock("../src/navigation/screen.tsx", () => ({
  Screen: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../src/live/chrome.tsx", () => {
  const view = ({ children }: { children?: ReactNode }) => children;

  return {
    RED: "red",
    RAISED_RULE: "gray",
    Body: view,
    Frame: ({ children, bar }: { children: ReactNode; bar: ReactNode }) =>
      h("div", {}, bar, children),
    Bar: ({ trailing }: { trailing: ReactNode }) => trailing,
    SheetTitle: view,
    FitSheet: () => null,
    SheetRow: () => null,
    TextButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
      h("button", { onClick: onPress }, label),
    Dialog: ({ title, actions }: { title: string; actions: ReactNode }) =>
      h("div", {}, title, actions),
    Snackbar: () => null,
    StatusLine: () => null,
    useFrame: () => ({ layout: "bar", framed: {} }),
    useLargeText: () => false,
    useGaps: () => ({}),
  };
});

vi.mock("../src/player/instance.ts", () => ({ player: { play: vi.fn() } }));

vi.mock("../src/live/ui.tsx", async (importOriginal) => ({
  Empty: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) =>
    h("div", {}, title, body, action),
  NavRow: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
  Channel: (await importOriginal<typeof import("../src/live/ui.tsx")>()).Channel,
  ListsSheet: () => null,
  StillRows: () => null,
  Badge: () => null,
  Lines: () => null,
  NameDialog: () => null,
  Note: () => null,
  GapRows: () => null,
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { sources: { state: store({ kind: "ready", sources: [] }) } };
});

vi.mock("../src/live/runtime.ts", async () => {
  const { listsOwner } = await import("../src/live/store.ts");

  return {
    lists: listsOwner({ readJson: () => null, writeJson() {} }, () => ({
      kind: "ready",
      sources: [],
    })),
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleName = "react-dom/client";

const { createRoot } = (await import(moduleName)) as {
  createRoot(container: ReturnType<typeof window.document.createElement>): {
    render(node: ReactNode): void;
  };
};

const { ListScreen } = await import("../src/live/list-screen.tsx");
const { LiveScreen } = await import("../src/live/screens.tsx");
const { sources } = await import("../src/bootstrap/sources.ts");
const { FAVOURITES } = await import("../src/live/store.ts");
const { lists } = await import("../src/live/runtime.ts");
const container = window.document.createElement("div");
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.render(null));
  params.country = "";
  sources.state.set({ kind: "ready", sources: [] });
});

it("offers Edit, Rename and Delete for an empty custom list", async () => {
  lists.state.set({ kind: "ready", lists: [{ id: "custom", name: "Empty", entries: [] }] });
  await act(async () => root.render(h(ListScreen)));

  const edit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit",
  );

  expect(edit).toBeDefined();
  await act(async () => edit!.click());
  expect(container.textContent).toContain("Rename");
  expect(container.textContent).toContain("Delete list");
});

it("shows a failed read and retry on Live and For you without claiming no favourites", async () => {
  lists.state.set({ kind: "failed", lists: [] });
  await act(async () => root.render(h(LiveScreen)));
  expect(container.textContent).toContain("Couldn't read your lists.");
  expect(container.textContent).toContain("Try again");

  const tab = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "For you",
  );

  await act(async () => tab!.click());
  expect(container.textContent).toContain("Couldn't read your lists.");
  expect(container.textContent).not.toContain("No favourites yet.");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Try again")!
      .click(),
  );
  expect(container.textContent).not.toContain("Couldn't read your lists.");
  expect(container.textContent).toContain("No favourites yet.");
});

it("keeps an unavailable favourite and its reason in For you with a country selected", async () => {
  params.country = "Belgium";
  sources.state.set({ kind: "ready", sources: [] });
  lists.state.set({
    kind: "ready",
    lists: [
      {
        id: FAVOURITES,
        name: "Favourites",
        entries: [{ sourceId: "removed", channelId: "news", title: "Saved News" }],
      },
    ],
  });
  await act(async () => root.render(h(LiveScreen)));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "For you")!
      .click(),
  );
  expect(container.textContent).toContain("Saved News");
  expect(container.textContent).toContain("Its provider was removed.");
});

it("opens Settings from the Providers shortcut", async () => {
  const { router } = await import("expo-router");
  await act(async () => root.render(h(LiveScreen)));

  const providers = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Providers",
  );

  expect(providers).toBeDefined();
  await act(async () => providers!.click());
  expect(router.push).toHaveBeenCalledWith("/settings");
});
