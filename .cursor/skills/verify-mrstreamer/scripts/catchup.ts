// Catch-up through Live TV's rest of the day: a programme that aired plays from the fake panel's
// timeshift archive in Watch, which says it aired earlier. The panel breaks the connection two
// seconds in and the player reconnects to the recording; it ends, and Watch then plays the
// channel live. The panel's record of the timeshift addresses is the proof of the windows asked
// for.
//
// The guide keeps no programme that has ended until its on-disk index lands, so the window's own
// clock runs `CLOCK_LEAD_MS` ahead of the main process's: the programme on now has aired by the
// window's clock, which is what lists it, and the main process asks the panel for it on its own
// clock, which accepts a programme that has started.
import type { ArchiveRequest } from "../../../../apps/desktop/test/fake-provider.ts";
import type { Driver } from "./language.ts";

/** How far the window's clock runs ahead of the main process's. */
export const CLOCK_LEAD_MS = 45 * 60 * 1000;
/** The time zone the fake panel names, whose clock its timeshift addresses tell. */
const PANEL_ZONE = "Europe/Amsterdam";
const CHANNEL = "H.264 + AAC";

/** What the fake panel was asked for, for the scenario's checks. */
export interface CatchupFake {
  archiveRequests(): readonly ArchiveRequest[];
  breakNextArchive(pieces: number): void;
  streams(): { readonly requests: number; readonly active: number };
}

const SHIFTED_CLOCK = `(() => {
  const lead = ${CLOCK_LEAD_MS};
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [Real.now() + lead])); }
    static now() { return Real.now() + lead; }
  };
})();`;

const row = `[...document.querySelectorAll('[data-index]')].find(r => r.querySelector('[title]')?.firstElementChild?.textContent === ${JSON.stringify(CHANNEL)})`;
const lines = `[...(${row})?.querySelectorAll('.rounded-b-xl > button') ?? []]`;
const video = `(() => {
  const v = document.querySelector('video');
  return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, ended: v?.ended ?? false,
    audio: v?.webkitAudioDecodedByteCount ?? 0, watching: !!document.querySelector('[data-view=watch]') };
})()`;

