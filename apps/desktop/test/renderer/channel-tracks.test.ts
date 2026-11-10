// @vitest-environment happy-dom
// A channel's sound and subtitle tracks are its own: switching channels, with a click or the
// arrow keys, starts the next one with the viewer's languages rather than the last one's tracks.
// Captions have no language, so picking them leaves the remembered subtitle language as it was.
// A channel that stops takes the subtitles on screen with it.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ChannelTracks, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import { player, rememberSubtitles } from "../../src/renderer/src/player/player.ts";
import { addTextCue, subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";

const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: `NL | ${id}`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: `NL | ${id}`, tags: [], quality: null }],
});

const tracksOfA: ChannelTracks = {
  audio: [
    { id: 201, language: "en", label: "English", default: true },
    { id: 202, language: "nl", label: "Nederlands", default: false },
  ],
  subtitles: [
    {
      id: 301,
      page: 1,
      format: "captions",
      language: "nl",
      label: "Nederlands",
      forced: false,
      default: false,
    },
  ],
  playing: 201,
};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
});

afterEach(() => {
  player.reset();
  vi.useRealTimers();
});

/** Plays `id` until its picture moves and its tracks are read. */
async function playing(
  id: string,
  tracks: ChannelTracks,
  choices: NonNullable<LiveChannel["choices"]> = {},
): Promise<void> {
  const opened = ipc.hold("playback.open");
  const listed = ipc.hold("playback.tracks");
  player.play({ ...channel(id), choices });
  await vi.waitFor(() =>
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id },
    }),
  );
  opened.resolve({
    sessionId: id,
    channel: { subscriptionId: SUBSCRIPTION, id: id },
    url: `http://127.0.0.1/stream/${id}`,
    format: "hls",
  });
  await vi.waitFor(() => expect(player.element.src).toBe(`http://127.0.0.1/stream/${id}`));
  // The picture moves; the player notices within a second.
  player.element.currentTime += 1;
  await vi.advanceTimersByTimeAsync(1000);
  expect(ipc.argsOf("playback.tracks").at(-1)).toEqual({ sessionId: id });
  listed.resolve(tracks);
  await vi.waitFor(() => expect(player.state().tracks).toEqual(tracks));
}

/** What the last stream was opened with. */
const lastOpen = () => ipc.argsOf("playback.open").at(-1);

describe("switching channels", () => {
  it.each([
    ["with the keys", (next: LiveChannel) => player.zap(next)],
    ["with a click", (next: LiveChannel) => player.play(next)],
  ])("%s starts the next channel without the last one's tracks", async (_, switchTo) => {
    await playing("a", tracksOfA);
    player.setAudio(202);
    player.setSubtitle(tracksOfA.subtitles[0]!);
    expect(player.state()).toMatchObject({ audioId: 202, subtitle: { id: 301 } });

    switchTo(channel("b"));
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() =>
      expect(lastOpen()).toMatchObject({ channel: { subscriptionId: SUBSCRIPTION, id: "b" } }),
    );

    expect(lastOpen()).toMatchObject({ channel: { subscriptionId: SUBSCRIPTION, id: "b" } });
    expect(lastOpen()).not.toHaveProperty("audio");
    expect(player.state()).toMatchObject({ audioId: null, subtitle: null, tracks: null });
  });
});

describe("stopping a channel", () => {
  it("takes its subtitles off the screen", async () => {
    await playing("a", tracksOfA);
    player.setSubtitle(tracksOfA.subtitles[0]!);
    // The element's own engine passes no caption packets here, so a row goes on the track as the
    // decoder puts one: from the start, with no end yet.
    addTextCue(player.element, 0, Number.MAX_VALUE, "EERSTE RIJ");
    expect(subtitleLayer.textContent).toBe("EERSTE RIJ");

    player.stop();
    expect(subtitleLayer.textContent).toBe("");
  });
});

describe("picking subtitles", () => {
  it("remembers a language, Off, and nothing for captions", () => {
    const captions: SubtitleTrack = {
      id: 0x1ff0,
      page: 1,
      format: "captions",
      language: null,
      label: "Captions",
      forced: false,
      default: false,
    };

    rememberSubtitles(tracksOfA.subtitles[0]!);
    rememberSubtitles(captions);
    rememberSubtitles(null);

    expect(ipc.argsOf("preferences.update")).toEqual([
      { subtitleLanguage: "nl" },
      { subtitleLanguage: "off" },
    ]);
  });
});

describe("remembered channel subtitles", () => {
  it.each(["off", { id: 999, language: "nl", page: 1 }] as const)(
    "applies %j instead of the profile language without saving a new preference",
    async (subtitles) => {
      ipc.prefer({ subtitleLanguage: subtitles === "off" ? "nl" : "off" });
      await playing("a", { ...tracksOfA, audio: [tracksOfA.audio[0]!] }, { subtitles });
      await vi.waitFor(() =>
        expect(player.state().subtitle?.id ?? null).toBe(subtitles === "off" ? null : 301),
      );
      expect(ipc.argsOf("preferences.update")).toEqual([]);
      expect(ipc.argsOf("library.chooseForChannel")).toEqual([]);
    },
  );
});

it("discards a late saved subtitle list when profiles change", async () => {
  const old = { id: "default", revision: 1 };
  selectProfileOwner(old);
  const opened = ipc.hold("playback.open");
  const listed = ipc.hold("playback.tracks");
  player.play({ ...channel("a"), choices: { subtitles: { id: 301, language: "nl", page: 1 } } });
  await vi.waitFor(() => expect(ipc.argsOf("playback.open")).toHaveLength(1));
  opened.resolve({
    sessionId: "a",
    channel: { subscriptionId: SUBSCRIPTION, id: "a" },
    url: "http://127.0.0.1/stream/a",
    format: "hls",
  });
  await vi.waitFor(() => expect(player.element.src).toContain("/stream/a"));
  player.element.currentTime += 1;
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(() => expect(ipc.argsOf("playback.tracks")).toHaveLength(1));
  player.clearForProfile();
  selectProfileOwner({ id: "other", revision: 2 });
  listed.resolve(tracksOfA);
  await vi.advanceTimersByTimeAsync(1000);
  expect(player.state()).toMatchObject({ channel: null, subtitle: null, tracks: null });
  await playing("b", tracksOfA);
  expect(player.state().subtitle).toBeNull();
  expect(ipc.argsOf("preferences.update")).toEqual([]);
});
