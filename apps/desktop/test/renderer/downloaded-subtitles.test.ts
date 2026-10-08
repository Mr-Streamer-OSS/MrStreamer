// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const saved: SavedSubtitle = {
  timing: { offset: 2, speed: 25 / 24 },
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Cinema cut",
    cues: [
      { start: 96, end: 100, text: "Welcome." },
      { start: 10, end: 20, text: "Before." },
    ],
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};
function shown() {
  return subtitleLayer.querySelector("[data-subtitle-text]")?.textContent ?? "";
}
function at(position: number) {
  player.element.currentTime = position;
  player.element.dispatchEvent(new Event("seeked"));
}
async function open() {
  ipc.reset();
  const restore = ipc.hold("subtitles.saved");
  const pictureCalls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    pictureCalls.push(input);
    return new Response(new ReadableStream());
  });
  ipc.always("playback.openTitle", {
    sessionId: "local-movie",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
    url: "http://127.0.0.1/title/local-movie.mp4",
    duration: 600,
    audio: [],
    subtitles: [english],
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
  return { pictureCalls, restore };
}
afterEach(() => {
  titlePlayer.close();
  vi.unstubAllGlobals();
});
describe("a downloaded subtitle on the movie picture", () => {
  it("starts the picture while local restore waits, then applies drift and offset without another picture request", async () => {
    const { pictureCalls: calls } = await open();
    expect(calls).toHaveLength(1);
    expect(titlePlayer.acceptDownloaded("other-file", saved)).toBe(false);
    expect(titlePlayer.acceptDownloaded("local-movie", saved)).toBe(true);
    at(103);
    expect(shown()).toBe("Welcome.");
    at(100);
    expect(shown()).toBe("");
    at(15);
    expect(shown()).toBe("Before.");
    titlePlayer.setSubtitle(null);
    expect(shown()).toBe("");
    titlePlayer.toggleSubtitles();
    expect(shown()).toBe("Before.");
    expect(calls).toHaveLength(1);
  });
  it("moves the cue from its original clock on every edit, stores edits in order and rejects a closed session", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    ipc.always("subtitles.timing", saved);
    at(100);
    await titlePlayer.setDownloadedTiming({ offset: 0, speed: 1 });
    expect(shown()).toBe("");
    await titlePlayer.setDownloadedTiming({ offset: -1, speed: 1 });
    at(98);
    expect(shown()).toBe("Welcome.");
    await titlePlayer.setDownloadedTiming(saved.timing);
    at(103);
    expect(shown()).toBe("Welcome.");
    expect(ipc.argsOf("subtitles.timing").map((input) => input.timing)).toEqual([
      { offset: 0, speed: 1 },
      { offset: -1, speed: 1 },
      saved.timing,
    ]);
    titlePlayer.close();
    expect(shown()).toBe("");
    expect(titlePlayer.acceptDownloaded("local-movie", saved)).toBe(false);
  });

  it("forgets a downloaded result without changing the global subtitle preference", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    at(103);
    expect(shown()).toBe("Welcome.");
    ipc.always("subtitles.forget", null);
    await titlePlayer.forgetDownloaded();
    expect(shown()).toBe("");
    expect(titlePlayer.state().savedSubtitle).toBeNull();
    expect(titlePlayer.state().downloadedOn).toBe(false);
    expect(ipc.argsOf("preferences.update")).toEqual([]);
  });

  it.each(["Off", "a file track"])(
    "keeps the saved result available when %s is chosen while restore waits",
    async (choice) => {
      const { restore } = await open();
      titlePlayer.setSubtitle(choice === "Off" ? null : english);
      restore.resolve(saved);
      await settle();
      expect(titlePlayer.state().savedSubtitle).toEqual(saved);
      expect(titlePlayer.state().downloadedOn).toBe(false);
      expect(titlePlayer.state().subtitle).toEqual(choice === "Off" ? null : english);
      at(103);
      expect(shown()).toBe("");
      titlePlayer.showDownloaded();
      expect(shown()).toBe("Welcome.");
    },
  );

  it("does not replace a newer downloaded choice with an old restore response", async () => {
    const { restore } = await open();
    const newer = { ...saved, subtitle: { ...saved.subtitle!, release: "New cut" } };
    titlePlayer.acceptDownloaded("local-movie", newer);
    restore.resolve(saved);
    await settle();
    expect(titlePlayer.state().savedSubtitle).toEqual(newer);
    expect(titlePlayer.state().downloadedOn).toBe(true);
  });

  it("reports a failed timing write once and lets the next correction save", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    ipc.refuse("subtitles.timing", { kind: "unexpected", detail: "Timing could not be saved." });
    await expect(titlePlayer.setDownloadedTiming({ offset: 0, speed: 1 })).rejects.toBeDefined();
    await settle();
    await titlePlayer.downloadedEditsSaved();
    ipc.always("subtitles.timing", saved);
    await titlePlayer.setDownloadedTiming({ offset: 1, speed: 1 });
    expect(ipc.argsOf("subtitles.timing").map(({ timing }) => timing.offset)).toEqual([0, 1]);
  });
});
