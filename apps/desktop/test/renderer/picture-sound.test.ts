// @vitest-environment happy-dom
// The Picture and sound menu: what the viewer steps and picks plays and is saved, within the
// contract's limits; Reset goes back to the stream's own; a failed save says so and Retry saves
// it; while a receiver plays, the menu says it plays the stream as sent and offers no choices.
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  defaultPreferences,
  type PlaybackAdjustments,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import { PictureSoundMenu } from "../../src/renderer/src/features/watch/PictureSound.tsx";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { attachSound, flushSound } from "../../src/renderer/src/player/sound.ts";
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

  return client;
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
  expect(named("Sound later").getAttribute("aria-disabled")).toBe("true");
  expect(named("Zoom In").getAttribute("aria-disabled")).toBe("true");

  await press(radio("Leveling", "On"));

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
  expect(button("Reset").getAttribute("aria-disabled")).toBe("true");
  expect(named("Sound sooner").getAttribute("aria-disabled")).toBe("true");
  expect(named("Zoom Out").getAttribute("aria-disabled")).toBe("true");
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

it("does not retry a failed choice into another viewing profile", async () => {
  await menu(DEFAULT_PLAYBACK_ADJUSTMENTS);
  const refused = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  await act(async () => refused.reject({ kind: "unexpected", detail: "disk full" }));
  expect(button("Retry")).toBeDefined();
  await act(async () => {
    selectProfileOwner({ id: "other", revision: 2 });
    hydratePlaybackAdjustments({
      ...defaultPreferences,
      playbackAdjustments: { ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 200 },
    });
  });
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().textContent).toContain("200%");
  selectProfileOwner(null);
});

it("accepts a failed write that readback confirms landed", async () => {
  await menu(DEFAULT_PLAYBACK_ADJUSTMENTS);
  ipc.answer("preferences.get", () =>
    ipc.snapshot({
      ...defaultPreferences,
      playbackAdjustments: { ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 125 },
    }),
  );
  const refused = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  await act(async () => refused.reject({ kind: "unexpected", detail: "reply failed" }));
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().textContent).toContain("125%");
});

it("keeps focus at a step limit and moves vertically by row", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 275 });
  const plus = named("Zoom In");
  plus.focus();
  await press(plus);
  expect(plus.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(plus);
  expect(plus.closest('[role="group"]')?.getAttribute("tabindex")).toBe("-1");
  const sooner = named("Sound sooner");
  sooner.focus();
  await act(async () =>
    sooner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Off");
});

it("keeps the playing choice when a save and its readback fail without a cache", async () => {
  const client = await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 200 });
  client.clear();
  const read = ipc.hold("preferences.get");
  const write = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  await act(async () => {
    write.reject({ kind: "unexpected", detail: "disk full" });
    await Promise.resolve();
    read.reject({ kind: "unexpected", detail: "read failed" });
  });
  expect(dialog().textContent).toContain("200%");
  expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
});

it("hydrates the new profile while an old profile save is pending", async () => {
  await menu(DEFAULT_PLAYBACK_ADJUSTMENTS);
  const write = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  await act(async () => {
    selectProfileOwner({ id: "other", revision: 3 });
    hydratePlaybackAdjustments({
      ...defaultPreferences,
      playbackAdjustments: { ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 200 },
    });
    write.reject({ kind: "unexpected", detail: "old reply" });
  });
  expect(dialog().textContent).toContain("200%");
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  selectProfileOwner(null);
});

const resumeAudio = vi.fn<() => Promise<void>>();

/** Browser audio boundary: only resume completion is controlled, never the sound module. */
function soundDevice() {
  const resume = resumeAudio.mockReset().mockResolvedValue();

  const node = () => ({
    connect: () => {},
    disconnect: () => {},
    delayTime: { value: 0, setTargetAtTime: () => {} },
  });

  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      currentTime = 0;
      destination = { channelCount: 2, maxChannelCount: 2 };
      resume = resume;
      createGain = node;
      createDelay = node;
      createMediaElementSource = node;
    },
  );
  const element = document.createElement("video");
  const detach = attachSound(element);
  const previousCleanup = cleanup;
  cleanup = () => {
    detach();
    previousCleanup();
    vi.unstubAllGlobals();
  };

  return { resume, element, detach };
}

