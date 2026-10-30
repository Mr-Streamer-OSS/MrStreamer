// @vitest-environment happy-dom
// Recordings' row for a schedule that started late or missed its time: how late it says, the
// hatched minutes and the row's start count from when capture was owed, the time a schedule saved
// partway through its programme was saved, else its padded start. A complete one's bar is full.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { queryView } from "./mount.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { RecordingsPage } from "../../src/renderer/src/features/recordings/RecordingsPage.tsx";

/** Today at `time` in this computer's zone. */
const at = (time: string) => new Date(`2026-10-30T${time}:00`).getTime();

/**
 * The noon programme's row, as recorded once a connection was free at 12:25 and saved as
 * `scheduled`; `over` changes it.
 */
async function rowOf(scheduled: Recording["scheduled"], over: Partial<Recording> = {}) {
  ipc.reset();
  ipc.always("recordings.list", [
    {
      id: "r1",
      channel: { subscriptionId: SUBSCRIPTION, id: "11" },
      channelName: "Eurosport 1",
      title: "Noon News",
      start: at("12:25"),
      stop: at("13:00"),
      ...(scheduled && { scheduled }),
      ended: at("13:00"),
      bytes: 188_000,
      status: { kind: "complete" },
      ...over,
    },
  ]);
  const view = queryView(new QueryClient());
  onTestFinished(() => view.unmount());
  await view.render(createElement(RecordingsPage));
  const row = await vi.waitFor(() => {
    const found = document.querySelector("section[aria-label=Recorded] li");
    if (!found) throw new Error("No row");
    return found;
  });
  const meter = row.querySelector("[role=meter]");
  return {
    text: row.textContent ?? "",
    captured: meter?.getAttribute("aria-valuenow"),
    planned: meter?.getAttribute("aria-valuemax"),
  };
}

it("counts a schedule saved partway through its programme late from when it was saved", async () => {
  const row = await rowOf({ schedule: "s1", from: at("12:00"), owed: at("12:20"), late: "busy" });
  expect(row.text).toContain("Started 5 min late. Every connection was in use.");
  expect(row.text).toContain("12:20");
  expect(row).toMatchObject({ captured: "35", planned: "40" });
});

it("counts one saved before its programme late from its padded start", async () => {
  const row = await rowOf({ schedule: "s1", from: at("12:00"), late: "busy" });
  expect(row.text).toContain("Started 25 min late. Every connection was in use.");
  expect(row).toMatchObject({ captured: "35", planned: "60" });
});

it("misses a schedule saved partway through its programme from when it was saved", async () => {
  const row = await rowOf(
    { schedule: "s1", from: at("12:00"), owed: at("12:20"), late: "busy" },
    { start: at("12:00"), ended: null, bytes: 0, status: { kind: "missed", why: "busy" } },
  );
  expect(row.text).toContain("12:20");
  expect(row).toMatchObject({ captured: "0", planned: "40" });
});

it("fills the bar of a complete recording shorter than a minute", async () => {
  const row = await rowOf(undefined, { start: at("12:25"), stop: at("12:25") + 30_000 });
  expect(row).toMatchObject({ captured: "1", planned: "1" });
});
