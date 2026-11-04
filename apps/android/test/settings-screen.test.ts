import type { ShareContent } from "react-native";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { writeJson } from "../src/platform/storage.ts";
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
    shareRefused: false,
    destination: "(live)",
    retries: [] as string[],
    connections: [] as unknown[],
    saveRefused: false,
    releaseWait: null as Promise<void> | null,
    /** Accounts whose viewing history Settings asked to delete, and whether that is refused. */
    cleared: [] as string[],
    historyRefused: false,
    removals: 0,
  };
});

vi.mock("../src/home/index.ts", () => ({
  clearViewing: async (id: string) => {
    scenario.cleared.push(id);

    if (scenario.historyRefused) throw new Error("The folder won't take it.");
  },
}));

vi.mock("../src/platform/storage.ts", () => ({
  readJsonStrict: (name: string) => {
    const text = scenario.files.get(name);

    return text === undefined ? null : (JSON.parse(text) as unknown);
  },
  writeJson: (name: string, value: Parameters<typeof writeJson>[1]) => {
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
    accessibilityHint?: string;
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
      accessibilityHint,
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
          "data-hint": accessibilityHint,
          "aria-checked": accessibilityState?.checked,
          onClick: onPress,
        },
        children,
      );

  return {
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText: (text: string) => void;
    }) =>
      h("input", {
        "aria-label": accessibilityLabel,
        value,
        onInput: (event: { currentTarget: { value: string } }) =>
          onChangeText(event.currentTarget.value),
      }),
    FlatList: ({
      data,
      renderItem,
    }: {
      data: readonly unknown[];
      renderItem: (row: { item: unknown; index: number }) => ReactNode;
    }) =>
      h(
        "div",
        null,
        data.map((item, index) => h("div", { key: index }, renderItem({ item, index }))),
      ),
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
      share: async (content: ShareContent) => {
        if (scenario.shareRefused) throw new Error("share refused");
        scenario.shared.push(content);

        return { action: "sharedAction" };
      },
    },
    Linking: { openURL: async () => {} },
    useWindowDimensions: () => ({ width: 412, height: 915 }),
  };
});

vi.mock("../src/bootstrap/polyfills.ts", () => ({}));

vi.mock("expo-router/entry", () => ({}));

vi.mock("expo-router/js-tabs", async () => {
  const { createElement: h } = await import("react");

  return {
    Tabs: Object.assign(({ children }: { children: ReactNode }) => h("div", null, children), {
      Screen: ({ options }: { options: { title: string } }) => h("span", null, options.title),
    }),
  };
});

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

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
      void (Object.assign(scenario.params, params),
      scenario.asked.push(`params ${JSON.stringify(params)}`)),
    push: (href: string) => void scenario.asked.push(`push ${href}`),
    navigate: (href: string) => void scenario.asked.push(`navigate ${href}`),
    back: () => void scenario.asked.push("back"),
  },
  useLocalSearchParams: () => scenario.params,
  useSegments: () => ["(tabs)", scenario.destination, "settings"],
  usePathname: () => "/settings",
  useIsFocused: () => true,
}));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    player: {
      state: store({ kind: "playing", phase: "paused", live: false, intent: { title: "Fixture" } }),
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
  };
});

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
      connect: async (input: LoginInput, _signal?: AbortSignal, id?: string) => {
        scenario.connections.push({ input, id });

        return scenario.saveRefused
          ? { kind: "failed", error: { kind: "keychain-refused" }, http: null }
          : { kind: "connected", id: id ?? "new-source" };
      },
      retry: (id: string) => {
        scenario.retries.push(id);
      },
      remove: async () => {
        scenario.removals++;

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
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};

const { currentLanguage, setLanguage } = await import("@mrstreamer/core/i18n");

// Loaded first, as the app's entry (index.ts) loads it: the language it applied as it loaded.
await import("../index.ts");

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
  scenario.shareRefused = false;
  scenario.saveRefused = false;
  scenario.connections = [];
  scenario.retries = [];
  scenario.refused.clear();
  scenario.params = {};
  scenario.asked = [];
  scenario.shared = [];
  scenario.modalBack = null;
  scenario.eraseRefused = false;
  scenario.unconfirmed = false;
  scenario.releaseCalls = 0;
  scenario.toasts = [];
  scenario.removeLast = false;
  scenario.releaseWait = null;
  scenario.destination = "(live)";
  scenario.cleared = [];
  scenario.historyRefused = false;
  scenario.removals = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  window.document.body.innerHTML = "";
});

