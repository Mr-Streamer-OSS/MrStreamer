import { createRoot, document } from "./dom.ts";
import * as React from "react";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { Locale } from "@mrstreamer/contracts/language";
import { formatPercent, setLanguage } from "@mrstreamer/core/i18n";
import { afterEach, expect, it, vi } from "vitest";

// Downloads in the interface language, as the viewer meets it: the screen's sections, states,
// sheets and VoiceOver actions, and the top bar's Downloads button, in the language picked. A new
// language redraws them where they stand, while the queue, its order and every state stay as they
// were, and a VoiceOver action keeps its one English name. Title and provider names stay as the
// provider gives them. The real screens run with React DOM on a happy-dom window, as
// downloads-screen.test.ts does.

interface Touchable {
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly accessibilityActions?: readonly { name: string; label?: string }[];
  readonly onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}

const scenario = vi.hoisted(() => ({
  list: { items: [], series: {}, bytes: 0, free: null, ended: 0 } as DownloadList,
  listeners: new Set<() => void>(),
  pressables: new Map<string, Touchable>(),
  sheet: null as null | { title?: string; options: readonly string[] },
  asked: [] as string[],
}));

vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children }: Props) => createElement("div", null, children);
  type Section = { key: string; data: readonly { id: string }[] };
  return {
    View: box,
    Text: ({ children }: Props) => createElement("p", null, children),
    Pressable: (props: Props & Touchable & { children?: unknown }) => {
      if (props.testID) scenario.pressables.set(props.testID, props);
      const children =
        typeof props.children === "function"
          ? (props.children as (state: object) => React.ReactNode)({ pressed: false })
          : props.children;
      return createElement(
        "div",
        { "aria-label": props.accessibilityLabel },
        children as React.ReactNode,
      );
    },
    SectionList: (props: {
      sections: readonly Section[];
      renderSectionHeader: (info: { section: Section }) => React.ReactNode;
      renderSectionFooter: (info: { section: Section }) => React.ReactNode;
      renderItem: (info: { item: { id: string } }) => React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) =>
      createElement(
        "div",
        null,
        props.sections.map((section) =>
          createElement(
            Fragment,
            { key: section.key },
            props.renderSectionHeader({ section }),
            section.data.map((item) =>
              createElement(Fragment, { key: item.id }, props.renderItem({ item })),
            ),
            props.renderSectionFooter({ section }),
          ),
        ),
        props.ListFooterComponent,
      ),
    Animated: {
      View: box,
      Value: class {
        setValue() {}
      },
      timing: () => ({ start: () => undefined }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ fontScale: 1 }),
    Alert: { alert: (title: string) => scenario.asked.push(`alert ${title}`) },
    ActionSheetIOS: {
      showActionSheetWithOptions: ({
        title,
        options,
      }: {
        title?: string;
        options: readonly string[];
      }) => {
        scenario.sheet = { ...(title ? { title } : {}), options };
      },
    },
  };
});
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/titles-ui.tsx", () => ({ Artwork: () => null }));
vi.mock("../src/ui.tsx", () => ({
  colors: { text: "#FFFFFF", dim: "#A1A1A6", line: "#2C2C2E" },
  Notice: () => null,
}));
vi.mock("../src/downloads.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useDownloads: () =>
      useSyncExternalStore(
        (listener) => {
          scenario.listeners.add(listener);
          return () => scenario.listeners.delete(listener);
        },
        () => scenario.list,
      ),
    downloadList: () => scenario.list,
    useDownloadOf: () => undefined,
    addDownload: async () => undefined,
    playDownload: (id: string) => scenario.asked.push(`play ${id}`),
    removeDownload: async (id: string) => scenario.asked.push(`remove ${id}`),
    retryDownload: async (id: string) => scenario.asked.push(`retry ${id}`),
    pauseDownload: async (id: string) => scenario.asked.push(`pause ${id}`),
    resumeDownload: async (id: string) => scenario.asked.push(`resume ${id}`),
    moveDownload: async (id: string, by: number) => scenario.asked.push(`move ${id} ${by}`),
  };
});

const { DownloadsScreen } = await import("../src/downloads-screen.tsx");
const { DownloadStatusButton } = await import("../src/download-status.tsx");

const base = {
  subscription: { id: "a", name: "Northside" },
  episodeName: null,
  year: 2024,
  duration: null,
  originalLanguage: null,
  posterUrl: null,
  wideUrl: null,
  size: null,
  progress: null,
  series: null,
} as const;
const movie = (id: string, name: string, status: Download["status"]): Download => ({
  ...base,
  id,
  name,
  title: { kind: "movie", id },
  status,
});
const paused = movie("p", "Iron Bay", { kind: "paused", received: 0, size: null });
const queued = movie("q", "Glass Orchard", { kind: "queued" });
const stopped = movie("f", "Kettle Run", {
  kind: "failed",
  failure: { kind: "app", error: { kind: "unexpected", detail: "This download stopped." } },
});
const offline = movie("o", "Salt Meridian", {
  kind: "failed",
  failure: { kind: "stream", failure: { kind: "network", detail: "You seem to be offline." } },
});
// Saved by an earlier version in Dutch: its offline sentence, and the generic one.
const savedDutch = movie("d", "Lantern Weir", {
  kind: "failed",
  failure: { kind: "stream", failure: { kind: "network", detail: "Je lijkt offline te zijn." } },
});
const savedGeneric = movie("g", "Copper Fen", {
  kind: "failed",
  failure: {
    kind: "stream",
    failure: { kind: "network", detail: "De verbinding met de provider is mislukt." },
  },
});
const copy = movie("c", "North of Quiet", { kind: "complete" });
const transferring = movie("t", "Paper Harbor", {
  kind: "transferring",
  received: 42,
  size: 100,
  rate: null,
  restarted: false,
});

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.pressables.clear();
  scenario.sheet = null;
  scenario.asked.length = 0;
  setLanguage({ locale: "en-US", formats: "en-US" });
});

