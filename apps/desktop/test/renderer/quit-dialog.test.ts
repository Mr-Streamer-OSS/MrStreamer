// @vitest-environment happy-dom
// The question Quit asks while a recording's time goes on (`window.leaveAsked`): it names what
// records and the minutes it has, and the next schedule that won't record while the app is
// closed. Keep recording leaves the app running; Quit confirms with `window.quit`.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { Recording, ScheduledRecording } from "@mrstreamer/contracts/recordings";
import { QuitDialog } from "../../src/renderer/src/features/recordings/QuitDialog.tsx";

const channel = { subscriptionId: SUBSCRIPTION, id: "11" };
// Begun 9 minutes ago, a second over so whole minutes come out even.
const start = Date.now() - 9 * 60_000 - 1000;
const recording: Recording = {
  id: "r1",
  channel,
  channelName: "Meridian",
  title: "Studio Sessions",
  start,
  stop: start + 52 * 60_000,
  ended: null,
  bytes: 100_000_000,
  status: { kind: "recording" },
};
const schedule: ScheduledRecording = {
  id: "s1",
  plan: {
    kind: "slot",
    channel,
    days: [5],
    at: 23 * 60 + 30,
    minutes: 60,
    title: "Night Sessions",
    padding: { before: 2, after: 5 },
  },
  channelName: "Meridian",
  next: { start: start + 3 * 60 * 60_000, stop: start + 4 * 60 * 60_000 },
  status: { kind: "planned" },
};

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (text: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent?.trim() === text,
  );

beforeEach(async () => {
  ipc.reset();
  ipc.always("recordings.list", [recording]);
  ipc.always("recordings.schedules", [schedule]);
  ipc.always("window.quit", null);
  const view = queryView(new QueryClient());
  onTestFinished(() => view.unmount());
  await view.render(createElement(QuitDialog));
});

/** Main asks, as after Cmd+Q, Ctrl+Q or the tray's Quit; waits until the dialog says it all. */
async function asked(): Promise<HTMLElement> {
  await act(async () => ipc.emit("window.leaveAsked", null));
  return vi.waitFor(() => {
    const shown = dialog();
    if (!shown?.textContent?.includes("Night Sessions")) throw new Error("Not asked yet");
    return shown;
  });
}

it("names what records and what won't, focusing Keep recording", async () => {
  const shown = await asked();
  expect(shown.textContent).toContain("Quit while recording?");
  expect(shown.textContent).toMatch(
    /Studio Sessions is recording until [^.]+\. Quitting stops it now and keeps the 9 min recorded\./,
  );
  expect(shown.textContent).toContain("Night Sessions, ");
  expect(shown.textContent).toContain("won't record while Mr. Streamer is closed.");
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Keep recording")));
});

it("closes on Keep recording, and quits on Quit", async () => {
  await asked();
  await act(async () => button("Keep recording")?.click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(ipc.argsOf("window.quit")).toHaveLength(0);
  await asked();
  await act(async () => button("Quit")?.click());
  expect(ipc.argsOf("window.quit")).toHaveLength(1);
});
