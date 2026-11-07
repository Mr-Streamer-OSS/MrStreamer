// @vitest-environment happy-dom
// A schedule's controls as they save: a repeat on some days keeps them, and a long programme's
// padding and repeat stay within what a recording may run, so what is saved is a plan main takes.
// And which of the guide's airings a schedule still records, as its cells and details mark them.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { queryView } from "./mount.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import type { GuideSearchPage, ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { ScheduledRecording } from "@mrstreamer/contracts/recordings";
import {
  RulePanel,
  SchedulePanel,
} from "../../src/renderer/src/features/recordings/SchedulePanel.tsx";
import {
  basisOfProgramme,
  basisOfSchedule,
  recordsAt,
  type ScheduleBasis,
} from "../../src/renderer/src/features/recordings/schedules.ts";

const channel = { subscriptionId: SUBSCRIPTION, id: "11" };
const HOUR = 60 * 60_000;
const NOON = new Date(2026, 9, 30, 12).getTime();

/**
 * The plan the panel on `basis` saves once `change` was made in it, main previewing each plan as
 * planned.
 */
async function saved(
  basis: ScheduleBasis,
  schedule?: ScheduledRecording,
  change: () => Promise<void> = async () => {},
) {
  ipc.reset();
  ipc.answer("recordings.plan", ({ plan }) => ({
    id: "",
    plan,
    channelName: "Eurosport 1",
    next: { start: NOON, stop: NOON + HOUR },
    status: { kind: "planned" },
  }));
  ipc.answer("recordings.schedule", ({ plan, id }) => ({
    id: id ?? "s1",
    plan,
    channelName: "Eurosport 1",
    next: { start: NOON, stop: NOON + HOUR },
    status: { kind: "planned" },
  }));
  const view = queryView(new QueryClient());
  onTestFinished(() => view.unmount());
  await view.render(
    createElement(SchedulePanel, { basis, channelName: "Eurosport 1", schedule, onDone: () => {} }),
  );
  await change();

  const save = () =>
    [...document.querySelectorAll("button")].find((each) =>
      ["Save", "Schedule"].includes(each.textContent?.trim() ?? ""),
    );

  await vi.waitFor(() => expect(save()?.disabled).toBe(false));
  expect(document.querySelector("[role=alert]")).toBeNull();
  await act(async () => save()?.click());
  await vi.waitFor(() => expect(ipc.argsOf("recordings.schedule")).toHaveLength(1));

  return ipc.argsOf("recordings.schedule")[0]!.plan;
}

