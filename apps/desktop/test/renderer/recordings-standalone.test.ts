// @vitest-environment happy-dom
// Recordings with no subscription saved: Connect offers them once any is kept, and they stand
// alone as Downloads do, what was recorded only, with nothing scheduled and no Storage, and an
// ended one plays over the page from this computer.
import { defined } from "@mrstreamer/core/defined";
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Recording, ScheduledRecording } from "@mrstreamer/contracts/recordings";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const channel = { subscriptionId: SUBSCRIPTION, id: "11" };

const recorded: Recording = {
  id: "r1",
  channel,
  channelName: "Estuary Max",
  title: "Weather Watch",
  start: Date.now() - 2 * 60 * 60_000,
  stop: Date.now() - 60 * 60_000,
  ended: Date.now() - 60 * 60_000,
  bytes: 900_000_000,
  status: { kind: "complete" },
};

const schedule: ScheduledRecording = {
  id: "s1",
  plan: {
    kind: "slot",
    channel,
    days: [5],
    at: 23 * 60,
    minutes: 60,
    title: "Night Sessions",
    padding: { before: 2, after: 5 },
  },
  channelName: "Meridian",
  next: { start: Date.now() + 60 * 60_000, stop: Date.now() + 2 * 60 * 60_000 },
  status: { kind: "planned" },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Waits, a little at a time, until the window shows what `ready` looks for. */
async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !ready(); tries++) {
    await act(settle);
  }

  if (!ready()) throw new Error("The window never showed what the test waited for.");
}

const button = (within: HTMLElement, text: string) =>
  [...within.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === text || each.getAttribute("aria-label") === text,
  );

const click = (target: HTMLElement | undefined) =>
  act(async () => {
    target?.click();
    await settle();
  });

let unmount = () => {};

beforeEach(() => {
  ipc.reset();
  ipc.always("output.status", {
    owner: { id: "default", revision: 1 },
    offers: [],
    airplayRoutes: null,
    scanning: false,
    receivers: [],
    output: { kind: "local" },
  });
  useUi.setState(useUi.getInitialState(), true);
  ipc.always("subscription.list", []);
  ipc.always("downloads.list", { items: [], series: {}, bytes: 0, free: null, ended: 0 });
  ipc.always("recordings.schedules", [schedule]);
  ipc.always("recordings.storage", {
    folder: "/home/viewer/Videos",
    used: 900_000_000,
    free: 312_000_000_000,
    keepFree: 5 * 1024 ** 3,
    space: null,
  });
});

afterEach(() => {
  unmount();
  titlePlayer.close();
  player.reset();
});

async function app(): Promise<HTMLElement> {
  const view = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  await view.render(createElement(App));
  unmount = view.unmount;
  await until(() => view.container.querySelector("form") !== null);

  return view.container;
}

it("opens what was recorded from Connect, plays it, and goes back to Add subscription", async () => {
  ipc.always("recordings.list", [recorded]);
  const window = await app();
  await until(() => button(window, "Recordings") !== undefined);
  await click(button(window, "Recordings"));
  await until(() => window.textContent?.includes("Weather Watch") ?? false);
  expect(window.querySelector("form")).toBeNull();
  expect(
    [...window.querySelectorAll("header button")].map(
      (each) => each.getAttribute("aria-label") ?? each.textContent?.trim(),
    ),
  ).toEqual(["Recordings", "Add subscription", "Profiles"]);
  expect(window.querySelector("section[aria-label=Recorded]")).not.toBeNull();
  expect(window.querySelector("section[aria-label=Scheduled]")).toBeNull();
  expect(button(window, "Storage")).toBeUndefined();

  ipc.hold("playback.openCopy");
  await click(button(window, "Play Weather Watch"));
  await until(() => window.querySelector("[data-view=title]") !== null);
  expect(ipc.argsOf("playback.openCopy")).toMatchObject([{ copy: "r1" }]);
  await act(async () => {
    titlePlayer.close();
    useUi.setState({ playingTitle: false });
    await settle();
  });
  await click(button(window, "Add subscription"));
  expect(window.querySelector("form")).not.toBeNull();
});

