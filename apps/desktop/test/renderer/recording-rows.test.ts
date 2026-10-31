// @vitest-environment happy-dom
// Recordings' row for a schedule that started late or missed its time: how late it says, the
// hatched minutes and the row's start count from when capture was owed, the time a schedule saved
// partway through its programme was saved, else its padded start. A complete one's bar is full.
// A refused Stop or Delete says why in its row; a Stop taken whose end isn't written down yet says
// that, and that it is retried, until main saves it.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { RecordingsPage } from "../../src/renderer/src/features/recordings/RecordingsPage.tsx";
import { syncRecordings } from "../../src/renderer/src/features/recordings/recordings.ts";

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

// Owed from 12:00 for ten minutes and forty seconds, and begun at 12:02:30.
const late = { schedule: "s1", from: at("12:00"), late: "busy" } as const;
const times = { start: at("12:02") + 30_000, stop: at("12:10") + 40_000 };

it("counts a late recording's minutes in whole minutes from when it was owed", async () => {
  // Cut off at 12:07:50: two missed, five captured, of ten.
  const row = await rowOf(late, {
    ...times,
    ended: at("12:07") + 50_000,
    status: { kind: "partial", cut: "stream" },
  });
  expect(row).toMatchObject({ captured: "5", planned: "10" });
  expect(row.text).toContain("5 of 10 min");
});

it("adds a complete late recording's missed and captured minutes up to those planned", async () => {
  const row = await rowOf(late, { ...times, ended: times.stop });
  expect(row).toMatchObject({ captured: "8", planned: "10" });
});

it("counts the minutes a gap missed out of what was captured, and says when and why", async () => {
  const row = await rowOf(undefined, {
    start: at("12:00"),
    status: { kind: "partial", cut: "stream" },
    gaps: [{ from: at("12:20"), to: at("12:35"), why: "stream" }],
  });
  expect(row.text).toMatch(/12:20\D* to 12:35\D* missed\. The stream stopped\./);
  expect(row).toMatchObject({ captured: "45", planned: "60" });
});

it("keeps a paused recording in Now with Stop, its bar missing the time it waits", async () => {
  ipc.reset();
  // Begun 30 minutes ago, a second over so whole minutes come out even, paused 10 minutes ago.
  const start = Date.now() - 30 * 60_000 - 1000;
  ipc.always("recordings.list", [
    {
      id: "r1",
      channel: { subscriptionId: SUBSCRIPTION, id: "11" },
      channelName: "Eurosport 1",
      title: "Noon News",
      start,
      stop: start + 60 * 60_000,
      ended: null,
      bytes: 188_000,
      status: { kind: "paused", why: "stream" },
      gaps: [{ from: start + 20 * 60_000, to: null, why: "stream" }],
    },
  ]);
  const view = queryView(new QueryClient());
  onTestFinished(() => view.unmount());
  await view.render(createElement(RecordingsPage));
  const row = await vi.waitFor(() => {
    const found = document.querySelector("section[aria-label=Now] li");
    if (!found) throw new Error("No row");
    return found;
  });
  expect(row.textContent).toMatch(/Paused.*Paused at [^.]+\. The stream stopped\. Trying again\./);
  expect(row.querySelector("[aria-label='Stop recording Noon News']")).not.toBeNull();
  const meter = row.querySelector("[role=meter]");
  expect(meter?.getAttribute("aria-valuenow")).toBe("20");
  expect(meter?.getAttribute("aria-valuemax")).toBe("60");
});

it("says a late schedule's recording isn't saved yet, as well as how late it started", async () => {
  const row = await rowOf({ schedule: "s1", from: at("12:00"), late: "busy" }, { unsaved: true });
  expect(row.text).toContain("Started 25 min late. Every connection was in use.");
  expect(row.text).toContain("Not saved yet. Trying again.");
});

/** The page following main's events, first over `list`; its first row in a section, once there. */
async function pageOf(list: Recording[]) {
  ipc.reset();
  ipc.always("recordings.list", list);
  const client = new QueryClient();
  const view = queryView(client);
  onTestFinished(syncRecordings(client));
  onTestFinished(() => view.unmount());
  await view.render(createElement(RecordingsPage));
  return (section: "Now" | "Recorded") =>
    vi.waitFor(() => {
      const found = document.querySelector(`section[aria-label=${section}] li`);
      if (!found) throw new Error(`No row in ${section}`);
      return found;
    });
}

const live: Recording = {
  id: "r1",
  channel: { subscriptionId: SUBSCRIPTION, id: "11" },
  channelName: "Eurosport 1",
  title: "Noon News",
  start: Date.now() - 10 * 60_000,
  stop: Date.now() + 50 * 60_000,
  ended: null,
  bytes: 188_000,
  status: { kind: "recording" },
};
const refused = { kind: "unexpected", detail: "Recordings could not be saved." } as const;

it("says a Stop it couldn't write down yet is stopped and retried, until it is saved", async () => {
  const rowIn = await pageOf([live]);
  const stop = ipc.hold("recordings.stop");
  await act(async () =>
    (await rowIn("Now"))
      .querySelector<HTMLElement>("[aria-label='Stop recording Noon News']")!
      .click(),
  );
  // Main keeps the Stop, lists its end as not saved, then answers that it couldn't save it.
  const stopped = { ...live, ended: Date.now(), status: { kind: "stopped" } } as const;
  await act(async () => ipc.emit("recordings.changed", [{ ...stopped, unsaved: true }]));
  await act(async () => stop.reject(refused));
  await vi.waitFor(async () =>
    expect((await rowIn("Recorded")).textContent).toContain("Not saved yet. Trying again."),
  );
  expect((await rowIn("Recorded")).textContent).not.toContain("could not be saved");
  // Its next check saves it.
  await act(async () => ipc.emit("recordings.changed", [stopped]));
  await vi.waitFor(async () =>
    expect((await rowIn("Recorded")).textContent).not.toContain("Not saved yet"),
  );
  expect((await rowIn("Recorded")).textContent).not.toContain("could not be saved");
});

it("keeps saying why a Stop was refused while the recording goes on", async () => {
  const rowIn = await pageOf([live]);
  ipc.refuse("recordings.stop", refused);
  await act(async () =>
    (await rowIn("Now"))
      .querySelector<HTMLElement>("[aria-label='Stop recording Noon News']")!
      .click(),
  );
  await vi.waitFor(async () =>
    expect((await rowIn("Now")).textContent).toContain("Recordings could not be saved."),
  );
});

it("keeps saying why a Delete was refused", async () => {
  const rowIn = await pageOf([{ ...live, ended: Date.now(), status: { kind: "complete" } }]);
  ipc.refuse("recordings.remove", refused);
  await act(async () =>
    (await rowIn("Recorded"))
      .querySelector<HTMLElement>("[aria-label='More for Noon News']")!
      .click(),
  );
  const remove = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
      (item) => item.textContent === "Delete",
    );
    if (!found) throw new Error("No Delete");
    return found;
  });
  await act(async () => remove.click());
  await vi.waitFor(async () =>
    expect((await rowIn("Recorded")).textContent).toContain("Recordings could not be saved."),
  );
});