it("mounts the Android first-choice prompt in the tabs and remembers the answer after remount", async () => {
  const { default: Layout } = await import("../src/app/(tabs)/_layout.tsx");
  const shown = show(createElement(Layout));
  await act(async () => {});
  expect(shown.textContent).toContain("Start");
  act(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  await act(async () => {});
  expect(shown.textContent).toContain("Share usage statistics?");
  expect(buttons(shown)).toEqual(["Don't share", "Share"]);
  act(() => scenario.modalBack?.());
  expect(shown.textContent).toContain("Share usage statistics?");
  press(shown, "Don't share");
  expect(shown.querySelector("dialog")).toBeNull();
  expect(JSON.parse(scenario.files.get("statistics.json")!)).toEqual({
    choice: "off",
    installationId: null,
    pending: [],
  });
  act(() => root?.unmount());
  root = null;
  // Recreate the consent owner from the saved record, as a new process does.
  const { androidAnalytics } = await import("../src/telemetry/analytics.ts");
  const { androidBuild } = await import("../src/telemetry/model.ts");

  const fresh = androidAnalytics({
    load: () => JSON.parse(scenario.files.get("statistics.json")!),
    save: () => true,
    uuid: () => "unused",
    build: androidBuild("16", "0.1.0", "1"),
    transport: null,
  });

  expect(fresh.consent.get().choice).toBe("off");
  const remounted = show(createElement(Layout));
  await act(async () => {});
  expect(remounted.textContent).not.toContain("Share usage statistics?");
});

it("opens in the saved language, and keeps it on screen with Try again when a change can't be saved", async () => {
  setLanguage({ locale: launchedIn, formats: launchedIn });
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

function fill(container: ReturnType<typeof show>, label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`);

  if (!(input instanceof window.HTMLInputElement)) throw Error(`No field ${label}`);
  act(() => {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

it.each([
  ["xtream", "invalid-login", "Enter password"],
  ["m3u", "needs-secret", "Enter playlist link"],
] as const)(
  "re-enters %s %s through Settings with the same source id and keeps a refused form open",
  async (kind, error, action) => {
    const { sources } = await import("../src/bootstrap/sources.ts");
    sources.state.set({
      kind: "ready",
      sources: [
        {
          id: "recover-id",
          kind,
          label: "recover.example.invalid",
          channels: {
            kind: "failed",
            error:
              error === "needs-secret"
                ? { kind: error, subscriptionId: "recover-id" }
                : { kind: error },
          },
        },
      ],
    });
    setLanguage({ locale: "en-US", formats: "en-US" });
    const shown = show(createElement(SettingsScreen));
    press(shown, "recover.example.invalid");
    press(shown, action);
    fill(shown, "Server or M3U link", "https://changed.example.invalid/list.m3u");
    fill(shown, "Username", "changed-user");
    fill(shown, "Password", "changed-password");
    scenario.saveRefused = true;
    press(shown, "Connect");
    await act(async () => {});
    expect(shown.textContent).toContain("Nothing was saved.");
    expect(shown.querySelector('input[aria-label="Password"]')).not.toBeNull();
    scenario.saveRefused = false;
    press(shown, "Connect");
    await act(async () => {});
    expect(scenario.connections).toEqual(
      Array(2).fill({
        id: "recover-id",
        input: {
          server: "https://changed.example.invalid/list.m3u",
          username: "changed-user",
          password: "changed-password",
        },
      }),
    );
    expect(shown.querySelector("dialog")).toBeNull();
  },
);

it("dispatches Retry and Reload channels for the retained provider, adds a provider and retries removal", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  setLanguage({ locale: "en-US", formats: "en-US" });

  const retained = [
    {
      key: "recover-id:1",
      sourceId: "recover-id",
      title: "Retained channel",
      number: null,
      category: null,
    },
  ];

  sources.state.set({
    kind: "ready",
    sources: [
      {
        id: "recover-id",
        kind: "m3u",
        label: "recover.example.invalid",
        channels: {
          kind: "failed",
          error: { kind: "unreachable", server: "", detail: "offline" },
          channels: retained,
        },
      },
    ],
  });
  const shown = show(createElement(SettingsScreen));
  press(shown, "recover.example.invalid");
  press(shown, "Retry");
  expect(scenario.retries).toEqual(["recover-id"]);
  expect(shown.textContent).toContain("offline");
  expect(sources.state.get()).toMatchObject({ sources: [{ channels: { channels: retained } }] });
  act(() =>
    sources.state.set({
      kind: "ready",
      sources: [
        {
          id: "recover-id",
          kind: "m3u",
          label: "recover.example.invalid",
          channels: { kind: "ready", rows: retained },
        },
      ],
    }),
  );
  press(shown, "recover.example.invalid");
  press(shown, "Reload channels");
  expect(scenario.retries).toEqual(["recover-id", "recover-id"]);
  expect(sources.state.get()).toMatchObject({ sources: [{ channels: { rows: retained } }] });
  press(shown, "Add provider");
  fill(shown, "Server or M3U link", "https://new.example.invalid/list.m3u");
  press(shown, "Connect");
  await act(async () => {});
  expect(scenario.connections).toEqual([
    {
      id: undefined,
      input: { server: "https://new.example.invalid/list.m3u", username: "", password: "" },
    },
  ]);
  expect(shown.querySelector("dialog")).toBeNull();
  scenario.eraseRefused = true;
  press(shown, "recover.example.invalid");
  press(shown, "Remove");
  press(shown, "Remove");
  await act(async () => {});
  expect(shown.textContent).toContain("Its login is still saved.");
  scenario.eraseRefused = false;
  scenario.removeLast = true;
  press(shown, "Try again");
  await act(async () => {});
  expect(sources.state.get()).toMatchObject({ sources: [] });
});

it("shows a rejected system Share as a failure", async () => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.params = { show: "diagnostics" };
  scenario.shareRefused = true;
  const shown = show(createElement(SettingsScreen));
  press(shown, "Share");
  await act(async () => {});
  expect(shown.textContent).toContain("Couldn't share diagnostics. Try again.");
});

it.each(["home", "(live)", "movies", "series"])(
  "opens a full licence from Settings on %s and clears selection on close",
  async (destination) => {
    scenario.destination = destination;
    setLanguage({ locale: "en-US", formats: "en-US" });
    const { LicencesScreen } = await import("../src/settings/licences-screen.tsx");
    const { default: manifest } = await import("../licenses/manifest.json");
    const first = manifest[0]!;
    const shown = show(createElement(SettingsScreen));
    press(shown, "Licences");
    expect(scenario.asked).toContain(
      `push ${destination === "(live)" ? "" : `/${destination}`}/licences`,
    );
    act(() => root?.render(createElement(LicencesScreen)));
    press(shown, first.name);
    expect(scenario.params.licence).toBe("0");
    act(() => root?.render(createElement(LicencesScreen)));

    for (const text of [
      first.licence,
      first.version,
      first.source.replace(/^https?:\/\//, ""),
      first.notice,
    ])
      expect(shown.textContent).toContain(text);
    press(shown, "Back");
    expect(scenario.params.licence).toBeUndefined();
    act(() => root?.render(createElement(LicencesScreen)));
    expect(shown.textContent).not.toContain(first.notice);
  },
);

it("updates mounted navigation, top bar, sheet and mini-player labels between English and Dutch", async () => {
  const { DestinationBar } = await import("../src/navigation/destination-bar.tsx");
  const { NavigationBar } = await import("../src/ui/navigation-bar.tsx");
  const { TopAppBar } = await import("../src/ui/top-app-bar.tsx");
  const { Sheet } = await import("../src/ui/sheet.tsx");
  const { MiniPlayer } = await import("../src/player/mini-player.tsx");
  const { DESTINATIONS } = await import("../src/navigation/destinations.ts");
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };

  const node = () =>
    createElement(
      "div",
      null,
      createElement(DestinationBar, {
        layout: "bar",
        descriptors: {},
        state: { index: 0, routes: DESTINATIONS.map(({ route }) => ({ name: route, key: route })) },
        emitter: {
          emit: () => {
            throw new Error("This rendering test does not navigate tabs.");
          },
        },
        navigateToTab: () => {},
        insets,
      }),
      createElement(NavigationBar, {
        destinations: DESTINATIONS,
        selected: "home",
        onSelect: () => {},
        insets,
      }),
      createElement(TopAppBar, { title: "Fixture", layout: "bar", insets }),
      createElement(Sheet, {
        label: "Fixture",
        visible: true,
        onClose: () => {},
        children: "Fixture",
      }),
      createElement(MiniPlayer),
    );

  setLanguage({ locale: "en-US", formats: "en-US" });
  const shown = show(node());

  for (const [locale, home, movies, settings, search, close, hint] of [
    ["nl-NL", "Start", "Films", "Instellingen", "Zoeken", "Fixture sluiten", "Opent de speler"],
    ["en-US", "Home", "Movies", "Settings", "Search", "Close Fixture", "Opens the player"],
  ] as const) {
    act(() => {
      setLanguage({ locale, formats: locale });
      root?.render(node());
    });
    expect(
      Array.from(
        shown.querySelectorAll(`button[aria-label="${home}"]`),
        (button) => button.textContent,
      ),
    ).toEqual([home, home]);
    expect(shown.querySelectorAll(`button[aria-label="${movies}"]`)).toHaveLength(2);

    for (const label of [settings, search, close])
      expect(shown.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    expect(shown.querySelector('button[aria-label="Fixture"]')?.getAttribute("data-hint")).toBe(
      hint,
    );
  }
});

it.each(["home", "(live)", "movies", "series"])("opens Guides on the %s stack", (destination) => {
  scenario.destination = destination;
  setLanguage({ locale: "en-US", formats: "en-US" });
  const shown = show(createElement(SettingsScreen));
  press(shown, "Guides");
  expect(scenario.asked).toContain(
    `push ${destination === "(live)" ? "" : `/${destination}`}/guide/guides`,
  );
});

it("opens the Dutch Guides row", () => {
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });
  const shown = show(createElement(SettingsScreen));
  press(shown, "Gidsen");
  expect(scenario.asked).toContain("push /guide/guides");
});

it("removes a provider keeping its history, or deletes the history too, retrying only what failed", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");

  const provider = {
    id: "source",
    kind: "xtream" as const,
    label: "tv.example.invalid",
    channels: { kind: "ready" as const, rows: [] },
  };

  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.removeLast = true;
  sources.state.set({ kind: "ready", sources: [provider] });
  const shown = show(createElement(SettingsScreen));
  press(shown, "tv.example.invalid");
  press(shown, "Remove");
  // The scrim, then the dialog's answers.
  expect(buttons(shown)).toEqual(["Cancel", "Remove", "Remove and delete history", "Cancel"]);
  expect(shown.querySelector("dialog")?.textContent).toContain(
    "Remove keeps your favourites, watchlist and viewing history",
  );
  expect(shown.querySelector("dialog")?.textContent).toContain(
    "Deleting history also erases favourites and watchlist.",
  );
  press(shown, "Remove");
  await act(async () => {});
  expect(scenario.removals).toBe(1);
  expect(scenario.cleared).toEqual([]);

  act(() => sources.state.set({ kind: "ready", sources: [provider] }));
  scenario.historyRefused = true;
  press(shown, "tv.example.invalid");
  press(shown, "Remove");
  press(shown, "Remove and delete history");
  await act(async () => {});
  expect(scenario.removals).toBe(2);
  expect(scenario.cleared).toEqual(["source"]);
  expect(shown.textContent).toContain(
    "The provider was removed, but its history could not be deleted.",
  );

  scenario.historyRefused = false;
  press(shown, "Try again");
  await act(async () => {});
  expect(scenario.cleared).toEqual(["source", "source"]);
  expect(scenario.removals).toBe(2);
});

it("retries both refused history and statistics cleanup without removing the provider again", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.removeLast = true;
  const { statistics } = await import("../src/telemetry/index.ts");
  statistics.configure(true);
  statistics.consent.replace({
    choice: "on",
    installationId: "11111111-1111-4111-8111-111111111111",
    pending: [],
  });
  scenario.historyRefused = true;
  scenario.refused.add("statistics.json");
  sources.state.set({
    kind: "ready",
    sources: [
      {
        id: "source",
        kind: "xtream",
        label: "Test provider",
        channels: { kind: "ready", rows: [] },
      },
    ],
  });
  const shown = show(createElement(SettingsScreen));
  press(shown, "Test provider");
  press(shown, "Remove");
  press(shown, "Remove and delete history");
  await act(async () => {});
  const attempts = scenario.writes.filter((name) => name === "statistics.json").length;
  scenario.historyRefused = false;
  scenario.refused.delete("statistics.json");
  press(shown, "Try again");
  await act(async () => {});
  expect(scenario.cleared).toEqual(["source", "source"]);
  expect(scenario.removals).toBe(1);
  expect(scenario.writes.filter((name) => name === "statistics.json")).toHaveLength(attempts + 1);
});

it("reports both refused cleanups after Settings unmounts", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.removeLast = true;
  const { statistics } = await import("../src/telemetry/index.ts");
  statistics.configure(true);
  statistics.consent.replace({
    choice: "on",
    installationId: "11111111-1111-4111-8111-111111111111",
    pending: [],
  });
  scenario.historyRefused = true;
  scenario.refused.add("statistics.json");
  sources.state.set({
    kind: "ready",
    sources: [
      {
        id: "source",
        kind: "xtream",
        label: "Test provider",
        channels: { kind: "ready", rows: [] },
      },
    ],
  });
  const shown = show(createElement(SettingsScreen));
  press(shown, "Test provider");
  press(shown, "Remove");
  press(shown, "Remove and delete history");
  act(() => {
    root?.unmount();
    root = null;
  });
  await act(async () => {});
  expect(scenario.toasts).toEqual([
    "The provider was removed, but its history could not be deleted. The provider was removed, but its statistics could not be cleared.",
  ]);
  expect(scenario.removals).toBe(1);
});

it("replaces the password through Settings while retaining Watchlist, recent, progress and marks", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const { viewingOwner } = await import("../src/home/viewing.ts");
  const { fixture } = await import("./library-fixture.ts");
  const { libraryModel } = await import("../src/library/model.ts");
  const platform = await import("../src/platform/storage.ts");
  const f = fixture();

  const model = libraryModel({
    sources: () => [{ ...f.source, id: "xtream:private-id", reader: f.source }],
    language: () => "en",
  });

  await model.refresh();

  const owner = viewingOwner(
    { readJson: platform.readJsonStrict, writeJson: platform.writeJson },
    () => ["xtream:private-id"],
    () => model,
  );

  const before = sources.state.get();
  setLanguage({ locale: "en-US", formats: "en-US" });
  sources.state.set({
    kind: "ready",
    sources: [
      {
        id: "xtream:private-id",
        kind: "xtream",
        label: "tv.example.invalid",
        channels: {
          kind: "failed",
          error: { kind: "needs-secret", subscriptionId: "xtream:private-id" },
        },
      },
    ],
  });

  try {
    await owner.read();
    const title = model.made("movie").list("all", "title")[0]!;
    const series = model.made("series").list("all", "title")[0]!;
    await owner.setWatchlist(title, true);
    await owner.recordWatch({ sourceId: "xtream:private-id", channelId: "live" });
    await owner.recordProgress(
      { kind: "movie", subscriptionId: "xtream:private-id", id: title.id },
      300,
      1800,
      1,
    );
    await owner.markEpisode(
      {
        kind: "episode",
        subscriptionId: "xtream:private-id",
        seriesId: series.id,
        id: "first",
        season: 1,
        episode: 1,
      },
      true,
    );
    const shown = show(createElement(SettingsScreen));
    press(shown, "tv.example.invalid");
    press(shown, "Enter password");
    fill(shown, "Server or M3U link", "https://tv.example.invalid");
    fill(shown, "Username", "fixture");
    fill(shown, "Password", "replacement");
    press(shown, "Connect");
    await act(async () => {});
    expect(scenario.connections).toEqual([
      {
        id: "xtream:private-id",
        input: {
          server: "https://tv.example.invalid",
          username: "fixture",
          password: "replacement",
        },
      },
    ]);
    expect(shown.querySelector("dialog")).toBeNull();
    expect(scenario.cleared).toEqual([]);
    await owner.read();
    expect(owner.state.get().watchlist[0]?.name).toBe(title.title);
    expect(owner.state.get().viewing?.recent).toEqual([
      { subscriptionId: "xtream:private-id", id: "live" },
    ]);
    expect((await owner.progress(title))[0]?.position).toBe(300);
    expect((await owner.episodes(series)).marks).toHaveLength(1);
  } finally {
    await owner.dispose();
    sources.state.set(before);
    scenario.files.delete("viewing.json");
  }
});
