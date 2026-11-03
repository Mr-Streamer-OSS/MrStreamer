import { Window } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Settings as the viewer meets it: the real Settings screen, statistics choice and Diagnostics
// render with React DOM on a happy-dom window, over the app's real language, preferences and
// statistics owners. React Native's views are elements, the app's files are a map whose writes
// can be refused, and the router and share sheet record what they are asked.

const scenario = vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });

  return {
    /** The app's files folder; a name in `refused` keeps its old contents on a write. */
    files: new Map<string, string>([["language.json", JSON.stringify({ choice: "nl-NL" })]]),
    refused: new Set<string>(),
    params: {} as Record<string, string | undefined>,
    asked: [] as string[],
    shared: [] as unknown[],
    /** The open modal's Back. */
    modalBack: null as (() => void) | null,
    eraseRefused: false,
    unconfirmed: false,
  };
});

vi.mock("../src/platform/storage.ts", () => ({
  readJsonStrict: (name: string) => {
    const text = scenario.files.get(name);

    return text === undefined ? null : (JSON.parse(text) as unknown);
  },
  writeJson: (name: string, value: unknown) => {
    if (scenario.refused.has(name)) throw new Error("The folder won't take it.");
    scenario.files.set(name, JSON.stringify(value));
  },
}));

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    onPress?: () => void;
    ref?: unknown;
  };

  const view =
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      onPress,
      ref,
    }: Props) =>
      h(
        tag,
        {
          ref,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "aria-checked": accessibilityState?.checked,
          onClick: onPress,
        },
        children,
      );

  return {
    View: view("div"),
    ScrollView: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    AccessibilityInfo: { announceForAccessibility: () => {}, sendAccessibilityEvent: () => {} },
    Modal: ({
      visible,
      onRequestClose,
      children,
    }: {
      visible: boolean;
      onRequestClose: () => void;
      children: ReactNode;
    }) => {
      if (visible) scenario.modalBack = onRequestClose;

      return visible ? h("dialog", { open: true }, children) : null;
    },
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
    I18nManager: { getConstants: () => ({ localeIdentifier: "en_US" }) },
    Platform: { OS: "android", Version: 36, constants: { Release: "16" } },
    Share: {
      share: async (content: unknown) => {
        scenario.shared.push(content);

        return { action: "sharedAction" };
      },
    },
    Linking: { openURL: async () => {} },
    useWindowDimensions: () => ({ width: 412, height: 915 }),
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");
  const insets = { top: 24, bottom: 16, left: 0, right: 0 };

  return {
    SafeAreaInsetsContext: createContext(insets),
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    useSafeAreaInsets: () => insets,
  };
});

vi.mock("expo-router", () => ({
  router: {
    setParams: (params: Record<string, string | undefined>) =>
      void scenario.asked.push(`params ${JSON.stringify(params)}`),
    push: (href: string) => void scenario.asked.push(`push ${href}`),
    navigate: (href: string) => void scenario.asked.push(`navigate ${href}`),
    back: () => void scenario.asked.push("back"),
  },
  useLocalSearchParams: () => scenario.params,
  useSegments: () => ["(tabs)", "(live)", "settings"],
  usePathname: () => "/settings",
  useIsFocused: () => true,
}));

vi.mock("../src/player/instance.ts", () => ({
  player: {
    release: async () =>
      scenario.unconfirmed
        ? [
            {
              attempt: "attempt",
              hold: { kind: "source", sourceId: "xtream:private-id" },
              outcome: "unconfirmed",
            },
          ]
        : [],
  },
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "0.1.0", android: { versionCode: 1 } } },
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    sources: {
      state: store({
        kind: "ready",
        sources: [
          {
            id: "xtream:private-id",
            kind: "xtream",
            label: "tv.example.invalid",
            channels: { kind: "ready", rows: [] },
          },
        ],
      }),
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" }),
      retry: () => {},
      remove: async () => {
        if (scenario.eraseRefused) throw new Error("erase refused");
      },
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: HTMLElement): { render(node: unknown): void; unmount(): void };
};

const { currentLanguage, setLanguage } = await import("@mrstreamer/core/i18n");

// Loaded first, as the app's entry (index.ts) loads it: the language it applied as it loaded.
await import("../src/settings/language.ts");

const launchedIn = currentLanguage().locale;
const { SettingsScreen } = await import("../src/settings/settings-screen.tsx");
const { default: ConsentPrompt } = await import("../src/settings/consent-prompt.tsx");

