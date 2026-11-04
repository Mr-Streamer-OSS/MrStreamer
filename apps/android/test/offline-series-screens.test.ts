import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, Fragment, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLanguage, setLanguage } from "@mrstreamer/core/i18n";
import { fixture } from "./library-fixture.ts";
import { store } from "../src/platform/store.ts";
import type { DownloadRow, DownloadState } from "../src/downloads/state.ts";
import type { ReplacePrompt } from "../src/downloads/replace.ts";

// The bulk series rows, their sheet and result, and Replace, as Details and Downloads render them,
// driving the real series controller over a fake native port.

vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useSegments: () => ["(tabs)", "series"],
  router: { navigate: vi.fn() },
}));

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/platform/storage.ts", () => ({
  readJson: () => ({}),
  writeJson: () => {
    throw new Error("Read only");
  },
}));

vi.mock("react-native-safe-area-context", async () => {
  const insets = { top: 0, left: 0, right: 0, bottom: 0 };

  return {
    useSafeAreaInsets: () => insets,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");

  interface Props {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { disabled?: boolean };
    disabled?: boolean;
    onPress?(): void;
    visible?: boolean;
  }

  const view = (tag: string) => (p: Props) =>
    h(
      tag,
      {
        "aria-label": p.accessibilityLabel,
        role: p.accessibilityRole,
        disabled: p.disabled,
        onClick: p.disabled ? undefined : p.onPress,
      },
      p.children,
    );

  return {
    View: view("div"),
    Text: view("span"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    Pressable: view("button"),
    Modal: (p: Props) => (p.visible ? h("dialog", { open: true }, p.children) : null),
    useWindowDimensions: () => ({ width: 412, height: 900, fontScale: 1 }),
  };
});

const { seriesDownloads, seriesFiles, seriesOwner } = await import("../src/downloads/series.ts");

const { SeriesDialogs, SeriesDownloadRow } = await import("../src/downloads/series-download.tsx");
const { askReplace } = await import("../src/downloads/replace.ts");
const { router } = await import("expo-router");
const window = new Window();

Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const reactDom = "react-dom/client";

const { createRoot } = (await import(reactDom)) as {
  createRoot(container: HTMLElement): {
    render(node: ReactNode): void;
    unmount(): void;
  };
};

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  window.document.body.innerHTML = "";
  seriesOwner.set(undefined);
  setLanguage(resolveLanguage("en-US", []));
  vi.mocked(router.navigate).mockClear();
});

async function series() {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("series").list("all")[0]!;
  const details = await f.model.details(title);

  if (details.value?.kind !== "series") throw new Error("series");

  const files = seriesFiles(details.value, title, details.containers, "Source", {
    kind: "series",
  });

  const row = (mediaId: string, extra: Partial<DownloadRow>): DownloadRow => {
    const file = files.find((f) => f.mediaId === mediaId)!;

    return {
      id: mediaId,
      state: "complete",
      bytes: 8,
      total: 8,
      reason: "",
      ...file,
      order: [...file.order],
      ...extra,
    };
  };

  return { details: details.value, containers: details.containers, title, files, row };
}

/** Downloads as Details sees it: `rows` on this device, a native port `admit` answers. */
function owner(rows: DownloadRow[], admit: (key: string, expected: string) => Promise<string>) {
  const state = store<DownloadState>({
    rows,
    free: 1,
    loading: false,
    notifications: true,
    error: null,
  });

  const admitted: string[] = [];
  const playing = new Set<string>();

  const value = {
    state,
    prompt: store<ReplacePrompt | null>(null),
    replace: vi.fn(async (_row: DownloadRow) => "replaced"),
    series: () =>
      seriesDownloads(
        {
          review: async () =>
            JSON.stringify({ token: "review", snapshot: { rows: state.get().rows, free: 1 } }),
          admit: async (_token, key, expected) => {
            admitted.push(key);

            return admit(key, expected);
          },
          endReview: async () => {},
        },
        async (row) => !playing.has(row.id),
        async () => {},
      ),
  };

  seriesOwner.set(value);

  return { value, admitted, playing };
}

function show(node: ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Fragment, null, node, createElement(SeriesDialogs))));

  return container;
}

async function press(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  );

  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

const dialog = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("dialog"))
    .map((d) => d.textContent)
    .join("\n");

const seasonLabel = (n: number) => (n === 0 ? "Specials" : `Season ${n}`);

/** The whole series' bulk row on Details for the fixture series `s`. */
const seriesRow = (s: Awaited<ReturnType<typeof series>>, versionLabel = "Full HD") =>
  createElement(SeriesDownloadRow, {
    details: s.details,
    version: s.title,
    containers: s.containers,
    seasonLabel,
    versionLabel,
    sourceLabel: "Source",
    reader: () => "reader",
  });

