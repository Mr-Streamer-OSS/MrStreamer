import "./native-assets.ts";
import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";
import type { useTabScreenOptions } from "../src/header.tsx";
import { keychain } from "./keychain.ts";

// The interface language as a viewer meets it: System default follows the iPhone's first
// language the app speaks, else English; a language picked in Settings shows at once, Settings'
// title too, and is the one the next launch opens in, Connect's welcome and statistics question
// included, whatever the iPhone's languages. A provider's own name stays as it is. The real
// screens run with React DOM on a happy-dom window over the files stand-in; a relaunch is a
// fresh module graph over the same files.

Object.assign(globalThis, { __DEV__: false });

const scenario = vi.hoisted(() => ({
  /** The iPhone's preferred languages, as iOS lists them. */
  phone: ["en-US"] as string[],
  sheet: null as { title: string; options: readonly string[]; pick: (at: number) => void } | null,
  alerts: [] as { title: string; message?: string | undefined }[],
  title: "",
  titles: [] as string[],
  members: [] as Member[],
  tmdb: { kind: "no-key" } as { kind: string; known?: number; wanted?: number },
  /** What a tab's stack last drew: its first screen's title and its top bar's labelled buttons. */
  stack: null as { title: string; buttons: string[] } | null,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-secure-store", () => keychain(() => new Map()));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Settings: { get: (key: string) => (key === "AppleLanguages" ? scenario.phone : undefined) },
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { title, options }: { title: string; options: readonly string[] },
      pick: (at: number) => void,
    ) => {
      scenario.sheet = { title, options, pick };
    },
  },
  Alert: {
    alert: (title: string, message?: string) => scenario.alerts.push({ title, message }),
  },
}));
vi.mock("react-native-safe-area-context", async () => ({
  SafeAreaView: (await import("./react-native.ts")).reactNative.View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("expo-router", () => {
  const navigation = {
    setOptions: ({ title }: { title: string }) => {
      scenario.title = title;
      scenario.titles.push(title);
    },
  };
  return {
    router: { push: () => undefined },
    useLocalSearchParams: () => ({}),
    useRootNavigationState: () => ({ index: 0, routes: [{ name: "(tabs)" }] }),
    useNavigation: () => navigation,
    // A tab's stack, as far as its first screen's options and its top bar go.
    Stack: Object.assign(
      ({ children, screenOptions }: { children: unknown; screenOptions: ScreenOptions }) => {
        const items = React.useMemo(
          () => screenOptions({ route: { name: "index" } }).unstable_headerRightItems?.({}),
          [screenOptions],
        );
        scenario.stack = {
          title: scenario.stack?.title ?? "",
          buttons: (items ?? []).flatMap((item) => ("label" in item ? [item.label] : [])),
        };
        return children;
      },
      {
        Screen: ({ name, options }: { name: string; options: { title: string } }) => {
          if (name === "index" && scenario.stack) scenario.stack.title = options.title;
          return null;
        },
      },
    ),
  };
});
vi.mock("expo-video", () => ({ isPictureInPictureSupported: () => true }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/downloads.ts", () => ({
  useDownloads: () => ({ items: [], series: {}, bytes: 0, free: null, ended: 0 }),
}));
vi.mock("../src/titles.ts", () => ({
  useMetadataStanding: () => scenario.tmdb,
  useTitleTimings: () => null,
}));
vi.mock("../src/telemetry/index.ts", () => ({
  statisticsChoice: () => null,
  useStatistics: () => ({ enabled: false, transport: "production" }),
  setStatistics: async () => undefined,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
}));

const livingRoom = {
  entry: {
    id: "m3u-a",
    kind: "m3u",
    server: "https://tv.example.com",
    key: "k",
    name: "Woonkamer",
  },
  label: "Woonkamer",
  account: { state: "active", expiresAt: null, maxConnections: null, activeConnections: null },
  needsSecret: false,
  live: { kind: "idle" },
  titles: { kind: "idle" },
} as unknown as Member;

type ScreenOptions = ReturnType<typeof useTabScreenOptions>;

let unmount = () => {};
afterEach(async () => {
  unmount();
  const { native } = await import("./native-files.ts");
  for (const name of ["language.json", "language.json.next"]) {
    rmSync(join(native.root, "documents", name), { force: true });
  }
  Object.assign(scenario, {
    phone: ["en-US"],
    sheet: null,
    title: "",
    members: [],
    stack: null,
    tmdb: { kind: "no-key" },
  });
  scenario.alerts.length = 0;
  scenario.titles.length = 0;
});

/** Launches the app's modules afresh and shows `route`, as a launch reading the saved files. */
async function launch(route: "settings" | "connect") {
  vi.resetModules();
  // The root layout applies the saved language first, before any screen's module loads.
  await import("../src/language.ts");
  const screen =
    route === "settings"
      ? (await import("../src/app/(tabs)/(home)/settings.tsx")).default
      : (await import("../src/app/connect.tsx")).default;
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(screen)));
  unmount = () => React.act(() => root.unmount());
  const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`)!;
  return {
    text: () => container.textContent ?? "",
    language: () => find("settings-interface-language").getAttribute("aria-label"),
    status: () => find("settings-tmdb-status").getAttribute("aria-label"),
    /** Picks `label` from the sheet Interface language opens. */
    choose(label: string) {
      React.act(() =>
        find("settings-interface-language").dispatchEvent(new Event("click", { bubbles: true })),
      );
      const sheet = scenario.sheet!;
      expect(sheet.options).toContain(label);
      React.act(() => sheet.pick(sheet.options.indexOf(label)));
    },
    press(label: string) {
      const button = [...container.querySelectorAll("button")].find(
        (each) => each.textContent === label,
      )!;
      React.act(() => button.dispatchEvent(new Event("click", { bubbles: true })));
    },
  };
}

it("follows the iPhone's first language the app speaks on a fresh install", async () => {
  scenario.phone = ["ja-JP", "de-AT", "en-US"];
  const settings = await launch("settings");
  expect(settings.language()).toBe("Sprache der Oberfläche, Systemstandard (Deutsch)");
  expect(scenario.title).toBe("Einstellungen");
  expect(settings.text()).toContain("Anbieter hinzufügen");
});

it("shows English when the iPhone speaks none of the app's languages", async () => {
  scenario.phone = ["ja-JP"];
  const settings = await launch("settings");
  expect(settings.language()).toBe("Interface language, System default (English)");
  expect(scenario.title).toBe("Settings");
});

it("falls back to English when the preferred language list is empty", async () => {
  scenario.phone = [];
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  const regional = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolved,
    locale: "nl-NL",
  });
  try {
    const settings = await launch("settings");
    expect(settings.language()).toBe("Interface language, System default (English)");
    expect(scenario.title).toBe("Settings");
  } finally {
    regional.mockRestore();
  }
});

it("shows a picked language at once and opens in it after a relaunch", async () => {
  scenario.phone = ["de-DE"];
  scenario.members = [livingRoom];
  const settings = await launch("settings");
  settings.choose("Nederlands");
  expect(settings.language()).toBe("Taal van de interface, Nederlands");
  expect(scenario.title).toBe("Instellingen");
  // The provider's own name stays as its viewer named it; only the app's words change.
  expect(settings.text()).toContain("Woonkamer");
  expect(settings.text()).toContain("M3U-afspeellijst");
  unmount();

  scenario.members = [];
  const connect = await launch("connect");
  expect(connect.text()).toContain("Provider toevoegen");
  connect.press("Provider toevoegen");
  expect(scenario.alerts[0]?.title).toBe("Gebruiksstatistieken delen?");
});

it("words a provider's failure in the language, keeping its address as it is", async () => {
  scenario.phone = ["nl-NL"];
  const failed = { kind: "unreachable", server: "http://tv.example.com:8080", detail: "refused" };
  scenario.members = [{ ...livingRoom, live: { kind: "failed", error: failed } } as Member];
  const settings = await launch("settings");
  expect(settings.text()).toContain("Kan tv.example.com niet bereiken");
});

it("picks plural forms and writes counts as the language does", async () => {
  scenario.phone = ["nl-NL"];
  scenario.tmdb = { kind: "answered", known: 1, wanted: 1 };
  expect((await launch("settings")).status()).toBe("Status, 1 titel");
  unmount();
  scenario.tmdb = { kind: "answered", known: 1234, wanted: 1234 };
  expect((await launch("settings")).status()).toBe("Status, 1.234 titels");
  unmount();
  scenario.tmdb = { kind: "fetching", known: 1234, wanted: 2000 };
  expect((await launch("settings")).status()).toBe("Status, 1.234 van 2.000 titels");
});

it("titles another tab and labels its top bar in a new language at once", async () => {
  const settings = await launch("settings");
  // From the launch's own modules, which share its language.
  const { default: LiveLayout } = await import("../src/app/(tabs)/live/_layout.tsx");
  const root = createRoot(document.createElement("div"));
  React.act(() => root.render(React.createElement(LiveLayout)));
  expect(scenario.stack).toEqual({ title: "Live", buttons: ["Search", "Settings"] });
  settings.choose("Español");
  expect(scenario.stack).toEqual({ title: "En directo", buttons: ["Buscar", "Ajustes"] });
  React.act(() => root.unmount());
});

it("updates the mounted Add provider title after a language change", async () => {
  const settings = await launch("settings");
  const { default: Provider } = await import("../src/app/(tabs)/(home)/provider.tsx");
  const root = createRoot(document.createElement("div"));
  try {
    React.act(() => root.render(React.createElement(Provider)));
    expect(scenario.titles).toContain("Add provider");
    scenario.titles.length = 0;
    settings.choose("Nederlands");
    expect(scenario.titles).toContain("Provider toevoegen");
  } finally {
    React.act(() => root.unmount());
  }
});

it("returns to the iPhone's language when System default is picked again", async () => {
  scenario.phone = ["fr-CA"];
  const settings = await launch("settings");
  settings.choose("Español");
  expect(scenario.title).toBe("Ajustes");
  settings.choose("Sistema (Français)");
  expect(settings.language()).toBe("Langue de l'interface, Système (Français)");
  unmount();
  expect((await launch("settings")).language()).toBe("Langue de l'interface, Système (Français)");
});

/** Picks `label` while the files stand-in refuses `step`, as a full or failing disk would. */
async function chooseRefused(
  settings: Awaited<ReturnType<typeof launch>>,
  label: string,
  step: string,
) {
  const { native } = await import("./native-files.ts");
  native.sync = (operation) => {
    if (operation === step) throw new Error("disk full");
  };
  try {
    settings.choose(label);
  } finally {
    native.sync = null;
  }
}

it("keeps the language it shows when the choice can't be written, and says so", async () => {
  const settings = await launch("settings");
  await chooseRefused(settings, "Deutsch", "write");
  expect(settings.language()).toBe("Interface language, System default (English)");
  expect(scenario.alerts).toEqual([
    {
      title: "Couldn't save the language",
      message: "Your previous choice is still saved. Try again.",
    },
  ]);
  unmount();
  expect((await launch("settings")).language()).toBe(
    "Interface language, System default (English)",
  );
});

it("keeps the saved choice when the new one can't replace it", async () => {
  const settings = await launch("settings");
  settings.choose("Nederlands");
  await chooseRefused(settings, "Deutsch", "move");
  expect(settings.language()).toBe("Taal van de interface, Nederlands");
  expect(scenario.alerts).toEqual([
    {
      title: "Kon de taal niet bewaren",
      message: "Je vorige keuze is nog bewaard. Probeer het opnieuw.",
    },
  ]);
  unmount();
  expect((await launch("settings")).language()).toBe("Taal van de interface, Nederlands");
});

it("shows the choice a half-done replacement left, as the next launch reads it", async () => {
  const settings = await launch("settings");
  settings.choose("Nederlands");
  // The old file is gone; the new choice waits under the pending name, which a read takes.
  await chooseRefused(settings, "Deutsch", "move-after-delete");
  expect(settings.language()).toBe("Sprache der Oberfläche, Deutsch");
  expect(scenario.alerts).toEqual([]);
  unmount();
  expect((await launch("settings")).language()).toBe("Sprache der Oberfläche, Deutsch");
});
