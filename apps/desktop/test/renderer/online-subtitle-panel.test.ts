// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { SubtitlePanel } from "../../src/renderer/src/features/titles/SubtitlePanel.tsx";
import {
  PlaybackChoices,
  PlaybackMenu,
} from "../../src/renderer/src/features/watch/PlaybackMenu.tsx";
import { onlineSubtitles } from "../../src/renderer/src/player/online-subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const saved: SavedSubtitle = {
  timing: { offset: 0, speed: 1 },
  selection: "opaque-result",
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Night.Harbour.Cinema",
    cues: [{ start: 1, end: 3, text: "Hello." }],
  },
};
const results = [
  {
    id: "first-result",
    service: "subdl" as const,
    language: "en",
    release: "Night.Harbour.Cinema",
    hearingImpaired: true,
    downloads: 12,
  },
  {
    id: "second-result",
    service: "opensubtitles" as const,
    language: "en",
    release: "Night.Harbour.TV",
    hearingImpaired: false,
    downloads: null,
  },
];
const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) =>
    each.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function opened(tracks: readonly SubtitleTrack[] = []) {
  ipc.reset();
  onlineSubtitles.bind(null);
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream()));
  ipc.always("subtitles.saved", null);
  ipc.always("subtitles.settings", {
    enabled: true,
    service: "both",
    languages: ["en"],
    configured: { subdl: true, opensubtitles: true },
  });
  ipc.always("subtitles.search", { results, failures: [] });
  ipc.always("subtitles.choose", {
    saved,
    quota: { service: "opensubtitles", remaining: 3, resetAt: "tomorrow" },
  });
  ipc.always("subtitles.cancel", null);
  ipc.always("subtitles.show", null);
  ipc.always("subtitles.hide", null);
  ipc.always("playback.openTitle", {
    sessionId: "movie",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
    url: "http://127.0.0.1/title/movie.mp4",
    duration: 600,
    audio: [],
    subtitles: tracks,
  });
  void titlePlayer.open(
    {
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
  await settle();
}
async function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client }, node));
    await settle();
  });
  await act(async () => {
    await settle();
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  onlineSubtitles.bind(null);
  titlePlayer.close();
  vi.unstubAllGlobals();
});
describe("subtitle choices while the picture plays", () => {
  it("does not search on open, shows complete results, keeps the panel after choosing and cancels a pending request on close", async () => {
    await opened();
    const closed = vi.fn();
    await render(createElement(SubtitlePanel, { open: true, onClose: closed }));
    expect(ipc.argsOf("subtitles.search")).toHaveLength(0);
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    expect(container?.textContent).toContain("Hearing impaired");
    expect(container?.textContent).toContain("12 downloads");
    await act(async () => {
      button("Night.Harbour.Cinema").click();
      await settle();
    });
    expect(titlePlayer.state().downloadedOn).toBe(true);
    expect(container?.querySelector("aside")).not.toBeNull();
    expect(container?.textContent).toContain("3 service downloads remain");
    const held = ipc.hold("subtitles.search");
    await act(async () => {
      button("Search again").click();
      await settle();
    });
    expect(container?.textContent).toContain("Searching");
    await act(async () =>
      root!.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SubtitlePanel, { open: false, onClose: closed }),
        ),
      ),
    );
    expect(ipc.argsOf("subtitles.cancel").length).toBeGreaterThan(0);
    held.resolve({ results, failures: [] });
  });
  it("lets typed timing fields own edit keys and offers all six drift presets", async () => {
    await opened();
    titlePlayer.acceptDownloaded("movie", saved);
    await render(
      createElement(PlaybackChoices, {
        speed: { value: 1, onChange: () => {} },
        subtitles: [],
        subtitle: null,
        downloadedTiming: true,
        onOpenChange: () => {},
      }),
    );
    await act(async () => button("Subtitle timing").click());
    const field = container!.querySelector<HTMLInputElement>("#subtitle-offset")!;
    expect(field).not.toBeNull();
    await act(async () => field.focus());
    for (const key of ["Backspace", "ArrowLeft", "ArrowUp", "Home"]) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(field);
      expect(container?.querySelector("#subtitle-offset")).not.toBeNull();
    }
    ipc.always("subtitles.timing", { ...saved, timing: { offset: -2.5, speed: 1 } });
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const text of ["", "-", "-2", "-2.", "-2.5"]) {
      await act(async () => {
        setValue.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field.value).toBe(text);
    }
    await act(async () => field.blur());
    expect(field.value).toBe("-2.5");
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.offset).toBe(-2.5);
    expect(
      [...container!.querySelectorAll("button")].filter((each) =>
        each.textContent?.includes(" fps"),
      ),
    ).toHaveLength(6);

    // A preset stores its exact ratio. The field reads it rounded, and reading it changes nothing.
    const drift = container!.querySelector<HTMLInputElement>("#subtitle-speed")!;
    await act(async () => {
      button("25 → 23.976 fps").click();
      await settle();
    });
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.speed).toBe(25 / 23.976);
    expect(drift.value).toBe("1.04271");
    const writes = ipc.argsOf("subtitles.timing").length;
    await act(async () => drift.focus());
    expect(drift.value).toBe("1.04271");
    await act(async () => drift.blur());
    expect(ipc.argsOf("subtitles.timing")).toHaveLength(writes);
    expect(titlePlayer.state().savedSubtitle?.timing.speed).toBe(25 / 23.976);
    await act(async () => drift.focus());
    for (const text of ["1.0", "1.", "1.04"]) {
      await act(async () => {
        setValue.call(drift, text);
        drift.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(drift.value).toBe(text);
    }
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.speed).toBe(1.04);
  });

  it("opens the timing page from the keyboard on its first offset step, walks its buttons, and leaves drift alone", async () => {
    await opened();
    titlePlayer.acceptDownloaded("movie", saved);
    ipc.always("subtitles.timing", saved);
    await render(
      createElement(PlaybackMenu, {
        speed: { value: 1, onChange: () => {} },
        subtitles: [],
        subtitle: null,
        downloadedTiming: true,
        open: true,
        onOpenChange: () => {},
      }),
    );
    const press = async (key: string) => {
      await act(async () => {
        const target = document.activeElement!;
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        // happy-dom does not perform a button's native Enter activation.
        if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement)
          target.click();
        await settle();
      });
    };
    await act(async () => button("Subtitle timing").focus());
    await press("Enter");
    expect(document.activeElement?.textContent).toBe("-1 s");
    expect(ipc.argsOf("subtitles.timing")).toEqual([]);
    await press("Enter");
    expect(ipc.argsOf("subtitles.timing").map(({ timing }) => timing)).toEqual([
      { offset: -1, speed: 1 },
    ]);
    const walked: string[] = [];
    for (let step = 0; step < 11; step++) {
      await press("ArrowDown");
      walked.push(document.activeElement?.textContent ?? "");
    }
    expect(walked).toEqual([
      "-0.1 s",
      "+0.1 s",
      "+1 s",
      "23.976 → 24 fps",
      "23.976 → 25 fps",
      "24 → 23.976 fps",
      "24 → 25 fps",
      "25 → 23.976 fps",
      "25 → 24 fps",
      "Reset timing",
      "Subtitle timing−1.0 s",
    ]);
    await press("Backspace");
    expect(document.activeElement?.textContent).toContain("Subtitle timing");
    expect(titlePlayer.state().savedSubtitle?.timing).toEqual({ offset: -1, speed: 1 });
  });

  it("names the region of a result's language, and takes a replaced file's saved result away", async () => {
    await opened();
    ipc.always("subtitles.search", {
      results: [
        { ...results[1]!, id: "brazil", language: "pt-BR", release: "Harbour.BR" },
        { ...results[1]!, id: "portugal", language: "pt-PT", release: "Harbour.PT" },
      ],
      failures: [],
    });
    titlePlayer.acceptDownloaded("movie", {
      ...saved,
      subtitle: { ...saved.subtitle!, language: "pt-BR" },
    });
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    expect(button("Harbour.BR").textContent).toContain("Português (Brasil)");
    expect(button("Harbour.PT").textContent).toContain("Português (Portugal)");
    expect(button("Night.Harbour.Cinema").textContent).toContain(
      "Português (Brasil) · Saved for this version",
    );

    await act(async () => {
      ipc.emit("playback.fileReplaced", { sessionId: "movie" });
      await settle();
    });
    expect(container?.textContent).not.toContain("Saved for this version");
    expect(container?.textContent).not.toContain("Harbour.BR");
    expect(button("Search subtitles").disabled).toBe(true);
    expect(button("Off").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["Cancel", "closing the panel"] as const)(
    "tells main what still shows after %s ends a download main may have saved",
    async (how) => {
      await opened();
      titlePlayer.acceptDownloaded("movie", saved);
      const panel = (open: boolean) =>
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(SubtitlePanel, { open, onClose: () => {} }),
        );
      await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
      await act(async () => {
        button("Search subtitles").click();
        await settle();
      });
      const held = ipc.hold("subtitles.choose");
      await act(async () => {
        button("Night.Harbour.TV").click();
        await vi.waitFor(() => expect(ipc.argsOf("subtitles.choose")).toHaveLength(1));
      });
      await act(async () => {
        if (how === "Cancel") button("Cancel").click();
        else root!.render(panel(false));
        await settle();
      });
      await titlePlayer.downloadedEditsSaved();
      const told = ipc.methods().filter((method) => /^subtitles\.(cancel|show|hide)$/.test(method));
      expect(told).toEqual(["subtitles.cancel", "subtitles.show"]);
      expect(ipc.argsOf("subtitles.show")).toEqual([
        { sessionId: "movie", selection: "opaque-result" },
      ]);
      held.resolve({ saved: { ...saved, selection: "late-result" }, quota: null });
      await act(async () => {
        await settle();
      });
      expect(titlePlayer.state().savedSubtitle).toEqual(saved);
    },
  );

  it.each(
    (["Off", "file track", "C off", "C without a track", "saved result"] as const).flatMap(
      (choice) => (["success", "failure"] as const).map((reply) => ({ choice, reply })),
    ),
  )("keeps $choice when a pending download returns $reply", async ({ choice, reply }) => {
    await opened(choice === "C without a track" ? [] : [english]);
    if (choice === "C off" || choice === "saved result")
      titlePlayer.acceptDownloaded("movie", saved);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    const held = ipc.hold("subtitles.choose");
    await act(async () => {
      button("Night.Harbour.TV").click();
      await vi.waitFor(() => expect(ipc.argsOf("subtitles.choose")).toHaveLength(1));
    });
    await act(async () => {
      if (choice === "Off") button("Off").click();
      else if (choice === "file track") button("English").click();
      else if (choice === "saved result") button("Night.Harbour.Cinema").click();
      else titlePlayer.toggleSubtitles();
    });
    await act(async () => {
      if (reply === "success")
        held.resolve({
          saved: { ...saved, subtitle: { ...saved.subtitle!, release: "Late release" } },
          quota: { service: "opensubtitles", remaining: 3, resetAt: null },
        });
      else held.reject({ kind: "unexpected", detail: "The download was cancelled." });
      await settle();
    });
    expect(titlePlayer.state().downloadedOn).toBe(choice === "saved result");
    expect(titlePlayer.state().subtitle).toEqual(choice === "file track" ? english : null);
    expect(titlePlayer.state().savedSubtitle).toEqual(
      choice === "C off" || choice === "saved result" ? saved : null,
    );
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(ipc.argsOf("subtitles.cancel")).toEqual([{ sessionId: "movie" }]);
    // Main may have saved the download before the cancel reached it, so it hears the choice that
    // stands, after the cancel: the held saved result by its key, or that nothing of it shows.
    await titlePlayer.downloadedEditsSaved();
    const told = ipc
      .methods()
      .filter((method) => /^subtitles\.(cancel|show|hide|timing)$/.test(method));
    if (choice === "saved result") {
      ipc.always("subtitles.timing", saved);
      await titlePlayer.setDownloadedTiming({ offset: 1, speed: 25 / 23.976 });
      expect(told).toEqual(["subtitles.cancel", "subtitles.show"]);
      expect(ipc.argsOf("subtitles.show")).toEqual([
        { sessionId: "movie", selection: "opaque-result" },
      ]);
      expect(ipc.argsOf("subtitles.timing")).toEqual([
        {
          sessionId: "movie",
          timing: { offset: 1, speed: 25 / 23.976 },
          selection: "opaque-result",
        },
      ]);
    } else {
      expect(told).toEqual(["subtitles.cancel", "subtitles.hide"]);
      expect(ipc.argsOf("subtitles.hide")).toEqual([{ sessionId: "movie" }]);
    }
    expect(container?.textContent).not.toContain("Downloading");
    expect(container?.textContent).not.toContain("Late release");
    expect(container?.textContent).not.toContain("3 service downloads remain");
    // With nothing saved held yet, Off or a file track is the viewer's language for other titles
    // too. Turning a held saved result off is this file's alone.
    expect(ipc.argsOf("preferences.update")).toEqual(
      choice === "Off"
        ? [{ subtitleLanguage: "off" }]
        : choice === "file track"
          ? [{ subtitleLanguage: "en" }]
          : [],
    );
    expect(ipc.argsOf("output.command")).toEqual([]);
  });
});