let root: ReturnType<typeof createRoot> | null = null;

function show(node: ReactElement) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));

  return container;
}

function press(container: ReturnType<typeof show>, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);

  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${label}`);
  act(() => button.click());
}

const buttons = (container: ReturnType<typeof show>) =>
  Array.from(container.querySelectorAll("dialog button"), (each) =>
    each.getAttribute("aria-label"),
  );

beforeEach(() => {
  scenario.refused.clear();
  scenario.params = {};
  scenario.asked = [];
  scenario.shared = [];
  scenario.modalBack = null;
  scenario.eraseRefused = false;
  scenario.unconfirmed = false;
});

afterEach(() => {
  act(() => root?.unmount());
  window.document.body.innerHTML = "";
});

it("opens in the saved language, and keeps it on screen with Try again when a change can't be saved", async () => {
  expect(launchedIn).toBe("nl-NL");
  const shown = show(createElement(SettingsScreen));
  const row = () => shown.querySelector('button[aria-label="Taal van de interface"]');
  expect(row()?.textContent).toContain("Nederlands");

  scenario.refused.add("language.json");
  press(shown, "Taal van de interface");
  press(shown, "English");
  expect(currentLanguage().locale).toBe("nl-NL");
  expect(row()?.textContent).toContain("Nederlands");
  expect(shown.textContent).toContain("Kon de taal niet bewaren. Je vorige keuze is nog bewaard.");
  expect(JSON.parse(scenario.files.get("language.json") ?? "")).toEqual({ choice: "nl-NL" });

  scenario.refused.clear();
  press(shown, "Opnieuw proberen");
  expect(currentLanguage().locale).toBe("en-US");
  expect(shown.querySelector('button[aria-label="Interface language"]')?.textContent).toContain(
    "English",
  );
  expect(shown.textContent).not.toContain("Couldn't save the language");
  expect(JSON.parse(scenario.files.get("language.json") ?? "")).toEqual({ choice: "en-US" });
});

it("asks for the statistics choice until it is answered, not closing for Back or the scrim", () => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  const shown = show(createElement(ConsentPrompt));
  expect(shown.textContent).toContain("Share usage statistics?");
  // Its two answers are the dialog's only controls: the scrim is no button.
  expect(buttons(shown)).toEqual(["Don't share", "Share"]);

  act(() => scenario.modalBack?.());
  expect(shown.textContent).toContain("Share usage statistics?");

  press(shown, "Don't share");
  expect(shown.querySelector("dialog")).toBeNull();
  expect(JSON.parse(scenario.files.get("statistics.json") ?? "")).toEqual({
    choice: "off",
    installationId: null,
    pending: [],
  });
});

it("shares only the diagnostics text, with no provider's address", async () => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.params = { show: "diagnostics" };
  const shown = show(createElement(SettingsScreen));
  press(shown, "Share");
  await act(async () => {});
  expect(scenario.shared).toEqual([
    { message: expect.stringContaining("Android release: 16\nAPI level: 36") },
  ]);
  expect(JSON.stringify(scenario.shared)).not.toContain("example.invalid");
  expect(JSON.stringify(scenario.shared)).not.toContain("private-id");
});

it.each([
  [
    "en-US",
    "Remove",
    "A playback reader was still open after ten seconds.",
    "Couldn't remove tv.example.invalid. Its login is still saved.",
  ],
  [
    "nl-NL",
    "Verwijderen",
    "Een afspeellezer was na tien seconden nog open.",
    "Kon tv.example.invalid niet verwijderen. De login is nog bewaard.",
  ],
] as const)(
  "shows an unconfirmed release and refused erase together in %s",
  async (locale, remove, releaseMessage, eraseMessage) => {
    setLanguage({ locale, formats: locale });
    scenario.eraseRefused = true;
    scenario.unconfirmed = true;
    const shown = show(createElement(SettingsScreen));
    press(shown, "tv.example.invalid");
    press(shown, remove);
    press(shown, remove);
    await act(async () => {});
    expect(shown.textContent).toContain(releaseMessage);
    expect(shown.textContent).toContain(eraseMessage);
    expect(shown.textContent).not.toContain(
      locale === "en-US"
        ? "saved entry are erased"
        : "vermelding van tv.example.invalid zijn gewist",
    );
  },
);
