// @vitest-environment happy-dom
// The question Quit asks while a recording's time goes on or downloads would run
// (`window.leaveAsked`): it names what records and the minutes it has, how many downloads stop and
// where, and the next schedule that won't record while the app is closed. It asks once both lists
// are read. The keep button leaves the app running; Quit confirms with `window.quit`.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { Download, DownloadList, DownloadStatus } from "@mrstreamer/contracts/downloads";
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

// Sooner, but held back: it wouldn't record with the app open either.
const held: ScheduledRecording = {
  ...schedule,
  id: "s2",
  plan: { ...schedule.plan, title: "Late Show" },
  next: { start: start + 2 * 60 * 60_000, stop: start + 3 * 60 * 60_000 },
  status: { kind: "changed", title: "Film" },
};

const download = (id: string, status: DownloadStatus): Download => ({
  id,
  title: { kind: "movie", id },
  subscription: { id: SUBSCRIPTION, name: "Home IPTV" },
  name: "Past Lives",
  episodeName: null,
  year: 2023,
  duration: 6360,
  originalLanguage: "ko",
  posterUrl: null,
  wideUrl: null,
  size: 1000,
  status,
  progress: null,
  series: null,
});

const downloads = (...items: Download[]): DownloadList => ({
  items,
  series: {},
  bytes: 0,
  free: null,
  ended: 0,
});

// One transfers at 41%, one waits its turn; a paused one doesn't stop on Quit, so it isn't counted.
const running = downloads(
  download("d1", { kind: "transferring", received: 419, size: 1000, rate: null, restarted: false }),
  download("d2", { kind: "queued" }),
  download("d3", { kind: "paused", received: 80, size: 1000 }),
);

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");

const button = (text: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent?.trim() === text,
  );

beforeEach(() => {
  ipc.reset();
  ipc.always("recordings.list", [recording]);
  ipc.always("recordings.schedules", [held, schedule]);
  ipc.always("downloads.list", downloads());
  ipc.always("window.quit", null);
});

async function mount(): Promise<void> {
  const view = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  onTestFinished(() => view.unmount());
  await view.render(createElement(QuitDialog));
}

/** Main asks, as after Cmd+Q, Ctrl+Q or the tray's Quit; waits until the dialog says it all. */
async function asked(): Promise<HTMLElement> {
  await act(async () => ipc.emit("window.leaveAsked", null));

  return vi.waitFor(() => {
    const shown = dialog();

    if (!shown?.textContent?.includes("Night Sessions")) throw new Error("Not asked yet");

    return shown;
  });
}

/** The keep button's words, which say what goes on: the safe choice, focused first. */
async function focusesKeep(words: string): Promise<void> {
  await vi.waitFor(() => expect(document.activeElement).toBe(button(words)));
}

it("names what records and what won't, focusing Keep recording", async () => {
  await mount();
  const shown = await asked();
  expect(shown.textContent).toContain("Quit while recording?");
  expect(shown.textContent).toMatch(
    /Studio Sessions is recording until [^.]+\. Quitting stops it now and keeps the 9 min recorded\./,
  );
  expect(shown.textContent).toContain("Night Sessions, ");
  expect(shown.textContent).not.toContain("Late Show");
  expect(shown.textContent).toContain("won't record while Mr. Streamer is closed.");
  await focusesKeep("Keep recording");
});

it("closes on Keep recording, and quits on Quit", async () => {
  await mount();
  await asked();
  await act(async () => button("Keep recording")?.click());
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(ipc.argsOf("window.quit")).toHaveLength(0);
  await asked();
  await act(async () => button("Quit")?.click());
  expect(ipc.argsOf("window.quit")).toHaveLength(1);
});

it("asks about downloads alone once their list is read, keeping their partial files", async () => {
  ipc.always("recordings.list", []);
  const read = ipc.hold("downloads.list");
  await mount();
  await act(async () => ipc.emit("window.leaveAsked", null));
  // Not a recording's question first: it waits until it knows what would stop.
  expect(dialog()).toBeNull();
  await act(async () => read.resolve(running));
  const shown = await asked();
  expect(shown.textContent).toContain("Quit while downloading?");
  expect(shown.textContent).not.toContain("is recording");
  expect(shown.textContent).toContain(
    "2 downloads stop, one at 41%. They continue from there when Mr. Streamer opens again.",
  );
  expect(shown.textContent).toContain("Closing the window instead keeps downloading.");
  await focusesKeep("Keep downloading");
});

it("asks about both while recording and downloading", async () => {
  ipc.always("downloads.list", running);
  await mount();
  const shown = await asked();
  expect(shown.textContent).toContain("Quit while recording and downloading?");
  expect(shown.textContent).toMatch(/Studio Sessions is recording until [^.]+\./);
  expect(shown.textContent).toContain("2 downloads stop, one at 41%.");
  expect(shown.textContent).toContain("Closing the window instead keeps both going.");
  await focusesKeep("Keep going");
});

it.each(["downloads.list", "recordings.list"] as const)(
  "keeps a failed %s read retryable without inventing empty counts",
  async (method) => {
    ipc.refuse(method, { kind: "unexpected", detail: "Read refused" });
    await mount();
    await act(async () => ipc.emit("window.leaveAsked", null));
    await vi.waitFor(() =>
      expect(dialog()?.textContent).toContain("Couldn't read background work. Try again."),
    );
    expect(dialog()?.textContent).not.toContain("Quit while recording?");
    expect(button("Quit")).toBeUndefined();
    expect(ipc.argsOf("window.quit")).toHaveLength(0);
    ipc.always(method, method === "downloads.list" ? downloads() : [recording]);
    await act(async () => button("Try again")?.click());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Quit while recording?"));
    await focusesKeep("Keep recording");
  },
);