it("keeps Recordings in Downloads' bar while the list can't be read, to try again from there", async () => {
  ipc.refuse("recordings.list", { kind: "unexpected", detail: "Recordings could not be read." });
  ipc.always("recordings.schedules", []);
  const window = await app();
  await act(async () => {
    useUi.setState({ view: "downloads" });
    await settle();
  });
  await until(() => window.querySelector("header") !== null);
  await click(button(window, "Recordings"));
  await until(() => button(window, "Retry") !== undefined);
});

it.each([
  { name: "watched ended copy", duration: 600, position: 600, from: 0, growing: false },
  {
    name: "growing checkpoint on a longer ended copy",
    duration: 300,
    position: 300,
    from: 295,
    growing: false,
  },
  { name: "still-growing edge checkpoint", duration: 600, position: 600, from: 595, growing: true },
])("opens a $name at $from", async ({ duration, position, from, growing }) => {
  const { playRecording } =
    await import("../../src/renderer/src/features/recordings/recordings.ts");

  ipc.always("playback.openCopy", {
    sessionId: "r-session",
    copy: "r1",
    url: "http://127.0.0.1/title/r.mp4",
    duration: 600,
    audio: [],
    subtitles: [],
    progress: { position, duration },
    ...defined({
      recording: growing
        ? {
            revision: 1,
            final: false,
            duration: 600,
            status: { kind: "recording" as const },
            seekable: [{ from: 0, to: 600 }],
            audioSeekable: [],
            subtitleSeek: false,
            gaps: [],
          }
        : undefined,
    }),
  });
  playRecording(recorded);
  await vi.waitFor(() => expect(titlePlayer.state().subtitleSessionId).toBe("r-session"));
  expect(titlePlayer.state().position).toBe(from);
});

it.each([false, true])("recovers failed places with only active rows, group=%s", async (group) => {
  const { RecordingsPage } =
    await import("../../src/renderer/src/features/recordings/RecordingsPage.tsx");

  const active: Recording = {
    ...recorded,
    ended: null,
    status: { kind: "recording" },
    scheduled: { schedule: "schedule", from: recorded.start, late: null, rule: "rule" },
  };

  ipc.always("recordings.list", [active]);
  ipc.refuse("recordings.resume", { kind: "unexpected", detail: "Unreadable places" });
  const view = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  unmount = view.unmount;
  await view.render(createElement(RecordingsPage));
  await until(() => view.container.textContent?.includes("Weather Watch") ?? false);

  if (group) {
    const shelf = [...view.container.querySelectorAll<HTMLButtonElement>("nav button")].find(
      (each) => each.textContent?.includes("Weather Watch"),
    );

    expect(shelf).toBeDefined();
    await click(shelf);
    expect(shelf?.getAttribute("aria-current")).toBe("page");
  }

  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("couldn't be read");
  ipc.always("recordings.resume", {
    owner: { id: "default", revision: 1 },
    items: [{ recording: active, progress: { position: 120, duration: 300, at: Date.now() } }],
  });
  await click(button(view.container, "Try again"));
  await until(() => !view.container.querySelector('[role="alert"]'));
  expect(ipc.argsOf("recordings.resume").length).toBeGreaterThan(1);
  expect(button(view.container, "Resume Weather Watch")).toBeDefined();
});

it("keeps a final recording's place without claiming an unknown length", async () => {
  const { playRecording, resumes } =
    await import("../../src/renderer/src/features/recordings/recordings.ts");

  ipc.always("playback.openCopy", {
    sessionId: "unknown-final",
    copy: "r1",
    url: "http://127.0.0.1/title/r.mp4",
    duration: null,
    audio: [],
    subtitles: [],
    progress: { position: 120, duration: 300 },
    recording: {
      revision: 2,
      duration: null,
      final: true,
      status: { kind: "complete" },
      seekable: [{ from: 0, to: 300 }],
      audioSeekable: [],
      gaps: [],
      subtitleSeek: false,
    },
  });
  playRecording(recorded);
  await vi.waitFor(() => expect(titlePlayer.state().subtitleSessionId).toBe("unknown-final"));
  titlePlayer.close();
  await vi.waitFor(() =>
    expect(ipc.argsOf("recordings.recordProgress")).toMatchObject([
      { id: "r1", position: 115, duration: 0 },
    ]),
  );
  expect(resumes(recorded, { position: 115, duration: 0, at: Date.now() })).toBe(true);
});
