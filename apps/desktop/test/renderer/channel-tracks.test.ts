// @vitest-environment happy-dom
// A channel's sound and subtitle tracks are its own: switching channels, with a click or the
// arrow keys, starts the next one with the viewer's languages rather than the last one's tracks.
// Captions have no language, so picking them leaves the remembered subtitle language as it was.
import { ipc } from "./support.ts";
import { describe, expect, it } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ChannelTracks, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";

const channel = (id: string): LiveChannel => ({
  id,
  name: `NL | ${id}`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
});

const tracksOfA: ChannelTracks = {
  audio: [
    { id: 201, language: "en", label: "English", default: true },
    { id: 202, language: "nl", label: "Nederlands", default: false },
  ],
  subtitles: [
    {
      id: 301,
      page: 888,
      format: "teletext",
      language: "nl",
      label: "Nederlands · Teletext",
      forced: false,
      default: false,
    },
  ],
  playing: 201,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays `id` until its picture moves and its tracks are read. */
async function playing(id: string, tracks: ChannelTracks): Promise<void> {
  const opened = ipc.hold("playback.open");
  const listed = ipc.hold("playback.tracks");
  player.play(channel(id));
  await wait(0);
  opened.resolve({
    sessionId: id,
    channelId: id,
    url: `http://127.0.0.1/stream/${id}`,
    format: "hls",
  });
  await wait(0);
  // The picture moves; the player notices within a second.
  player.element.currentTime += 1;
  await wait(1100);
  listed.resolve(tracks);
  await wait(0);
}

/** What the last stream was opened with. */
const lastOpen = () => ipc.argsOf("playback.open").at(-1);

describe("switching channels", () => {
  it.each([
    ["with the keys", (next: LiveChannel) => player.zap(next)],
    ["with a click", (next: LiveChannel) => player.play(next)],
  ])(
    "%s starts the next channel without the last one's tracks",
    async (_, switchTo) => {
      ipc.reset();
      await playing("a", tracksOfA);
      player.setAudio(202);
      player.setSubtitle(tracksOfA.subtitles[0]!);
      expect(player.state()).toMatchObject({ audioId: 202, subtitle: { id: 301 } });

      switchTo(channel("b"));
      await wait(400);

      expect(lastOpen()).toMatchObject({ channelId: "b" });
      expect(lastOpen()).not.toHaveProperty("audio");
      expect(player.state()).toMatchObject({ audioId: null, subtitle: null, tracks: null });
    },
    10_000,
  );
});

describe("picking subtitles", () => {
  it("remembers a language, Off, and nothing for captions", () => {
    ipc.reset();
    const captions: SubtitleTrack = {
      id: 0x1ff0,
      page: 1,
      format: "captions",
      language: null,
      label: "Captions",
      forced: false,
      default: false,
    };
    player.setSubtitle(tracksOfA.subtitles[0]!);
    player.setSubtitle(captions);
    player.setSubtitle(null);

    expect(ipc.argsOf("preferences.update")).toEqual([
      { subtitleLanguage: "nl" },
      { subtitleLanguage: "off" },
    ]);
  });
});