const speak = (locale: Locale) => React.act(() => setLanguage({ locale, formats: locale }));
function show(node: React.ReactElement, items: readonly Download[]) {
  scenario.list = { items, series: {}, bytes: 0, free: null, ended: 0 };
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(node));
  unmount = () => React.act(() => root.unmount());
  return container;
}
const row = (id: string) => scenario.pressables.get(`download-${id}`)!;
const actions = (id: string) => row(id).accessibilityActions?.slice();

it("shows Downloads in the language picked and redraws it in a new one, the queue untouched", () => {
  speak("nl-NL");
  const screen = show(React.createElement(DownloadsScreen), [
    paused,
    queued,
    stopped,
    offline,
    savedDutch,
    savedGeneric,
    copy,
  ]);
  expect(screen.textContent).toContain("Wachtrij");
  expect(screen.textContent).toContain("Op deze iPhone");
  expect(screen.textContent).toContain("Gepauzeerd");
  // A reason downloads.ts keeps in English reads in the language.
  expect(screen.textContent).toContain("Deze download is gestopt.");
  expect(screen.textContent).toContain(
    "De verbinding met de provider is mislukt. Je lijkt offline te zijn.",
  );
  expect(row("p").accessibilityLabel).toBe("Iron Bay, 2024, Gepauzeerd");
  expect(actions("p")).toEqual([
    { name: "Resume", label: "Hervatten" },
    { name: "Move Iron Bay down", label: "Iron Bay omlaag" },
    { name: "Cancel download", label: "Download annuleren" },
  ]);
  row("c").onLongPress!();
  expect(scenario.sheet?.options).toEqual([
    "Offline afspelen",
    "Download verwijderen",
    "Annuleren",
  ]);

  // The rows' order as drawn.
  const names = [paused, queued, stopped, offline, savedDutch, savedGeneric, copy].map(
    ({ name }) => name,
  );
  const text = () => screen.textContent ?? "";
  const order = () => names.toSorted((a, b) => text().indexOf(a) - text().indexOf(b));
  const before = order();
  speak("de-DE");
  expect(screen.textContent).toContain("Warteschlange");
  expect(screen.textContent).toContain("Auf diesem iPhone");
  expect(screen.textContent).toContain("Dieser Download wurde angehalten.");
  expect(screen.textContent).toContain(
    "Die Verbindung zum Anbieter ist fehlgeschlagen. Du scheinst offline zu sein.",
  );
  // Earlier versions' Dutch reads in German too, and the generic sentence is said once.
  expect(screen.textContent).not.toContain("Je lijkt offline te zijn.");
  expect(screen.textContent).not.toContain("De verbinding met de provider is mislukt.");
  expect(screen.textContent?.split("Die Verbindung zum Anbieter ist fehlgeschlagen.")).toHaveLength(
    4,
  );
  expect(screen.textContent).not.toContain("Wachtrij");
  expect(row("q").accessibilityLabel).toBe("Glass Orchard, 2024, In der Warteschlange");
  expect(actions("p")).toEqual([
    { name: "Resume", label: "Fortsetzen" },
    { name: "Move Iron Bay down", label: "Iron Bay nach unten" },
    { name: "Cancel download", label: "Download abbrechen" },
  ]);
  // Nothing was asked of the queue, and its rows stand as they were.
  expect(scenario.asked).toEqual([]);
  expect(order()).toEqual(before);

  // VoiceOver's action keeps its English name in any language.
  row("p").onAccessibilityAction!({ nativeEvent: { actionName: "Resume" } });
  row("f").onLongPress!();
  expect(scenario.sheet).toEqual({
    title: "Dieser Download wurde angehalten.",
    options: ["Erneut versuchen", "Entfernen", "Abbrechen"],
  });
  expect(scenario.asked).toEqual(["resume p"]);
});

it("says the top bar's queue state in the language, and again in a new one", () => {
  speak("fr-FR");
  const bar = show(
    React.createElement(DownloadStatusButton, { onPress: () => scenario.asked.push("open") }),
    [transferring, queued],
  );
  const label = () => bar.querySelector("[aria-label]")?.getAttribute("aria-label");
  expect(label()).toBe(`Téléchargements, Paper Harbor, ${formatPercent(0.42)} téléchargés`);

  speak("es-ES");
  expect(label()).toBe(`Descargas, Paper Harbor, ${formatPercent(0.42)} descargado`);
  React.act(() => {
    scenario.list = {
      ...scenario.list,
      items: [queued, movie("r", "Low Tide", { kind: "queued" })],
    };
    for (const listener of scenario.listeners) listener();
  });
  expect(label()).toBe("Descargas, 2 en cola");
  expect(bar.textContent).toBe("2");
  React.act(() => {
    scenario.list = { ...scenario.list, items: [paused] };
    for (const listener of scenario.listeners) listener();
  });
  expect(bar.textContent).toBe("En pausa");
  expect(label()).toBe("Descargas, 1 en pausa");
  speak("nl-NL");
  expect(bar.textContent).toBe("Gepauzeerd");
  expect(label()).toBe("Downloads, 1 gepauzeerd");
});