/** Presses `key` on the spin button named `label`. */
const press = (label: string, key: string) =>
  act(async () => {
    document
      .querySelector(`[role=spinbutton][aria-label=${label}]`)
      ?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

it("keeps a repeat's days as it saves", async () => {
  const schedule: ScheduledRecording = {
    id: "s1",
    plan: {
      kind: "slot",
      channel,
      days: [1, 3, 5],
      at: 18 * 60,
      minutes: 30,
      title: "Evening",
      padding: { before: 2, after: 5 },
    },
    channelName: "Eurosport 1",
    next: { start: NOON, stop: NOON + HOUR },
    status: { kind: "planned" },
  };

  const plan = await saved(basisOfSchedule(schedule), schedule, async () => {
    const chosen = document.querySelector("[role=radio][aria-checked=true]");
    expect(chosen?.textContent).toBe("Mondays, Wednesdays, and Fridays");
  });

  expect(plan).toMatchObject({ kind: "slot", days: [1, 3, 5] });
});

it("pads a long programme only as far as a recording may run", async () => {
  // Eleven hours fifty: ten minutes are left, five of them the end's as it opens, and End takes
  // all ten once the start has none.
  const programme = { start: NOON, stop: NOON + 11 * HOUR + 50 * 60_000, title: "Marathon" };

  const plan = await saved(basisOfProgramme(channel, programme), undefined, async () => {
    expect(
      document.querySelector("[role=spinbutton][aria-label=Start]")?.getAttribute("aria-valuemax"),
    ).toBe("5");
    await press("Start", "Home");
    await press("End", "End");
  });

  expect(plan).toMatchObject({ kind: "programme", padding: { before: 0, after: 10 } });
});

it("opens a programme with little room left padded as far as it may run", async () => {
  const programme = { start: NOON, stop: NOON + 11 * HOUR + 57 * 60_000, title: "Marathon" };
  expect(await saved(basisOfProgramme(channel, programme))).toMatchObject({
    padding: { before: 0, after: 3 },
  });
});

it("repeats a programme longer than a recording may run for as long as one may", async () => {
  const programme = { start: NOON, stop: NOON + 13 * HOUR, title: "All Day" };

  const plan = await saved(basisOfProgramme(channel, programme), undefined, async () => {
    await press("Start", "Home");
    await press("End", "Home");
    await act(async () => document.querySelector<HTMLElement>("[data-repeat=day]")?.click());
  });

  expect(plan).toMatchObject({ kind: "slot", minutes: 12 * 60, padding: { before: 0, after: 0 } });
});

it("records a programme longer than a recording may run once for as long as one may", async () => {
  const programme = { start: NOON, stop: NOON + 13 * HOUR, title: "All Day" };

  const plan = await saved(basisOfProgramme(channel, programme), undefined, async () => {
    await press("Start", "Home");
    await press("End", "Home");
  });

  expect(plan).toMatchObject({ kind: "programme", start: NOON, stop: NOON + 12 * HOUR });
});

it("marks the airings a schedule still records, not one it recorded, stopped or let go", () => {
  const DAY = 24 * HOUR;

  const repeat = (next: ScheduledRecording["next"]): ScheduledRecording => ({
    id: "s1",
    plan: {
      kind: "slot",
      channel,
      days: [0, 1, 2, 3, 4, 5, 6],
      at: 12 * 60,
      minutes: 60,
      title: "Noon News",
      padding: { before: 2, after: 5 },
    },
    channelName: "Eurosport 1",
    next,
    status: { kind: "planned" },
  });

  const padded = (start: number) => ({
    start: start - 2 * 60_000,
    stop: start + HOUR + 5 * 60_000,
  });

  // Today's on now or to come, and every one after it.
  expect(recordsAt(repeat(padded(NOON)), NOON)).toBe(true);
  expect(recordsAt(repeat(padded(NOON)), NOON + DAY)).toBe(true);
  // Today's stopped: tomorrow's is next, and today's is no longer marked.
  expect(recordsAt(repeat(padded(NOON + DAY)), NOON)).toBe(false);
  expect(recordsAt(repeat(padded(NOON + DAY)), NOON + DAY)).toBe(true);
  // With no time to come, as a programme stopped partway, and held by the guide, none.
  expect(recordsAt(repeat(null), NOON)).toBe(false);
  expect(recordsAt({ ...repeat(padded(NOON)), status: { kind: "gone" } }, NOON)).toBe(false);
});

/** A guide result from the public IPC boundary, including fuzzy titles the search can return. */
function discoveryMatch(
  id: string,
  title = "Noon News",
  subscriptionId = SUBSCRIPTION,
): ProgrammeMatch {
  return {
    channel: {
      subscriptionId,
      id,
      title: `Channel ${id}`,
      name: `Channel ${id}`,
      tags: [],
      number: null,
      logoUrl: null,
      categoryIds: [],
      catchupDays: null,
      variants: [],
    },
    programme: { title, start: NOON, stop: NOON + HOUR, description: null },
  };
}

/**
 * Mounts `panel` with the guide answering `search` and main previewing and saving every rule.
 * Defaults to following the noon programme from its guide airing.
 */
async function discover(
  search: (input: IpcInput<"guide.searchPage">) => GuideSearchPage,
  panel: ReactElement = createElement(SchedulePanel, {
    basis: basisOfProgramme(channel, { title: "Noon News", start: NOON, stop: NOON + HOUR }),
    channelName: "Eurosport 1",
    onDone: () => {},
  }),
) {
  ipc.reset();
  ipc.answer("guide.searchPage", search);
  ipc.always("recordings.previewRule", { matches: [], limited: false, unproven: 0 });
  ipc.answer("recordings.saveRule", ({ plan }) => ({ id: "rule", plan }));
  const view = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  onTestFinished(() => view.unmount());
  await view.render(panel);
  await act(async () => document.querySelector<HTMLElement>("[data-repeat=follow]")?.click());
}

const channelButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Channels"] button'),
];

/** Saves the rule with the button labelled `label`, expecting the plan main last previewed. */
async function savePreviewed(label: string) {
  const button = () =>
    [...document.querySelectorAll("button")].find((each) => each.textContent === label);

  await vi.waitFor(() => expect(button()?.disabled).toBe(false));
  await act(async () => button()!.click());
  await vi.waitFor(() => expect(ipc.argsOf("recordings.saveRule")).toHaveLength(1));
  const plan = ipc.argsOf("recordings.saveRule")[0]!.plan;
  expect(
    ipc
      .argsOf("recordings.previewRule")
      .filter(({ plan }) => plan.mode === "every")
      .at(-1)?.plan,
  ).toEqual(plan);

  return plan;
}

const LIMIT_WARNING = "More channels may match. The guide search limit was reached.";

it("offers an exact title after a fuzzy guide page and saves the channels previewed", async () => {
  await discover(({ after }) =>
    after
      ? { matches: [discoveryMatch("22", " noon news "), discoveryMatch("22")], next: null }
      : {
          matches: Array.from({ length: 100 }, (_, i) =>
            discoveryMatch(`fuzzy${i}`, "Noon News Extra"),
          ),
          next: { start: NOON, channel: "fuzzy99" },
        },
  );
  await vi.waitFor(() =>
    expect(channelButtons().map((button) => button.textContent)).toEqual([
      "Eurosport 1",
      "Channel 22",
    ]),
  );
  await act(async () => channelButtons()[1]!.click());

  const plan = await savePreviewed("Turn on rule");
  expect(plan.channels).toEqual([channel, { subscriptionId: SUBSCRIPTION, id: "22" }]);
  expect(document.body.textContent).not.toContain(LIMIT_WARNING);
});

it("keeps at most 100 selected channels and saves the same bounded plan it previews", async () => {
  await discover(({ after }) =>
    after
      ? { matches: [discoveryMatch("extra")], next: null }
      : {
          matches: Array.from({ length: 100 }, (_, i) => discoveryMatch(`choice${i}`)),
          next: { start: NOON, channel: "choice99" },
        },
  );
  await vi.waitFor(() => expect(channelButtons()).toHaveLength(102));

  for (const button of channelButtons().slice(1)) await act(async () => button.click());
  expect(
    channelButtons().filter((button) => button.getAttribute("aria-pressed") === "true"),
  ).toHaveLength(100);
  expect(channelButtons().at(-1)?.getAttribute("aria-pressed")).toBe("false");
  expect(channelButtons().at(-1)?.disabled).toBe(true);
  // A full selection can still be changed: release one slot and choose the last channel.
  await act(async () => channelButtons()[0]!.click());
  expect(channelButtons().at(-1)?.disabled).toBe(false);
  await act(async () => channelButtons().at(-1)!.click());

  const plan = await savePreviewed("Turn on rule");
  expect(plan.channels).toHaveLength(100);
  expect(plan.channels).toContainEqual({ subscriptionId: SUBSCRIPTION, id: "extra" });
  expect(plan.channels).not.toContainEqual(channel);
});

it("stops discovery after ten guide pages and reports that more channels may match", async () => {
  await discover(({ after }) => {
    const page = after ? after.start + 1 : 1;

    return {
      matches: [discoveryMatch(`page${page}`)],
      next: { start: page, channel: `page${page}` },
    };
  });
  await vi.waitFor(() => expect(channelButtons()).toHaveLength(11));
  expect(channelButtons().at(-1)?.textContent).toBe("Channel page10");
  expect(ipc.argsOf("guide.searchPage")).toHaveLength(10);
  expect(document.body.textContent).toContain(LIMIT_WARNING);
});

it("keeps the same channel ID from different subscriptions separate while deduplicating guide airings", async () => {
  const otherSubscription = "another-subscription";
  await discover(
    ({ subscriptionId }) => ({
      matches: [
        discoveryMatch("22", "Noon News", subscriptionId),
        discoveryMatch("22", "Noon News", subscriptionId),
      ],
      next: null,
    }),
    createElement(RulePanel, {
      rule: {
        id: "rule",
        plan: {
          title: "Noon News",
          channels: [channel, { subscriptionId: otherSubscription, id: "11" }],
          mode: "every",
          padding: { before: 2, after: 5 },
        },
      },
      onDone: () => {},
    }),
  );
  await vi.waitFor(() => expect(channelButtons()).toHaveLength(4));

  for (const button of channelButtons().slice(2)) await act(async () => button.click());

  const plan = await savePreviewed("Save");
  expect(plan.channels).toEqual([
    channel,
    { subscriptionId: otherSubscription, id: "11" },
    { subscriptionId: SUBSCRIPTION, id: "22" },
    { subscriptionId: otherSubscription, id: "22" },
  ]);
});
