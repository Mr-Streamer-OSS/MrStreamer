import { setLanguage } from "@mrstreamer/core/i18n";
import type { Connected, SourcesOwner } from "../src/connect/sources.ts";
import { Window } from "happy-dom";
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const view = ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) =>
    h(
      onPress ? "button" : accessibilityRole === "header" ? "h1" : "div",
      {
        onClick: onPress,
        "aria-label": accessibilityLabel,
      },
      children,
    );

  return {
    View: view,
    Text: view,
    ScrollView: view,
    Pressable: view,
    TextInput: ({
      accessibilityLabel,
      placeholder,
      value,
      onChangeText,
    }: {
      accessibilityLabel: string;
      placeholder: string;
      value: string;
      onChangeText: (text: string) => void;
    }) =>
      h("input", {
        "aria-label": accessibilityLabel,
        placeholder,
        value,
        onInput: (event: { currentTarget: { value: string } }) =>
          onChangeText(event.currentTarget.value),
      }),
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
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

const params = vi.hoisted(() => ({ id: "custom", country: "" }));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => params,
  useIsFocused: () => true,
  router: { back() {}, push() {} },
}));

vi.mock("../src/ui/focus.ts", () => ({
  useKeyboardFocus: () => ({ focused: false, handlers: {} }),
}));

vi.mock("../src/ui/icon-button.tsx", () => ({ IconButton: () => null }));

vi.mock("../src/ui/top-app-bar.tsx", () => ({ TopAppBar: () => null }));

vi.mock("../src/ui/sheet.tsx", () => ({
  Sheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? h("section", {}, children) : null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
}));

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
  NavRow: () => null,
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

  return {
    sources: {
      state: store({ kind: "ready", sources: [] }),
      connect: vi.fn<SourcesOwner["connect"]>(),
    },
  };
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

const { default: Connect } = await import("../src/app/connect.tsx");
const { LiveScreen } = await import("../src/live/screens.tsx");
const { sources } = await import("../src/bootstrap/sources.ts");

const container = window.document.createElement("div");
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.render(null));
  setLanguage({ locale: "en-US", formats: "en-US" });
  sources.state.set({ kind: "ready", sources: [] });
  vi.mocked(sources.connect).mockReset();
});

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent) === label,
  );

  expect(found, label).toBeDefined();

  return found!;
}

function expectDutch(sheet: boolean) {
  expect(container.querySelector("h1")?.textContent).toBe("Provider toevoegen");
  expect(
    [...container.querySelectorAll("input")].map((input) => [
      input.getAttribute("aria-label"),
      input.placeholder,
    ]),
  ).toEqual([
    ["Server of M3U-link", "Server of M3U-link"],
    ["Gebruikersnaam", "Gebruikersnaam"],
    ["Wachtwoord", "Wachtwoord"],
  ]);
  expect(button("Verbinden").textContent).toBe("Verbinden");
  expect(container.querySelector('[aria-label="Annuleren"]') !== null).toBe(sheet);
}

it.each(["onboarding", "Live sheet"] as const)(
  "renders Dutch Connect copy in %s and keeps typed values through language changes",
  async (entry) => {
    const sheet = entry === "Live sheet";

    await act(async () => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
    await act(async () => root.render(h(sheet ? LiveScreen : Connect)));

    if (sheet) await act(async () => button("Provider toevoegen").click());
    expectDutch(sheet);

    await act(async () => setLanguage({ locale: "en-US", formats: "en-US" }));
    expect(container.querySelector("h1")?.textContent).toBe("Add provider");
    expect([...container.querySelectorAll("input")].map((input) => input.placeholder)).toEqual([
      "Server or M3U link",
      "Username",
      "Password",
    ]);
    expect(button("Connect").textContent).toBe("Connect");
    const values = ["https://provider.example", "viewer", "example-password"];

    await act(async () => {
      [...container.querySelectorAll("input")].forEach((input, index) => {
        input.value = values[index]!;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    });
    await act(async () => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
    expectDutch(sheet);
    expect([...container.querySelectorAll("input")].map((input) => input.value)).toEqual(values);

    const pending = Promise.withResolvers<Connected>();

    vi.mocked(sources.connect).mockReturnValueOnce(pending.promise);
    await act(async () => button("Verbinden").click());
    expect(button("Verbinden…").textContent).toBe("Verbinden…");
    await act(async () =>
      pending.resolve({
        kind: "failed",
        error: { kind: "provider-error", status: 503 },
        http: { server: "http://provider.example", username: values[1]!, password: values[2]! },
      }),
    );
    expect(button("Verbinden zonder versleuteling (http)").textContent).toBe(
      "Verbinden zonder versleuteling (http)",
    );
  },
);
