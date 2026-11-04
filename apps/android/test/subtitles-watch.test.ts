import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { MediaState } from "../src/player/media.ts";
import type { Track } from "../src/player/native.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";
import type { SnackbarMessage } from "../src/settings/parts.tsx";

// Online subtitles as the viewer meets them in Watch and Settings: the downloaded subtitle under
// the file's tracks, Find online's search and results, the key it asks for, the timing sheet and
// what failed. Watch renders with React DOM on a happy-dom window as player-watch.test.ts does;
// the player is a store, the subtitle model is the real one over a stand-in native player,
// sealed store and files, and SubDL is a stand-in fetch.

const still = vi.hoisted((): MediaState => ({
  tracksKnown: true,
  pip: false,
  pipSupported: true,
  automatic: true,
  next: null,
  remaining: null,
  error: null,
}));

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  /** The sealed SubDL key, and whether this phone keeps a new one. */
  key: null as string | null,
  writable: true,
  /** The subtitle kept for the version that plays. */
  retained: null as unknown,
  /** Whether the native player takes a sidecar or its timing. */
  accept: true,
  sidecars: [] as { offset: number; speed: number }[],
  insets: [] as number[],
  /** The key field's props, as the dialog last rendered it. */
  input: null as null | { onChangeText: (text: string) => void; secureTextEntry?: boolean },
  sizeWritable: true,
  /** What SubDL's search waits for before it answers. */
  answered: Promise.resolve() as Promise<void>,
}));

vi.mock("react-native", async () => {
  const { createElement: h, useLayoutEffect } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; selected?: boolean };
    onPress?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };

  const view =
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      onPress,
      onLayout,
    }: Props) => {
      useLayoutEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 412, height: 72 } } }),
        [],
      );

      return h(
        tag,
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole === "radio" ? "radio" : undefined,
          "aria-checked": accessibilityState?.checked,
          "aria-selected": accessibilityState?.selected,
          onClick: onPress,
          tabIndex: -1,
        },
        children,
      );
    };

  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    TextInput: (props: NonNullable<typeof scenario.input>) => {
      scenario.input = props;

      return null;
    },
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? h("section", {}, children) : null,
    Alert: { alert() {} },
    StatusBar: () => null,
    useWindowDimensions: () => ({ width: 915, height: 412, fontScale: 1 }),
    AppState: { addEventListener: () => ({ remove() {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    AccessibilityInfo: {
      isScreenReaderEnabled: () => new Promise<boolean>(() => {}),
      addEventListener: () => ({ remove() {} }),
      announceForAccessibility() {},
    },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");

  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: { children?: ReactNode }) => children,
    SafeAreaInsetsContext: createContext(null),
  };
});

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

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => scenario.params,
  useIsFocused: () => true,
  usePathname: () => "/watch",
  router: { canGoBack: () => true, back() {}, replace() {}, push() {} },
}));

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const { subtitleModel } = await import("../src/subtitles/model.ts");
  const state = store<PlayerState>({ kind: "idle" });
  const media = store<MediaState>(still);

  const player = {
    state,
    media: {
      state: media,
      speeds: [1],
      watch() {},
      reconcile() {},
      retryPreferences() {},
      text: () => Promise.resolve(true),
      dismissError() {},
      cancelNext() {},
    },
    play() {
      return "attempt";
    },
    retry() {},
  };

  const subtitles = subtitleModel({
    player,
    native: {
      setText: () => Promise.resolve(true),
      setSidecar(_attempt, _text, _language, offset, speed) {
        scenario.sidecars.push({ offset, speed });

        return Promise.resolve(scenario.accept);
      },
      unpackSubtitle: (bytes) => Promise.resolve(bytes),
      setSubtitleInset(fraction) {
        scenario.insets.push(fraction);

        return Promise.resolve();
      },
    },
    secrets: {
      read: () => Promise.resolve(scenario.key),
      write(_id, key) {
        if (!scenario.writable) return Promise.reject(new Error("refused"));
        scenario.key = key;

        return Promise.resolve();
      },
      remove() {
        scenario.key = null;

        return Promise.resolve();
      },
    },
    files: {
      read: () => scenario.retained,
      write(_key, value) {
        scenario.retained = value;
      },
      remove() {
        scenario.retained = null;
      },
    },
    title: (intent) =>
      Promise.resolve(
        intent.kind !== "title"
          ? null
          : {
              key: intent.id,
              query:
                intent.media === "episode"
                  ? { kind: "episode", title: intent.title, season: 1, episode: 3 }
                  : { kind: "movie", title: intent.title },
            },
      ),
    languages: () => ["nl", "en"],
  });

  return { player: { ...player, subtitles } };
});