it("reviews the whole series with Specials and exact counts, then reports what it queued", async () => {
  const s = await series();

  const { admitted } = owner(
    [s.row("first", {}), s.row("special", { state: "failed", reason: "missing" })],
    async (_key, expected) => (expected === "missing" ? "replaced" : "added"),
  );

  const shown = show(seriesRow(s, "Full HD · English sound"));

  expect(shown.textContent).toContain("Whole series · 1 of 3 saved or queued");
  await press(shown, "Review series download");
  const sheet = dialog(shown);
  expect(sheet).toContain(`Download all of ${s.details.title.title}?`);
  expect(sheet).toContain("Full HD · English sound");
  expect(sheet).toContain("3 episodes in 3 seasons.");

  // Each season's count in the tabs' order, Specials included.
  const seasons = s.details.seasons.map((season) => seasonLabel(season.number));
  expect(seasons).toContain("Specials");
  const at = seasons.map((label) => sheet.indexOf(`${label}1 episode`));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);

  expect(sheet).toContain("1 already saved or queued.");
  expect(sheet).toContain("1 saved file is missing.");
  expect(sheet).toContain("Size unavailable. Uses the selected version.");
  await press(shown, "Download 1 and replace 1 missing");
  await vi.waitFor(() => expect(dialog(shown)).toContain("1 queued. 1 replaced."));
  // The saved copy isn't asked for again, and the series queues in its own order.
  expect(admitted).toEqual(s.files.filter((f) => f.mediaId !== "first").map((f) => f.key));
  expect(dialog(shown)).toContain(s.details.title.title);
  expect(dialog(shown)).not.toContain("Retry failed");
  await press(shown, "Open Downloads");
  expect(router.navigate).toHaveBeenCalledWith("/series/downloads");
  expect(dialog(shown)).toBe("");
});

it("cancels only what isn't queued yet, in Dutch, and says so", async () => {
  setLanguage(resolveLanguage("nl-NL", []));
  const s = await series();
  let release: (value: string) => void = () => {};

  const { admitted } = owner(
    [],
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );

  const shown = show(seriesRow(s));

  expect(shown.textContent).toContain("Hele serie · 3 afleveringen");
  await press(shown, "Serie downloaden bekijken");
  await press(shown, "3 afleveringen downloaden");
  await vi.waitFor(() => expect(admitted).toHaveLength(1));
  expect(shown.textContent).toContain("1 van 3 toevoegen");
  expect(shown.textContent).toContain("Stopt als je deze serie verlaat");
  await press(shown, "De rest annuleren");
  await act(async () => release("added"));
  await vi.waitFor(() =>
    expect(dialog(shown)).toContain("1 in de wachtrij gezet. Geannuleerd vóór 2 afleveringen."),
  );
  expect(admitted).toHaveLength(1);
  await press(shown, "OK");
  expect(dialog(shown)).toBe("");
});

it("leaves changed files to their own Replace and a playing copy as it is", async () => {
  const s = await series();

  const { admitted, playing } = owner(
    [
      s.row("first", { state: "failed", reason: "file-changed" }),
      s.row("special", { state: "failed", reason: "missing" }),
    ],
    async () => "added",
  );

  playing.add("special");

  const shown = show(seriesRow(s));

  await press(shown, "Review series download");
  expect(dialog(shown)).toContain("1 saved file changed. Replace it in Downloads.");
  await press(shown, "Download 1 and replace 1 missing");
  await vi.waitFor(() =>
    expect(dialog(shown)).toContain("1 queued. 1 changed meanwhile and stayed as they were."),
  );
  expect(admitted).toEqual([s.files.find((f) => f.mediaId === "second")!.key]);
  await press(shown, "OK");
});

it("replaces a missing file at once and asks before replacing a changed one", async () => {
  const s = await series();
  const { value } = owner([], async () => "added");
  const shown = show(null);

  askReplace(value, s.row("special", { state: "failed", reason: "missing" }));
  expect(value.replace).toHaveBeenCalledTimes(1);
  expect(dialog(shown)).toBe("");

  value.replace.mockResolvedValueOnce("playing");
  await act(async () =>
    askReplace(value, s.row("first", { state: "failed", reason: "file-changed" })),
  );
  const asked = dialog(shown);
  expect(asked).toContain(`Replace the copy of ${s.details.title.title} S1 E1?`);
  expect(asked).toContain(
    "Its file changed on this device. Replacing deletes it and downloads S1 E1 again in the same version.",
  );
  expect(value.replace).toHaveBeenCalledTimes(1);
  await press(shown, "Replace");
  expect(value.replace).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(dialog(shown)).toContain("Stop playing this copy first."));
});