/** "2026-10-13:20-00", as the panel's timeshift address writes `time` on its clock. */
function panelTime(time: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: PANEL_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}:${parts["hour"]}-${parts["minute"]}`;
}

export async function catchupScenario(d: Driver, fake: CatchupFake): Promise<void> {
  const expect = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  const playback = () =>
    d.evaluate<{ time: number; width: number; ended: boolean; audio: number; watching: boolean }>(
      video,
    );
  const nowPlaying = () =>
    d.evaluate<string>("document.querySelector('[data-view=watch]')?.innerText ?? ''");
  /** Moves the pointer over the picture, which shows Watch's fading controls for a while. */
  const wake = async () => {
    d.action("Move the pointer over the picture");
    for (const x of [600, 640]) {
      await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
    }
  };

  d.action(`Run the window's clock ${CLOCK_LEAD_MS / 60_000} min ahead and reload it`);
  await d.send("Page.enable");
  await d.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIFTED_CLOCK });
  await d.send("Page.reload");
  const lead = () =>
    d.evaluate<number>("Math.round(Date.now() - performance.timeOrigin - performance.now())");
  await d.wait(
    async () =>
      (await d.exists("document.querySelector('header')")) &&
      (await lead()) > CLOCK_LEAD_MS - 60_000,
  );
  d.observed["clockLeadMs"] = await lead();

  await d.click(
    "Open Live TV",
    "[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Live TV')",
  );
  await d.click(
    "Open the TEST category",
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('TEST | Formats'))",
  );
  await d.wait(() => d.exists(row));
  await d.click(
    `Open the rest of ${CHANNEL}'s day`,
    `(${row})?.querySelector('button[aria-label="Later programmes"]')`,
  );
  await d.wait(() => d.evaluate<boolean>(`${lines}.length > 1`));
  const day = await d.evaluate<{ time: string; title: string; onNow: boolean }[]>(
    `${lines}.map(line => ({ time: line.firstElementChild.textContent,
      title: line.children[1].firstElementChild.textContent,
      onNow: !!line.querySelector('.bg-white\\\\/20') }))`,
  );
  d.observed["schedule"] = day;
  const aired = day[0];
  expect(!!aired && !aired.onNow, "The rest of the day lists no programme that aired.");
  await d.capture("catchup-schedule");

  // The panel's first answer breaks off two seconds in, as a dropped connection does.
  fake.breakNextArchive(20);
  await d.click(`Play ${aired!.title}, which aired`, `${lines}[0]`);
  await d.wait(async () => {
    const v = await playback();
    return v.watching && v.time >= 1 && v.width > 0 && v.audio > 0;
  });
  d.observed["archivePlayback"] = await playback();
  const shown = await nowPlaying();
  d.observed["archiveNowPlaying"] = shown;
  expect(
    shown.includes(aired!.title) && shown.includes("Aired"),
    "Watch doesn't say the programme aired.",
  );

  // The player reconnects to the recording where it got to, and it plays again.
  await d.wait(async () => {
    if (fake.archiveRequests().length < 2) return false;
    const v = await playback();
    return v.time >= 1 && v.width > 0 && v.audio > 0;
  });
  d.observed["reconnectedPlayback"] = await playback();
  d.observed["reconnectedNowPlaying"] = await nowPlaying();
  expect((await nowPlaying()).includes("Aired"), "The reconnect lost the programme.");
  await wake();
  await d.capture("catchup-playing");

  // The panel was asked for that programme, from its start on its own clock, and again, after the
  // break, from the minute it had got to, which is the same; and for nothing live.
  const schedule = await d.evaluate<
    { start: number; stop: number; title: string }[]
  >(`(async () => {
    const read = await window.mrStreamer.invoke('library.channels', { query: ${JSON.stringify(CHANNEL)} });
    const channel = read.ok ? read.value[0] : null;
    if (!channel) return [];
    const day = await window.mrStreamer.invoke('guide.schedule',
      { channel: { subscriptionId: channel.subscriptionId, id: channel.id } });
    return day.ok ? day.value : [];
  })()`);
  const programme = schedule.find((each) => each.title === aired!.title);
  expect(!!programme, "The guide no longer lists the programme played.");
  const expected = {
    streamId: "1000",
    minutes: Math.ceil((programme!.stop - programme!.start) / 60_000),
    start: panelTime(programme!.start),
  };
  d.observed["archiveRequested"] = fake.archiveRequests();
  d.observed["archiveExpected"] = expected;
  expect(
    JSON.stringify(fake.archiveRequests()) === JSON.stringify([expected, expected]),
    "The panel wasn't asked for exactly the programme's window, once and after the break.",
  );
  expect(fake.streams().requests === 0, "Catch-up asked the panel for the channel live.");

  // The recording ends: the channel stops there, still saying what aired.
  await d.wait(() => d.exists("document.querySelector('[data-view=watch] [data-retry]')"));
  d.observed["archiveEnded"] = { ...(await playback()), nowPlaying: await nowPlaying() };
  expect((await nowPlaying()).includes("Aired"), "Watch forgot the programme once it ended.");
  await d.capture("catchup-ended");

  await d.click(
    `Watch ${CHANNEL} live`,
    "document.querySelector('[data-view=watch] [data-retry]')",
  );
  await d.wait(async () => {
    const v = await playback();
    return !v.ended && v.time >= 1 && v.width > 0;
  });
  d.observed["livePlayback"] = await playback();
  d.observed["liveNowPlaying"] = await nowPlaying();
  expect(!(await nowPlaying()).includes("Aired"), "The channel still says it aired.");
  expect(fake.streams().requests === 1, "Watch didn't play the channel live.");
  expect(fake.archiveRequests().length === 2, "The recording was asked for again.");
  await wake();
  await d.capture("catchup-live-again");
}
