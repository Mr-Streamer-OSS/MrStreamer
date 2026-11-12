// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  defaultPreferences,
  type PlaybackAdjustments,
} from "@mrstreamer/contracts/preferences";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import {
  adjustPlayback,
  hydratePlaybackAdjustments,
  type AdjustmentsState,
  resetPlayback,
  retryPlayback,
  usePlaybackAdjustments,
} from "../../src/renderer/src/player/adjustments.ts";
import { pictureBox } from "../../src/renderer/src/player/picture-fit.ts";
import { queryView } from "./mount.ts";
import { act, createElement } from "react";

let cleanup = () => {};

beforeEach(() => ipc.reset());

afterEach(() => cleanup());

const SAVED: PlaybackAdjustments = { ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 150 };

/** The adjustments as a view reads them, through the hook a view uses. */
async function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncPreferences(client, hydratePlaybackAdjustments);
  acceptPreferences(client, ipc.snapshot({ ...defaultPreferences, playbackAdjustments: SAVED }));
  const mounted = queryView(client);
  let read: AdjustmentsState | null = null;

  function Probe() {
    read = usePlaybackAdjustments((state) => state);

    return null;
  }

  await mounted.render(createElement(Probe));
  cleanup = () => {
    stop();
    mounted.unmount();
  };

  return { client, state: () => read };
}

it("keeps the saved adjustments when a change can't be saved, says why and saves it on retry", async () => {
  const { client, state } = await view();
  const refused = ipc.hold("preferences.update");
  let asked = Promise.resolve();
  await act(async () => {
    asked = adjustPlayback({ leveling: true, zoom: 150 }, client);
  });
  expect(state()).toMatchObject({
    adjustments: { ...SAVED, leveling: true, zoom: 150 },
    saving: true,
  });
  await act(async () => {
    refused.reject({ kind: "unexpected", detail: "disk full" });
    await asked;
  });
  expect(ipc.argsOf("preferences.update")).toEqual([
    { playbackAdjustments: { ...SAVED, leveling: true, zoom: 150 } },
  ]);
  const intended = { ...SAVED, leveling: true, zoom: 150 };
  expect(state()).toMatchObject({
    adjustments: SAVED,
    saving: false,
    failed: { adjustments: intended, message: expect.stringContaining("disk full") },
  });

  const accepted = ipc.hold("preferences.update");
  await act(async () => {
    const retried = retryPlayback(client);
    accepted.resolve(ipc.snapshot({ ...defaultPreferences, playbackAdjustments: intended }));
    await retried;
  });
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ playbackAdjustments: intended });
  expect(state()).toMatchObject({ adjustments: intended, failed: null, saving: false });
});

it("resets to the stream's own timing, loudness and picture", async () => {
  const { client, state } = await view();
  const saved = ipc.hold("preferences.update");
  await act(async () => {
    const reset = resetPlayback(client);
    saved.resolve(
      ipc.snapshot({ ...defaultPreferences, playbackAdjustments: DEFAULT_PLAYBACK_ADJUSTMENTS }),
    );
    await reset;
  });
  expect(ipc.argsOf("preferences.update")).toEqual([
    { playbackAdjustments: DEFAULT_PLAYBACK_ADJUSTMENTS },
  ]);
  expect(state()).toMatchObject({ adjustments: DEFAULT_PLAYBACK_ADJUSTMENTS });
});

it("places the picture at the viewer's aspect, crop and zoom", () => {
  const wide = { width: 1600, height: 900 };
  const unchanged = { aspect: "source", crop: "none", zoom: 100 } as const;
  // A 4:3 broadcast keeps its shape, with bars at the sides.
  expect(pictureBox({ width: 720, height: 576 }, wide, { ...unchanged, aspect: "4:3" })).toEqual({
    left: 200,
    top: 0,
    width: 1200,
    height: 900,
  });
  // A 16:9 film in a 4:3 frame: cutting to 16:9 fills the window and cuts the frame's bars.
  expect(pictureBox({ width: 640, height: 480 }, wide, { ...unchanged, crop: "16:9" })).toEqual({
    left: 0,
    top: -150,
    width: 1600,
    height: 1200,
  });
  // Zoom enlarges around the centre; the window cuts what leaves it.
  expect(pictureBox({ width: 1920, height: 1080 }, wide, { ...unchanged, zoom: 150 })).toEqual({
    left: -400,
    top: -225,
    width: 2400,
    height: 1350,
  });
  // The stream's own shape waits for its first frame.
  expect(pictureBox({ width: 0, height: 0 }, wide, { ...unchanged, zoom: 150 })).toBeNull();
});