it("ignores a rollback resume failure after another profile hydrates", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
  const { resume } = soundDevice();
  await act(async () => {});
  const write = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  const rollback = Promise.withResolvers<void>();
  resume.mockReturnValueOnce(rollback.promise);
  await act(async () => write.reject({ kind: "unexpected", detail: "disk full" }));
  await act(async () => {
    selectProfileOwner({ id: "other", revision: 4 });
    hydratePlaybackAdjustments({
      ...defaultPreferences,
      playbackAdjustments: { ...DEFAULT_PLAYBACK_ADJUSTMENTS, zoom: 200 },
    });
    rollback.reject(new Error("old rollback failed"));
  });
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().textContent).toContain("200%");
  expect(saves()).toHaveLength(1);
  selectProfileOwner(null);
});

it("ignores a rollback failure superseded by a newer choice", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
  const { resume } = soundDevice();
  await act(async () => {});
  const write = ipc.hold("preferences.update");
  await press(named("Zoom In"));
  const rollback = Promise.withResolvers<void>();
  resume.mockReturnValueOnce(rollback.promise);
  await act(async () => write.reject({ kind: "unexpected", detail: "disk full" }));
  await press(named("Zoom In"));
  await act(async () => rollback.reject(new Error("old rollback failed")));
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(dialog().textContent).toContain("125%");
});

it("clears a lifecycle sound failure when playback resumes successfully", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
  const { resume, element } = soundDevice();
  await act(async () => {});
  resume.mockRejectedValueOnce(new Error("device asleep"));
  await act(async () => element.dispatchEvent(new Event("playing")));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("device asleep");
  await act(async () => element.dispatchEvent(new Event("playing")));
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
});

it.each(["detached", "track-switch"])(
  "ignores a %s source's late lifecycle failure",
  async (change) => {
    await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
    const { resume, element, detach } = soundDevice();
    await act(async () => {});
    const waking = Promise.withResolvers<void>();
    resume.mockReturnValueOnce(waking.promise);
    await act(async () => element.dispatchEvent(new Event("playing")));

    if (change === "detached") detach();
    else flushSound(element);
    await act(async () => waking.reject(new Error("obsolete source")));
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  },
);

it("ignores a lifecycle completion after the profile switches, before hydration", async () => {
  await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
  const { resume, element } = soundDevice();
  await act(async () => {});
  const waking = Promise.withResolvers<void>();
  resume.mockReturnValueOnce(waking.promise);
  await act(async () => element.dispatchEvent(new Event("playing")));
  selectProfileOwner({ id: "other", revision: 5 });
  await act(async () => waking.reject(new Error("old profile sound")));
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  selectProfileOwner(null);
});

it.each(["rollback", "playback"])(
  "keeps a failed save retryable after %s sound recovers",
  async (failure) => {
    await menu({ ...DEFAULT_PLAYBACK_ADJUSTMENTS, soundDelayMs: 50 });
    const { resume, element } = soundDevice();
    await act(async () => {});
    const write = ipc.hold("preferences.update");
    await press(named("Zoom In"));

    if (failure === "rollback") resume.mockRejectedValueOnce(new Error("device asleep"));
    await act(async () => write.reject({ kind: "unexpected", detail: "disk full" }));

    if (failure === "playback") resume.mockRejectedValueOnce(new Error("device asleep"));
    await act(async () => element.dispatchEvent(new Event("playing")));
    await act(async () => element.dispatchEvent(new Event("playing")));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("disk full");
    await press(button("Retry"));
    expect(saves().at(-1)?.zoom).toBe(125);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  },
);
