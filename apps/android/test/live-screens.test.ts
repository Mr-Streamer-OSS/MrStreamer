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
      renderItem: (value: { item: unknown }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
    }) =>
      h(
        "div",
        {},
        ListHeaderComponent,
        data.length
          ? data.map((item, i) => h("div", { key: i }, renderItem({ item })))
          : ListEmptyComponent,
        ListFooterComponent,
      ),
    BackHandler: { addEventListener: () => ({ remove() {} }) },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "custom" }),
  useIsFocused: () => true,
  router: { back() {}, push() {} },
}));

vi.mock("../src/ui/focus.ts", () => ({
  useKeyboardFocus: () => ({ focused: false, handlers: {} }),
}));

vi.mock("../src/ui/icon-button.tsx", () => ({ IconButton: () => null }));

vi.mock("../src/ui/top-app-bar.tsx", () => ({ TopAppBar: () => null }));

vi.mock("../src/ui/sheet.tsx", () => ({ Sheet: () => null }));

vi.mock("../src/connect/connect-screen.tsx", () => ({ ConnectScreen: () => null }));

vi.mock("../src/connect/catalogue-screen.tsx", () => ({ CatalogueScreen: () => null }));

vi.mock("../src/navigation/screen.tsx", () => ({
  Screen: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../src/live/chrome.tsx", () => {
  const view = ({ children }: { children?: ReactNode }) => children;

  return {
    RED: "red",
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

vi.mock("../src/live/ui.tsx", () => ({
  Empty: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) =>
    h("div", {}, title, body, action),
  NavRow: () => null,
  Channel: () => null,
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
    render(node: unknown): void;
  };
};

const { ListScreen } = await import("../src/live/list-screen.tsx");
const { LiveScreen } = await import("../src/live/screens.tsx");
const { lists } = await import("../src/live/runtime.ts");
const container = window.document.createElement("div");
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.render(null));
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
