// @vitest-environment happy-dom
// Recording, in Live TV's now strip while the channel records: its popover stops that recording in
// place, gives the keys to Record once Recording gives way to it, and says why a refused Stop
// failed. Escape closes it and gives the keys back to Recording.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { RecordButton } from "../../src/renderer/src/features/recordings/RecordButton.tsx";
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

const recording: Recording = {
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

/** The strip's control while `recording` records, its popover opened. */
async function opened() {
  ipc.reset();
  ipc.always("recordings.list", [recording]);
  const client = new QueryClient();
  const stopSync = syncRecordings(client);
  const view = queryView(client);
  onTestFinished(() => {
    stopSync();
    view.unmount();
  });
  await view.render(createElement(RecordButton, { channel, programme: null }));
  const trigger = await vi.waitFor(() => button("Recording") ?? Promise.reject(new Error("none")));
  await act(async () => trigger.click());
  const popup = document.querySelector<HTMLElement>("[role=dialog][aria-label=Recording]");
  expect(popup?.textContent).toContain("Noon News");
  return { trigger, popup: popup! };
}

it("stops the recording in place and gives the keys to Record", async () => {
  await opened();
  await act(async () => button("Stop recording")?.click());
  expect(ipc.argsOf("recordings.stop")).toEqual([{ id: "r1" }]);
  // Main says it stopped: Recording gives way to Record, which takes the keys.
  await act(async () =>
    ipc.emit("recordings.changed", [
      { ...recording, ended: Date.now(), status: { kind: "stopped" } },
    ]),
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
