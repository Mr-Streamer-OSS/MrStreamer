// @vitest-environment happy-dom
// The Picture and sound menu: what the viewer steps and picks plays and is saved, within the
// contract's limits; Reset goes back to the stream's own; a failed save says so and Retry saves
// it; while a receiver plays, the menu says it plays the stream as sent and offers no choices.
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  defaultPreferences,
  type PlaybackAdjustments,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import { PictureSoundMenu } from "../../src/renderer/src/features/watch/PictureSound.tsx";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { hydratePlaybackAdjustments } from "../../src/renderer/src/player/adjustments.ts";
import { queryView } from "./mount.ts";

const local = {
  offers: [],
  airplayRoutes: false,
  receivers: [],
  scanning: false,
  output: { kind: "local" as const },
};

let cleanup = () => {};

beforeEach(() => ipc.reset());

afterEach(() => {
  cleanup();
  ipc.emit("output.changed", local);
});

/** Opens the menu over `saved` adjustments; saves answer with what they ask for. */
async function menu(saved: PlaybackAdjustments) {
  let current: Preferences = { ...defaultPreferences, playbackAdjustments: saved };
  ipc.answer("preferences.update", (change) => ipc.snapshot((current = { ...current, ...change })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncPreferences(client, hydratePlaybackAdjustments);
  acceptPreferences(client, ipc.snapshot(current));
  const mounted = queryView(client);
  await mounted.render(createElement(PictureSoundMenu, { open: true, onOpenChange: () => {} }));
  cleanup = () => {
    stop();
    mounted.unmount();
  };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

const named = (label: string) =>
  dialog().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

const radio = (group: string, label: string) =>
  dialog().querySelector<HTMLButtonElement>(
    `[role="radiogroup"][aria-label="${group}"] [aria-label="${label}"]`,
  )!;

const button = (text: string) =>
  [...dialog().querySelectorAll("button")].find((each) => each.textContent === text)!;

const press = (element: HTMLElement) => act(async () => element.click());

const saves = () => ipc.argsOf("preferences.update").map((each) => each.playbackAdjustments);

it("plays and saves what is stepped and picked, up to the limits, and resets", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 1950, zoom: 275 });
  expect(dialog().getAttribute("aria-label")).toBe("Picture and sound");
  expect(dialog().textContent).toContain("1,950 ms");
  expect(dialog().textContent).toContain("Sound can only play after the picture.");

  await press(named("Sound later"));
  await press(named("Zoom In"));
  expect(dialog().textContent).toContain("2,000 ms");
  expect(named("Sound later").disabled).toBe(true);
  expect(named("Zoom In").disabled).toBe(true);

  await press(radio("Leveling", "On"));
  expect(dialog().textContent).toContain("Leveling plays in stereo.");
  await press(radio("Crop", "4:3"));
  expect(radio("Crop", "4:3").getAttribute("aria-checked")).toBe("true");
  expect(radio("Aspect", "Automatic").getAttribute("aria-checked")).toBe("true");
  expect(saves().at(-1)).toEqual({
    soundDelayMs: 2000,
    leveling: true,
    aspect: "source",
    crop: "4:3",
    zoom: 300,
  });

  await press(button("Reset"));
  expect(saves().at(-1)).toEqual(DEFAULT_PLAYBACK_ADJUSTMENTS);
  expect(button("Reset").disabled).toBe(true);
  expect(named("Sound sooner").disabled).toBe(true);
  expect(named("Zoom Out").disabled).toBe(true);
});

it("says a choice wasn't saved, plays the saved one and saves it on Retry", async () => {
  await menu(DEFAULT_PLAYBACK_ADJUSTMENTS);
  const refused = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  await act(async () => refused.reject({ kind: "unexpected", detail: "disk full" }));
  expect(saves()).toEqual([{ ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 125 }]);
  expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(
    /Couldn't save\. Nothing changed\..*disk full/,
  );
  expect(dialog().textContent).toContain("100%");

  await press(button("Retry"));
  expect(saves().at(-1)).toEqual({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 125 });
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().textContent).toContain("125%");
});

it("offers no choices while a receiver plays the stream as sent", async () => {
  await menu(DEFAULT_PLAYBACK_ADJUSTMENTS);
  const receiver = { id: "tv", kind: "cast" as const, name: "Living Room TV" };
  await act(async () =>
    ipc.emit("output.changed", {
      ...local,
      offers: ["cast" as const],
      receivers: [receiver],
      output: { kind: "receiver", receiver, volume: null, media: null, failure: null },
    }),
  );
  expect(dialog().textContent).toBe(
    "Living Room TV plays the stream as sentPicture and sound settings apply on this computer only.",
  );
  expect(dialog().querySelector("button")).toBeNull();
});