vi.mock("../src/subtitles/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const { player } = await import("../src/player/instance.ts");
  const size = store(1);

  return {
    subtitles: () => player.subtitles,
    subtitleTextSize: size,
    subtitleTextSizeError: (await import("../src/platform/store.ts")).store(false),
    readSubtitleTextSize: () => true,
    setSubtitleTextSize(value: number) {
      if (!scenario.sizeWritable) return false;
      size.set(value);

      return true;
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: Element): { render(node: ReactNode): void; unmount(): void };
};

const { default: Watch } = await import("../src/app/watch.tsx");
const { SubtitleSettingsSection } = await import("../src/subtitles/settings-section.tsx");
const { SIDECAR_TRACK } = await import("../src/subtitles/model.ts");
const { player } = await import("../src/player/instance.ts");
const { watchHref } = await import("../src/player/intent.ts");

const episode: PlayIntent = {
  kind: "title",
  sourceId: "source-1",
  media: "episode",
  id: "e3",
  container: "mkv",
  title: "Estuary Line",
};

const track = (change: Partial<Track> & Pick<Track, "id">): Track => ({
  type: "text",
  codec: "application/x-subrip",
  language: null,
  label: null,
  width: null,
  height: null,
  bitrate: null,
  channels: null,
  selected: false,
  supported: true,
  ...change,
});

/** The file's Dutch subtitle and the downloaded one, with `shows` the one the player reports. */
const tracks = (shows: "nl" | "downloaded" | null) => [
  track({ id: "nl", language: "nl", selected: shows === "nl" }),
  track({
    id: SIDECAR_TRACK,
    language: "en",
    codec: "text/vtt",
    selected: shows === "downloaded",
  }),
];

function playing(intent: PlayIntent, change: Partial<Playing> = {}): Playing {
  return {
    kind: "playing",
    intent,
    attempt: "before",
    phase: "playing",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: intent.kind === "live",
    seekable: false,
    speed: 1,
    failure: null,
    tracks: [],
    ...change,
  };
}

const kept = (timing = { offset: 0, speed: 1 }): SavedSubtitle => ({
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Estuary.Line.S01E03.720p.HDTV.x264",
    cues: [{ start: 1, end: 2, text: "We wait for the tide, then we go." }],
  },
  timing,
  shown: true,
});

/** SubDL's answer for the episode: Dutch SubRip, English WebVTT for hearing impaired, two ASS. */
const reply = {
  status: true,
  results: [{ type: "tv", name: "Estuary Line" }],
  subtitles: [
    {
      url: "/season.zip",
      unpack_files: [
        ["Dutch", "Estuary.Line.S01E03.1080p.WEB-DL", "srt", false],
        ["English", "Estuary.Line.S01E03.720p.HDTV.x264", "vtt", true],
        ["English", "Estuary.Line.S01E03.styled", "ass", false],
        ["English", "Estuary.Line.S01E03.karaoke", "ass", false],
      ].map(([language, name, format, hi], index) => ({
        language,
        name,
        format,
        hi,
        season: 1,
        episode: 3,
        url: `/file-${index}.zip`,
      })),
    },
  ],
};

/** Search answers `reply` once `scenario.answered`; a download waits until it is cancelled. */
const fetch = vi.fn((input: URL, init: RequestInit) =>
  input.hostname === "api.subdl.com"
    ? scenario.answered.then(() => new Response(JSON.stringify(reply)))
    : new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
);

let root: ReturnType<typeof createRoot> | null = null;

function mount(node: ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));

  return container;
}

/** Opens Watch over `intent` playing, once the model has taken the play. */
async function watch(intent: PlayIntent, change: Partial<Playing> = {}) {
  const href = watchHref(intent);
  scenario.params = "params" in href ? href.params : {};
  await act(async () => player.state.set(playing(intent, change)));

  return mount(createElement(Watch));
}

const report = (shows: "nl" | "downloaded" | null) =>
  act(() => player.state.set(playing(episode, { tracks: tracks(shows) })));

/** The buttons by what they say, as the viewer reads them. */
const labels = (shown: Element) =>
  Array.from(shown.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? button.textContent,
  );

