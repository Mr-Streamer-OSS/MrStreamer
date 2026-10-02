// @vitest-environment happy-dom
// When Automatic plays another of a channel's streams because the first didn't start, Watch says
// so until the channel changes.
import { ipc } from "./support.ts";
import { describe, expect, it } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LivePlaying } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";

const channel = (id: string): LiveChannel => ({
  id,
  name: `NL | ${id} FHD`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  variants: [
    { id, name: `NL | ${id} FHD`, tags: ["FHD"], quality: "fhd" },
    { id: `${id}-hd`, name: `NL | ${id} HD`, tags: ["HD"], quality: "hd" },
  ],
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays `id` until its picture moves and the main process says which stream plays. */
async function playing(id: string, stream: LivePlaying): Promise<void> {
  const opened = ipc.hold("playback.open");
  const asked = ipc.hold("playback.playing");
  player.play(channel(id));
  await wait(0);
  opened.resolve({
    sessionId: id,
    channelId: id,
    url: `http://127.0.0.1/stream/${id}`,
    format: "hls",
  });
  await wait(0);
  player.element.currentTime += 1;
  await wait(1100);
  asked.resolve(stream);
  await wait(0);
}

describe("live quality", () => {
  it("keeps the note of Automatic's fallback until the channel changes", async () => {
    ipc.reset();
    await playing("a", {
      variantId: "a-hd",
      failed: [{ variantId: "a", failure: { kind: "unavailable", status: 404 } }],
    });
    expect(player.state().fellBack).toEqual({ from: "a", to: "a-hd" });

    // Reconnecting tries the stream that failed last, so nothing fails the second time.
    await playing("a", { variantId: "a-hd", failed: [] });
    expect(player.state().fellBack).toEqual({ from: "a", to: "a-hd" });

    await playing("b", { variantId: "b", failed: [] });
    expect(player.state()).toMatchObject({ fellBack: null, stream: { variantId: "b" } });
  }, 10_000);
});
