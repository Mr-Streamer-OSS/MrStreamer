// Record now through the built window, against the fake provider's one connection. A playable
// channel previews in Live TV, so Record's first start finds the connection held by playing here
// and offers Stop playing and record, which frees it and starts. Recordings then shows it under
// Now; Stop moves it to Recorded, a second recording takes Now again, and the stopped one plays
// from this computer. Its menu deletes it. Each state is captured at 1280 × 800 and the
// Recordings page also at 960 × 600.
import type { Driver } from "./language.ts";

const named = (selector: string, text: string, within = "document") =>
  `[...${within}.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const POPUP = "document.querySelector('[role=dialog][aria-label=Record]')";
const expect = (value: boolean, message: string, seen?: unknown) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

/** The recordings as the main process lists them, read without changing anything. */
const listed = (d: Driver) =>
  d.evaluate<
    { id: string; title: string; bytes: number; status: { kind: string } }[]
  >(`(async () => {
    const read = await window.mrStreamer.invoke('recordings.list');
    if (!read.ok) throw new Error(read.error.kind);
    return read.value;
  })()`);

async function size(d: Driver, width: number, height: number) {
  d.action(`Size the page ${width} × ${height}`);
  await d.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`));
}

/** What the fake provider was asked for. */
interface RecordingFixture {
  streams(): { requests: number; active: number };
}

export async function recordingsScenario(d: Driver, fixture: RecordingFixture) {
  await size(d, 1280, 800);
  // The channel plays from Search, then previews behind Live TV.
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  d.action("Search TEST | H.264 + AAC");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && (document.querySelector('video')?.currentTime ?? 0) >= 1",
    ),
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await d.click("Open Live TV", named("header button", "Live TV"));
  const record = named("button", "Record");
  await d.wait(() => d.exists(record));
  await d.wait(() =>
    d.evaluate<boolean>("(document.querySelector('video')?.currentTime ?? 0) > 1"),
  );
  d.observed["beforeRecord"] = fixture.streams();

  await d.click("Open Record", record);
  await d.wait(() => d.exists(POPUP));
  d.observed["popover"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture("record-popover");

  // The preview holds the one connection: starting says so and offers to stop it.
  await d.click("Start recording", named("button", "Start recording", POPUP));
  const stopAndRecord = named("button", "Stop playing and record", POPUP);
  await d.wait(() => d.exists(stopAndRecord));
  d.observed["busy"] = await d.evaluate<string>(`${POPUP}.innerText`);
  expect((await listed(d)).length === 0, "Busy started a recording");
  await d.capture("record-busy");
  await d.click("Stop playing and record", stopAndRecord);
  const recordingButton = named("button", "Recording");
  const refused = `${POPUP}?.querySelector('p.text-destructive')`;
  await d.wait(async () => (await d.exists(recordingButton)) || (await d.exists(refused)), 60_000);
  if (!(await d.exists(recordingButton))) {
    // Known main-process race: the provider can still count the stopped preview's stream.
    d.observed["stopPlayingFirstAnswer"] = await d.evaluate<string>(`${refused}.innerText`);
    await d.capture("record-refused");
    await d.click("Stop playing and record, again", stopAndRecord);
    await d.wait(() => d.exists(recordingButton), 60_000);
  }
  const first = await listed(d);
  expect(first.length === 1 && first[0]!.status.kind === "recording", "Not recording", first);
  d.observed["recording"] = { list: first, streams: fixture.streams() };
  await d.capture("live-recording");

  // Recordings opens from the bar, which lists it now, and from the strip's Recording.
  await d.click("Open Recordings", named("header button", "Recordings"));
  await d.wait(() => d.exists(named("h1", "Recordings")));
  await d.wait(async () => ((await listed(d))[0]?.bytes ?? 0) > 0);
  await d.capture("recordings-now");
  // A few seconds of it, to play back.
  await new Promise((resolve) => setTimeout(resolve, 8_000));

  await d.click("Stop the recording", named("li button", "Stop"));
  await d.wait(async () => (await listed(d))[0]?.status.kind === "stopped");
  d.observed["stopped"] = { list: await listed(d), streams: fixture.streams() };

  // A second recording takes Now while the first waits under Recorded.
  await d.click("Back to Live TV", named("header button", "Live TV"));
  await d.click("Open Record again", record);
  await d.wait(() => d.exists(POPUP));
  await d.click("Start recording again", named("button", "Start recording", POPUP));
  await d.wait(() => d.exists(named("button", "Recording")), 60_000);
  await d.click("Open Recordings again", named("header button", "Recordings"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelectorAll('section[aria-label=Now] li, section[aria-label=Recorded] li').length === 2",
    ),
  );
  d.observed["page"] = await d.evaluate<string>("document.querySelector('#root').innerText");
  await d.capture("recordings-1280");
  await size(d, 960, 600);
  await d.capture("recordings-960");
  await d.click("Back to Live TV at 960", named("header button", "Live TV"));
  await d.click("Open Record at 960", named("button", "Recording"));
  await d.wait(() => d.exists(named("h1", "Recordings")));
  await size(d, 1280, 800);

  // The stopped one plays from this computer.
  const stoppedId = (await listed(d)).find((each) => each.status.kind === "stopped")!.id;
  await d.click(
    "Play the stopped recording",
    "document.querySelector('section[aria-label=Recorded] button[aria-label^=Play]')",
  );
  await d.wait(
    () => d.evaluate<boolean>("(document.querySelector('video')?.currentTime ?? 0) >= 1"),
    60_000,
  );
  d.observed["playing"] =
    await d.evaluate<object>(`(() => { const v = document.querySelector('video');
    return { time: v.currentTime, width: v.videoWidth, audio: v.webkitAudioDecodedByteCount }; })()`);
  await d.capture("recording-playing");
  await d.click("Leave the recording", named("header button", "Back"));
  await d.wait(() =>
    d.evaluate<boolean>(`getComputedStyle(${named("h1", "Recordings")}).visibility === 'visible'`),
  );

  // Its menu deletes it, with its file.
  await d.click(
    "Open the stopped recording's menu",
    "document.querySelector('section[aria-label=Recorded] button[aria-label^=\"More for\"]')",
  );
  await d.click("Delete it", named("[role=menuitem]", "Delete"));
  await d.wait(async () => !(await listed(d)).some((each) => each.id === stoppedId));
  await d.click("Stop the second recording", named("li button", "Stop"));
  await d.wait(async () => (await listed(d)).every((each) => each.status.kind !== "recording"));
  d.observed["end"] = { list: await listed(d), streams: fixture.streams() };
  await d.capture("recordings-end");
}