async function press(shown: Element, label: string) {
  const button = Array.from(shown.querySelectorAll("button")).find(
    (each) => (each.getAttribute("aria-label") ?? each.textContent) === label,
  );

  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${label}`);
  await act(async () => button.click());
}

const ticked = (shown: Element) =>
  Array.from(shown.querySelectorAll('[role="radio"][aria-checked="true"]')).map((row) =>
    row.getAttribute("aria-label"),
  );

const downloaded = "English, Estuary.Line.S01E03.720p.HDTV.x264, Downloaded";

beforeEach(() => {
  Object.assign(scenario, {
    key: null,
    writable: true,
    retained: null,
    accept: true,
    sidecars: [],
    insets: [],
    input: null,
    sizeWritable: true,
    answered: Promise.resolve(),
  });
  vi.stubGlobal("fetch", fetch);
  fetch.mockClear();
  player.media.state.set(still);
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  window.document.body.innerHTML = "";
  await act(async () => player.state.set({ kind: "idle" }));
  vi.unstubAllGlobals();
});

describe("Watch's online subtitles", () => {
  it("lists the downloaded subtitle under the file's own, ticked only once the player reports it", async () => {
    scenario.retained = kept({ offset: 0.4, speed: 1 });
    const shown = await watch(episode, { tracks: tracks("nl") });
    await vi.waitFor(() => expect(scenario.sidecars).toHaveLength(1));

    await press(shown, "Subtitles");
    expect(ticked(shown)).toEqual(["Nederlands, SubRip"]);
    // The sidecar the player reports is the Downloaded row, not another file track.
    expect(labels(shown)).toEqual(
      expect.arrayContaining(["Off", "Nederlands, SubRip", downloaded, "Find online, SubDL"]),
    );
    expect(labels(shown)).not.toContain("English, WebVTT");
    expect(labels(shown).some((label) => label?.startsWith("Adjust timing"))).toBe(false);

    await press(shown, downloaded);
    expect(scenario.sidecars).toHaveLength(1);
    await press(shown, "Subtitles");
    expect(ticked(shown)).toEqual(["Nederlands, SubRip"]);

    report("downloaded");
    expect(ticked(shown)).toEqual([downloaded]);
    expect(labels(shown)).toContain("Adjust timing, Shown 0.4 s later");
  });

  it("searches SubDL in the viewer's languages, counts what it can't show, and a tapped result reads Downloading until tapped again", async () => {
    scenario.key = "sealed-fixture-key";
    let answer = () => {};

    scenario.answered = new Promise((resolve) => (answer = resolve));
    const shown = await watch(episode, { tracks: tracks("nl") });

    await press(shown, "Subtitles");
    await press(shown, "Find online, SubDL");
    expect(shown.textContent).toContain("Searching SubDL");
    expect(shown.textContent).toContain("Estuary Line, in Nederlands and English");

    await act(async () => answer());
    await vi.waitFor(() =>
      expect(shown.textContent).toContain("Can't show here: 2 results in ASS."),
    );
    expect(shown.textContent).toContain("Nederlands · English");
    const dutch = "Nederlands, Estuary.Line.S01E03.1080p.WEB-DL, SubRip";
    expect(labels(shown)).toEqual(
      expect.arrayContaining([
        dutch,
        "English · Hearing impaired, Estuary.Line.S01E03.720p.HDTV.x264, WebVTT",
      ]),
    );

    await press(shown, dutch);
    expect(labels(shown)).toContain("Nederlands, Estuary.Line.S01E03.1080p.WEB-DL, Downloading");

    await press(shown, "Nederlands, Estuary.Line.S01E03.1080p.WEB-DL, Downloading");
    expect(labels(shown)).toContain(dutch);
    expect(shown.textContent).not.toContain("sealed-fixture-key");
  });

  it("asks for a missing key, says a refused save in its dialog, and Save and search searches with it", async () => {
    const shown = await watch(episode, { tracks: tracks("nl") });
    await press(shown, "Subtitles");
    await press(shown, "Find online, SubDL");
    await vi.waitFor(() => expect(shown.textContent).toContain("SubDL key needed"));
    expect(shown.textContent).toContain("It stays sealed on this phone.");

    await press(shown, "Add key");
    expect(scenario.input?.secureTextEntry).toBe(true);
    act(() => scenario.input?.onChangeText("fresh-fixture-key"));

    scenario.writable = false;
    await press(shown, "Save and search");
    expect(shown.textContent).toContain("Couldn't save the key. This phone refused it.");
    expect(fetch).not.toHaveBeenCalled();

    scenario.writable = true;
    await press(shown, "Save and search");
    expect(scenario.key).toBe("fresh-fixture-key");
    await vi.waitFor(() => expect(shown.textContent).toContain("Nederlands · English"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(shown.textContent).not.toContain("fresh-fixture-key");
  });

  it("offers Replace key when SubDL refuses the key", async () => {
    scenario.key = "refused-fixture-key";
    fetch.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })));
    const shown = await watch(episode, { tracks: tracks("nl") });
    await press(shown, "Subtitles");
    await press(shown, "Find online, SubDL");
    await vi.waitFor(() => expect(shown.textContent).toContain("SubDL refused the key"));
    expect(shown.textContent).toContain("Nothing was searched.");

    await press(shown, "Replace key");
    expect(scenario.input).not.toBeNull();
  });

  it("says SubDL isn't available offline while the downloaded subtitle keeps showing", async () => {
    scenario.key = "sealed-fixture-key";
    scenario.retained = kept();
    fetch.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    const shown = await watch(episode, { tracks: tracks("nl") });
    report("downloaded");

    await press(shown, "Subtitles");
    await press(shown, "Find online, SubDL");
    await vi.waitFor(() => expect(shown.textContent).toContain("SubDL isn't available"));
    expect(shown.textContent).toContain(
      "Check your connection and try again. The downloaded subtitle still shows.",
    );

    await press(shown, "OK");
    expect(shown.textContent).not.toContain("SubDL isn't available");
  });

  it("raises the cue over Adjust timing, applies each step at once, keeps the previous timing when refused, and lowers it on close", async () => {
    scenario.retained = kept();
    const shown = await watch(episode, { tracks: tracks("nl") });
    await vi.waitFor(() => expect(scenario.sidecars).toHaveLength(1));
    report("downloaded");

    await press(shown, "Subtitles");
    await press(shown, "Adjust timing, Original timing");
    await vi.waitFor(() => expect(scenario.insets.at(-1)).toBeGreaterThan(0.08));
    expect(labels(shown)).toEqual(
      expect.arrayContaining(["1 s earlier", "0.1 s earlier", "0.1 s later", "1 s later"]),
    );
    expect(labels(shown)).not.toContain("Reset");

    await press(shown, "1 s later");
    expect(scenario.sidecars.at(-1)).toEqual({ offset: 1, speed: 1 });
    expect(shown.textContent).toContain("Shown 1 s later");

    await press(shown, "Frame rate, Original");
    expect(ticked(shown)).toEqual(["Original"]);
    await press(shown, "25 → 23.976 fps");
    expect(scenario.sidecars.at(-1)?.speed).toBeCloseTo(25 / (24000 / 1001));
    expect(shown.textContent).toContain("Shown 1 s later · 25 → 23.976 fps");

    scenario.accept = false;
    await press(shown, "0.1 s earlier");
    expect(shown.textContent).toContain("Couldn't change timing");
    expect(shown.textContent).toContain("The previous timing is kept.");
    await press(shown, "OK");
    expect(shown.textContent).toContain("Shown 1 s later · 25 → 23.976 fps");

    scenario.accept = true;
    await press(shown, "Reset");
    expect(scenario.sidecars.at(-1)).toEqual({ offset: 0, speed: 1 });
    expect(labels(shown)).not.toContain("Reset");

    await press(shown, "Close Adjust timing");
    expect(scenario.insets.at(-1)).toBe(0.08);
  });

  it("offers no Find online on Live", async () => {
    const live: PlayIntent = {
      kind: "live",
      sourceId: "source-1",
      channelId: "estuary",
      title: "Estuary Max",
    };

    const shown = await watch(live, { tracks: [track({ id: "nl", language: "nl" })] });
    await press(shown, "Subtitles");
    expect(labels(shown)).toContain("Nederlands, SubRip");
    expect(labels(shown)).not.toContain("Find online, SubDL");
  });
});

describe("Settings' Subtitles section", () => {
  it("shows the SubDL key only as Saved or Not set, retries a refused save, and removing it keeps downloaded subtitles", async () => {
    scenario.retained = kept();
    const notify = vi.fn<(message: SnackbarMessage) => void>();
    const shown = mount(createElement(SubtitleSettingsSection, { notify }));
    await vi.waitFor(() => expect(shown.textContent).toContain("Not set"));
    expect(shown.textContent).toContain("Medium");

    await press(shown, "SubDL API key");
    act(() => scenario.input?.onChangeText("settings-fixture-key"));
    scenario.writable = false;
    await press(shown, "Save");
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Couldn't save the key. This phone refused it." }),
      ),
    );
    expect(scenario.key).toBeNull();

    scenario.writable = true;
    await act(async () => notify.mock.lastCall?.[0].action?.run());
    await vi.waitFor(() => expect(shown.textContent).toContain("Saved"));
    expect(scenario.key).toBe("settings-fixture-key");
    expect(shown.textContent).not.toContain("settings-fixture-key");

    await press(shown, "SubDL API key");
    await press(shown, "Remove");
    await vi.waitFor(() => expect(shown.textContent).toContain("Not set"));
    expect(scenario.retained).toEqual(kept());
  });

  it("keeps the text size when this phone refuses it, with Try again", async () => {
    const notify = vi.fn<(message: SnackbarMessage) => void>();
    const shown = mount(createElement(SubtitleSettingsSection, { notify }));

    scenario.sizeWritable = false;
    await press(shown, "Text size");
    await press(shown, "Large");
    expect(shown.textContent).toContain("Medium");
    expect(notify.mock.lastCall?.[0].text).toBe(
      "Couldn't save the text size. This phone refused it.",
    );

    scenario.sizeWritable = true;
    act(() => notify.mock.lastCall?.[0].action?.run());
    expect(shown.textContent).toContain("Large");
  });
});

it("keeps Online open when retained data finishes restoring", async () => {
  scenario.key = "fixture";
  const shown = await watch(episode, { tracks: tracks("nl") });
  await press(shown, "Subtitles");
  await press(shown, "Find online, SubDL");
  await vi.waitFor(() => expect(shown.textContent).toContain("Estuary.Line.S01E03.1080p.WEB-DL"));
  scenario.retained = kept();
  await act(async () => {
    await player.subtitles!.retry();
  });
  expect(shown.textContent).toContain("Estuary.Line.S01E03.1080p.WEB-DL");
  expect(shown.textContent).toContain("Online subtitles");
});

it("shows hearing impaired on the downloaded row", async () => {
  const saved = kept();
  scenario.retained = { ...saved, subtitle: { ...saved.subtitle, hearingImpaired: true } };
  const shown = await watch(episode, { tracks: tracks("nl") });
  await press(shown, "Subtitles");
  expect(labels(shown)).toContain(
    "English, Hearing impaired · Estuary.Line.S01E03.720p.HDTV.x264, Downloaded",
  );
});

it("keeps the current sheet when an old Online download finishes", async () => {
  scenario.key = "fixture";
  scenario.retained = kept();
  const shown = await watch(episode, { tracks: tracks("downloaded") });
  await press(shown, "Subtitles");
  await press(shown, "Find online, SubDL");
  await vi.waitFor(() => expect(shown.textContent).toContain("Estuary.Line.S01E03.1080p.WEB-DL"));
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = labels(shown).find((label) => label?.includes("1080p.WEB-DL"))!;
  await press(shown, result);
  // Back closes Online; another Subtitles sheet belongs to a new viewer action.
  await press(shown, "Close Online subtitles");
  await press(shown, "Subtitles");
  await act(async () => {
    finish(new Response("1\n00:00:01,000 --> 00:00:02,000\nHello\n"));
  });
  await vi.waitFor(() => expect(player.subtitles!.state.get().phase).toBe("idle"));
  expect(shown.textContent).toContain("Find online");
});

it("does not tick a text size whose read failed", async () => {
  const { subtitleTextSizeError } = await import("../src/subtitles/runtime.ts");
  act(() => subtitleTextSizeError.set(true));
  const shown = mount(createElement(SubtitleSettingsSection));
  await press(shown, "Text size");
  expect(shown.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  act(() => subtitleTextSizeError.set(false));
});

it("translates an untyped result's format in Dutch and keeps catalogue apostrophes consistent", async () => {
  const { setLanguage } = await import("@mrstreamer/core/i18n");
  const { SubtitleSheetContent } = await import("../src/subtitles/sheets.tsx");
  const { t } = await import("../src/subtitles/copy.ts");
  await act(async () => player.state.set(playing(episode)));
  player.subtitles!.state.set((previous) => ({
    ...previous,
    results: [
      { id: "text", language: "en", release: "Fixture", format: "Text", hearingImpaired: false },
    ],
  }));
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });

  try {
    const shown = mount(
      createElement(SubtitleSheetContent, {
        open: "online",
        now: playing(episode),
        model: player.subtitles!,
        onOpen() {},
        onClose() {},
      }),
    );

    expect(shown.textContent).toContain("Tekst");
    expect(t("The previous choice is kept. Try again.")).toBe(
      "De vorige keuze blijft behouden. Probeer het opnieuw.",
    );
  } finally {
    setLanguage({ locale: "en-US", formats: "en-US" });
  }

  expect(t("Couldn't keep the subtitle choice")).toBe("Couldn't keep the subtitle choice");
});
