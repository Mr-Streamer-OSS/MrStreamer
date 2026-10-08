// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import { SubtitlePanel } from "../../src/renderer/src/features/titles/SubtitlePanel.tsx";
import { PlaybackChoices } from "../../src/renderer/src/features/watch/PlaybackMenu.tsx";
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
async function opened() {
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
  ipc.always("playback.openTitle", {
    sessionId: "movie",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
    url: "http://127.0.0.1/title/movie.mp4",
    duration: 600,
    audio: [],
    subtitles: [],
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
  });
});
