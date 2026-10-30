// @vitest-environment happy-dom
// Record's At a time in the hour the clocks repeat: a typed time still to come in that hour is
// the stop, not the one an hour ago or the next day's.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterAll, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { RecordButton } from "../../src/renderer/src/features/recordings/RecordButton.tsx";

// Amsterdam on 25 October 2026 at the second 02:15, 01:15 UTC: at 03:00 summer time the clocks
// went back to 02:00.
const zone = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = "Europe/Amsterdam";
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse("2026-10-25T01:15:00Z"));
  return was;
});
// The worker's next test files keep its own zone.
afterAll(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

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

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

/** The stop Start asks for after `typed` is entered in At a time. */
async function stopFor(typed: string): Promise<number | undefined> {
  ipc.reset();
  ipc.always("recordings.start", { kind: "busy", connections: { limit: 1, uses: ["watch"] } });
  const view = queryView(new QueryClient());
  await view.render(createElement(RecordButton, { channel, programme: null }));
  await act(async () => button("Record")?.click());
  await act(async () => document.querySelector<HTMLElement>("[data-choice=at]")?.click());
  const input = document.querySelector<HTMLInputElement>("input[type=time]")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, typed);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Start recording")?.click());
  await vi.waitFor(() => expect(ipc.argsOf("recordings.start")).toHaveLength(1));
  view.unmount();
  return ipc.argsOf("recordings.start")[0]?.stop;
}

it("stops at a time still to come in the hour the clocks repeat", async () => {
  expect(await stopFor("02:30")).toBe(Date.parse("2026-10-25T01:30:00Z"));
});

it("stops at a time still to come in the half hour Lord Howe Island repeats", async () => {
  // At 02:00 summer time on 5 April 2026 the clocks there go back half an hour: this is the
  // second 01:35, 15:05 UTC the day before.
  process.env.TZ = "Australia/Lord_Howe";
  vi.setSystemTime(Date.parse("2026-04-04T15:05:00Z"));
  expect(await stopFor("01:45")).toBe(Date.parse("2026-04-04T15:15:00Z"));
});
