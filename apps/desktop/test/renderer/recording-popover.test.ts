// @vitest-environment happy-dom
// Recording, in Live TV's now strip while the channel records: its popover stops that recording in
// place, gives the keys to Record once Recording gives way to it, and says why a refused Stop
// failed. Escape closes it and gives the keys back to Recording, even while a stop is under way.
// While what plays here shares the recording's stream, it says the quality stays fixed.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { queryView } from "./mount.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { RecordButton } from "../../src/renderer/src/features/recordings/RecordButton.tsx";
import { player } from "../../src/renderer/src/player/player.ts";
import { syncRecordings } from "../../src/renderer/src/features/recordings/recordings.ts";

const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "11",
  name: "Eurosport 1 HD",
  title: "Eurosport 1",
  tags: [],
  number: 11,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id: "11", name: "Eurosport 1 HD", tags: [], quality: null }],
  catchupDays: null,
};

const noon: Recording = {
  id: "r1",
  channel: { subscriptionId: SUBSCRIPTION, id: "11" },
  channelName: "Eurosport 1",
  title: "Noon News",
  start: Date.now(),
  stop: Date.now() + 60 * 60_000,
  ended: null,
  bytes: 0,
  status: { kind: "recording" },
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === name);

/**
 * The strip's control while `recording` records, its popover opened by pointer while the keys were
 * on Settings, elsewhere in the window, as a click that doesn't take the focus leaves them.
 */
async function opened(recording: Recording = noon) {
  ipc.reset();
  ipc.always("recordings.list", [recording]);
  const client = new QueryClient();
  const stopSync = syncRecordings(client);
  const view = queryView(client);
  onTestFinished(() => {
    stopSync();
    view.unmount();
  });
  await view.render(
    createElement(
      Fragment,
      null,
      createElement("button", { type: "button" }, "Settings"),
      createElement(RecordButton, { channel, programme: null }),
    ),
  );
  const trigger = await vi.waitFor(() => button("Recording") ?? Promise.reject(new Error("none")));
  button("Settings")?.focus();
  await act(async () => trigger.click());
  const popup = document.querySelector<HTMLElement>("[role=dialog][aria-label=Recording]");
  expect(popup?.textContent).toContain(recording.title);

  return { trigger, popup: popup! };
}

it("stops the recording in place and gives the keys to Record", async () => {
  await opened();
  await act(async () => button("Stop recording")?.click());
  expect(ipc.argsOf("recordings.stop")).toEqual([{ id: "r1" }]);
  // Main says it stopped: Recording gives way to Record, which takes the keys.
  await act(async () =>
    ipc.emit("recordings.changed", [{ ...noon, ended: Date.now(), status: { kind: "stopped" } }]),
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Record")));
  expect(button("Recording")).toBeUndefined();
});

it("says why a refused Stop failed, and Escape gives the keys back to Recording", async () => {
  const { trigger, popup } = await opened();
  ipc.refuse("recordings.stop", { kind: "unexpected", detail: "Recordings could not be saved." });
  await act(async () => button("Stop recording")?.click());

  const alert = await vi.waitFor(
    () => popup.querySelector("[role=alert]") ?? Promise.reject(new Error("none")),
  );

  expect(alert.textContent).toContain("Recordings could not be saved.");
  // Still recording: Stop can be tried again.
  expect(button("Stop recording")?.disabled).toBe(false);
  await act(async () => {
    popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(document.querySelector("[aria-label=Recording][role=dialog]")).toBeNull();
});

it("says Tomorrow for a stop past midnight", async () => {
  const stop = new Date();
  stop.setDate(stop.getDate() + 1);
  stop.setHours(3, 0, 0, 0);
  const { popup } = await opened({ ...noon, stop: stop.getTime() });
  expect(popup.textContent).toContain("Tomorrow");
});

it("asks to stop once while its popover reopens before and after the reply", async () => {
  const { trigger, popup } = await opened();
  const held = ipc.hold("recordings.stop");
  await act(async () => button("Stop recording")?.click());
  await act(async () => {
    popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  // Escape gives the keys back to Recording while the stop is under way too.
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  await act(async () => trigger.click());
  expect(button("Stop recording")?.disabled).toBe(true);
  await act(async () => button("Stop recording")?.click());
  expect(ipc.argsOf("recordings.stop")).toEqual([{ id: "r1" }]);
  await act(async () => held.resolve(null));
  // The reply arrived, but the recording-changed event has not replaced the strip's control.
  await act(async () => {
    document
      .querySelector("[role=dialog][aria-label=Recording]")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await act(async () => trigger.click());
  expect(button("Stop recording")?.disabled).toBe(true);
  await act(async () => button("Stop recording")?.click());
  expect(ipc.argsOf("recordings.stop")).toEqual([{ id: "r1" }]);
});

it("says the quality stays fixed only while what plays here shares the recording's stream", async () => {
  const { popup } = await opened();
  const opening = ipc.hold("playback.open");
  player.play(channel);
  onTestFinished(() => player.reset());
  await vi.waitFor(() => expect(ipc.argsOf("playback.open")).toHaveLength(1));
  opening.resolve({
    sessionId: "s1",
    channel: { subscriptionId: SUBSCRIPTION, id: "11" },
    url: "http://127.0.0.1/stream/11",
    format: "hls",
  });
  await vi.waitFor(() => expect(player.element.src).toBe("http://127.0.0.1/stream/11"));
  const note = "Quality stays fixed while this records.";
  expect(popup.textContent).not.toContain(note);
  await act(async () => ipc.emit("playback.fixed", { sessionId: "s1", variant: "720p" }));
  expect(popup.textContent).toContain(note);
  // The recording stopped sharing: the player picks again.
  await act(async () => ipc.emit("playback.fixed", { sessionId: "s1", variant: null }));
  expect(popup.textContent).not.toContain(note);
});
