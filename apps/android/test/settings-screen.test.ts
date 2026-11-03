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
    toasts: [] as string[],
    removeLast: false,
    writes: [] as string[],
    releaseCalls: 0,
    releaseWait: null as Promise<void> | null,
  };
});

vi.mock("../src/platform/storage.ts", () => ({
  readJsonStrict: (name: string) => {
    const text = scenario.files.get(name);

    return text === undefined ? null : (JSON.parse(text) as unknown);
  },
  writeJson: (name: string, value: unknown) => {
    scenario.writes.push(name);

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
    ToastAndroid: { LONG: 1, show: (text: string) => scenario.toasts.push(text) },
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
    release: async () => {
      await scenario.releaseWait;

      return scenario.unconfirmed && scenario.releaseCalls++ === 0
        ? [
            {
              attempt: "attempt",
              hold: { kind: "source", sourceId: "xtream:private-id" },
              outcome: "unconfirmed",
            },
          ]
        : [];
    },
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

        if (scenario.removeLast) {
          const { sources } = await import("../src/bootstrap/sources.ts");
          sources.state.set({ kind: "ready", sources: [] });
        }
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
  scenario.releaseCalls = 0;
  scenario.toasts = [];
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

it("counts the generated licence manifest, and shares only the diagnostics text, with no provider's address", async () => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.params = { show: "diagnostics" };
  const shown = show(createElement(SettingsScreen));
  const { default: manifest } = await import("../licenses/manifest.json");
  expect(shown.querySelector('button[aria-label="Licences"]')?.textContent).toContain(
    String(manifest.length),
  );
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

it("reports unavailable language rather than a saved System default and retries the read", async () => {
  const { retryLanguage } = await import("../src/settings/language.ts");
  scenario.files.set("language.json", "broken JSON");
  act(() => retryLanguage());
  setLanguage({ locale: "en-US", formats: "en-US" });
  const shown = show(createElement(SettingsScreen));
  expect(shown.querySelector('button[aria-label="Interface language"]')?.textContent).toContain(
    "Unavailable. Try again.",
  );
  scenario.files.set("language.json", JSON.stringify({ choice: "fr-FR" }));
  press(shown, "Interface language");
  expect(shown.querySelector('button[aria-label="Interface language"]')?.textContent).toContain(
    "English",
  );
  expect(shown.querySelector('button[aria-label="Interface language"]')?.textContent).not.toContain(
    "System",
  );
});

it.each([
  [false, true],
  [true, true],
  [true, false],
])(
  "uses one truthful removal notice surface, settings gone=%s statistics refused=%s",
  async (gone, statisticsRefused) => {
    setLanguage({ locale: "en-US", formats: "en-US" });
    const { statistics } = await import("../src/telemetry/index.ts");
    const { sources } = await import("../src/bootstrap/sources.ts");
    sources.state.set({
      kind: "ready",
      sources: [
        {
          id: "xtream:private-id",
          kind: "xtream",
          label: "tv.example.invalid",
          channels: { kind: "ready", rows: [] },
        },
      ],
    });
    statistics.configure(true);
    statistics.consent.replace({
      choice: "on",
      installationId: "11111111-1111-4111-8111-111111111111",
      pending: [],
    });

    if (statisticsRefused) scenario.refused.add("statistics.json");
    scenario.removeLast = true;
    scenario.unconfirmed = true;
    let finish!: () => void;
    scenario.releaseWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const shown = show(createElement(SettingsScreen));
    press(shown, "tv.example.invalid");
    press(shown, "Remove");
    press(shown, "Remove");

    if (gone)
      act(() => {
        root?.unmount();
        root = null;
      });
    finish();
    await act(async () => {});
    scenario.releaseWait = null;

    const short = statisticsRefused
      ? "The provider was removed, but its statistics could not be cleared."
      : "Playback may still be active.";

    if (gone) expect(scenario.toasts).toEqual([short]);
    else {
      expect(scenario.toasts).toEqual([]);
      expect(shown.textContent).toContain(short);
      expect(shown.textContent).toContain("still open after ten seconds");
    }
  },
);

it("repairs an unreadable language file by choosing a valid language", async () => {
  const { retryLanguage } = await import("../src/settings/language.ts");
  scenario.files.set("language.json", "broken");
  act(() => retryLanguage());
  setLanguage({ locale: "en-US", formats: "en-US" });
  const shown = show(createElement(SettingsScreen));
  expect(shown.textContent).toContain("Unavailable. Try again.");
  press(shown, "Interface language");
  press(shown, "English");
  expect(JSON.parse(scenario.files.get("language.json")!)).toEqual({ choice: "en-US" });
  expect(shown.textContent).not.toContain("Unavailable. Try again.");
});

it("seeds the source count at mount and discards only for a later transition to zero", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const { statistics } = await import("../src/telemetry/index.ts");
  scenario.refused.clear();
  statistics.configure(true);
  const identity = "11111111-1111-4111-8111-111111111111";
  statistics.consent.replace({ choice: "on", installationId: identity, pending: [] });
  sources.state.set({ kind: "ready", sources: [] });
  scenario.writes = [];
  show(createElement(ConsentPrompt));
  expect(statistics.consent.get().installationId).toBe(identity);

  const source = {
    id: "source",
    kind: "m3u" as const,
    label: "example.invalid",
    channels: { kind: "ready" as const, rows: [] },
  };

  act(() => {
    sources.state.set({ kind: "ready", sources: [source] });
  });
  act(() => {
    sources.state.set({ kind: "ready", sources: [] });
  });
  act(() => {
    sources.state.set({ kind: "ready", sources: [] });
  });
  expect(statistics.consent.get().installationId).toBeNull();
  expect(scenario.writes.filter((name) => name === "statistics.json")).toHaveLength(1);
});

it("keeps a removing provider busy so its row cannot open a second Remove", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  sources.state.set({
    kind: "ready",
    sources: [
      {
        id: "source",
        kind: "m3u",
        label: "example.invalid",
        channels: { kind: "ready", rows: [] },
      },
    ],
  });
  setLanguage({ locale: "en-US", formats: "en-US" });
  let finish!: () => void;
  scenario.releaseWait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  scenario.removeLast = false;
  const shown = show(createElement(SettingsScreen));
  press(shown, "example.invalid");
  press(shown, "Remove");
  press(shown, "Remove");
  expect(shown.textContent).toContain("Removing…");
  press(shown, "example.invalid");
  expect(shown.querySelector("dialog")).toBeNull();
  finish();
  await act(async () => {});
  scenario.releaseWait = null;
  expect(shown.textContent).not.toContain("Removing…");
});

it("offers Try again for a refused Off and retries Off rather than enabling statistics", async () => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  const { statistics } = await import("../src/telemetry/index.ts");
  statistics.configure(true);
  scenario.refused.add("statistics.json");
  const shown = show(createElement(SettingsScreen));
  press(shown, "Share basic usage statistics");
  expect(statistics.consent.get().choice).toBe("on");
  expect(statistics.consent.enabled).toBe(false);
  expect(shown.textContent).toContain(
    "Your statistics choice can't be saved on this phone right now.",
  );
  scenario.refused.clear();
  press(shown, "Try again");
  expect(statistics.consent.get().choice).toBe("off");
  expect(statistics.consent.enabled).toBe(false);
});
