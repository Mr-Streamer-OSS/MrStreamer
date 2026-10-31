// @vitest-environment happy-dom
// Recordings with no subscription saved: Connect offers them once any is kept, and they stand
// alone as Downloads do, what was recorded only, with nothing scheduled and no Storage, and an
// ended one plays over the page from this computer.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it } from "vitest";
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
    [...window.querySelectorAll("header button")].map((each) => each.textContent?.trim()),
  ).toEqual(["Recordings", "Add subscription"]);
  expect(window.querySelector("section[aria-label=Recorded]")).not.toBeNull();
  expect(window.querySelector("section[aria-label=Scheduled]")).toBeNull();
  expect(window.textContent).not.toContain("Night Sessions");
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

it("offers no Recordings on Connect while none is kept", async () => {
  const window = await app();
  await act(settle);
  expect(button(window, "Recordings")).toBeUndefined();
});
