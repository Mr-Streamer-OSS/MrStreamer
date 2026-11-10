import type { Json } from "../../../../packages/contracts/src/json.ts";
// Record now through the built window, against the fake provider's one connection. A playable
// channel previews in Live TV, so Record says the recording shares the connection playing here,
// and starts it on Watch's own provider request while Watch plays on. Recordings, which stops the
// preview, shows it under Now still recording. While it records it plays from this computer: the
// player says how much it has so far, that closing keeps it recording, and Go to latest takes it
// to the newest picture, with no new provider request; leaving it, Home's Continue watching has it
// where this viewer got to. Back in Live TV Watch joins it again, and a Stop of the recording leaves
// Watch playing, all on that one request. A second recording takes Now again; Find a recording
// looks through both, and the stopped one plays from this computer. Its menu deletes it. Each
// state is captured at 1280 × 800 and the Recordings page also at 960 × 600. Last, a rule follows
// the programme on air from the guide: its recording is its own group, named by the rule, its rows
// by their day. `recordingsHlsScenario` does the same for a live HLS channel
// of one quality, Watch on hls.js, the provider asked once for each segment, or with `qualities`
// for one offered in 1080 and 720 lines: the Recording popover says the quality stays fixed, and
// the provider sends one of them while both read.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { FakeChannel } from "../../../../apps/desktop/test/fake-provider.ts";
import type { Driver } from "./language.ts";

/**
 * Three minutes of picture and sound with timestamps that never restart, keyframes each second,
 * made once by ffmpeg.
 */
let long: Buffer | null = null;

function longStream(): Buffer {
  if (long) return long;
  const path = join(tmpdir(), `mrstreamer-verify-long-${process.pid}.ts`);

  const made = spawnSync(process.env["MR_STREAMER_FFMPEG"] || "ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=25:duration=180",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=180",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "25",
    "-b:v",
    "600k",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    // Program tables before each keyframe, as broadcast muxers write them: the recording's index
    // verifies a start there.
    "-mpegts_flags",
    "+pat_pmt_at_frames",
    "-f",
    "mpegts",
    path,
  ]);

  if (made.status !== 0) {
    rmSync(path, { force: true });
    throw new Error(`ffmpeg made no long stream: ${String(made.stderr)}`);
  }

  try {
    long = readFileSync(path);
  } finally {
    rmSync(path, { force: true });
  }

  return long;
}

/**
 * The fake provider's stream for this scenario: a fixture channel sends `longStream` at its
 * real-time rate, so Watch and a recording have something to read for as long as they run. Other
 * channels stream as usual.
 */
export function longStreams(
  channel: FakeChannel,
  out: Writable,
  signal: AbortSignal,
  otherwise: (channel: FakeChannel, out: Writable, signal: AbortSignal) => void,
): void {
  if (!channel.fixture) return otherwise(channel, out, signal);
  const stream = longStream();
  // A tenth of a second at a time, a whole number of packets.
  const step = Math.ceil(stream.length / 1800 / 188) * 188;
  let offset = 0;

  const timer = setInterval(() => {
    out.write(stream.subarray(offset, offset + step));
    offset = offset + step >= stream.length ? 0 : offset + step;
  }, 100);

  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

const named = (selector: string, text: string, within = "document") =>
  `[...${within}.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

const POPUP = "document.querySelector('[role=dialog][aria-label=Record]')";

const expect = (value: boolean, message: string, seen?: Json) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

/** The recordings as the main process lists them, read without changing anything. */
const listed = (d: Driver) =>
  d.evaluate<
    {
      id: string;
      title: string;
      bytes: number;
      status: { kind: string };
      scheduled?: { rule?: string };
    }[]
  >(`(async () => {
    const read = await window.mrStreamer.invoke('recordings.list');
    if (!read.ok) throw new Error(read.error.kind);
    return read.value;
  })()`);

/** Watch's clock moves on by two seconds. */
async function playsOn(d: Driver) {
  const from = await d.evaluate<number>("document.querySelector('video')?.currentTime ?? 0");
  await d.wait(
    () => d.evaluate<boolean>(`(document.querySelector('video')?.currentTime ?? 0) >= ${from + 2}`),
    30_000,
  );
}

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
  const before = fixture.streams();
  d.observed["beforeRecord"] = before;

  await d.click("Open Record", record);
  await d.wait(() => d.exists(POPUP));
  // The channel plays here: recording it shares that connection.
  await d.wait(() =>
    d.evaluate<boolean>(`${POPUP}.innerText.includes("Shares the connection playing here.")`),
  );
  d.observed["popover"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture("record-popover");

  await d.click("Start recording", named("button", "Start recording", POPUP));
  const recordingButton = named("button", "Recording");
  await d.wait(() => d.exists(recordingButton), 60_000);
  // The keys go on from Recording, which took Record's place.
  await d.wait(() => d.evaluate<boolean>(`document.activeElement === ${recordingButton}`));
  const first = await listed(d);
  expect(first.length === 1 && first[0]!.status.kind === "recording", "Not recording", first);
  // Watch plays on, and the provider was asked for nothing more.
  await playsOn(d);
  const shared = fixture.streams();
  expect(
    shared.requests === before.requests && shared.active === 1,
    "Recording asked the provider for another stream",
    shared,
  );
  d.observed["recording"] = { list: first, streams: shared };
  await d.capture("live-recording");

  // Recordings stops the preview: the recording goes on, on the same request.
  await d.click("Open Recordings", named("header button", "Recordings"));
  await d.wait(() => d.exists(named("h1", "Recordings")));
  const bytes = (await listed(d))[0]!.bytes;
  // A few seconds of it, to play back.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const grown = await listed(d);
  expect(grown[0]!.bytes > bytes, "The recording stopped with Watch", grown);
  expect(fixture.streams().active === 1, "Watch's stop ended the recording", fixture.streams());
  d.observed["watchStopped"] = { list: grown, streams: fixture.streams() };
  await d.capture("recordings-now");
  await growingJourney(d, fixture);

  // Watch again joins the recording's request, though it holds the only connection.
  await d.click("Back to Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists(named("button", "Recording")));
  await playsOn(d);
  expect(
    fixture.streams().requests === before.requests,
    "Watch asked the provider again",
    fixture.streams(),
  );
  // The recording stops from the strip's Recording, by keyboard: Watch plays on.
  const RECORDING = "document.querySelector('[role=dialog][aria-label=Recording]')";
  await d.click("Open Recording", named("button", "Recording"));
  await d.wait(() => d.exists(RECORDING));
  d.observed["recordingPopover"] = await d.evaluate<string>(`${RECORDING}.innerText`);
  await d.capture("recording-popover");
  await d.key("Tab", 9);
  await d.key("Tab", 9);
  await d.wait(() =>
    d.evaluate<boolean>("document.activeElement?.textContent.trim() === 'Stop recording'"),
  );
  await d.key("Enter", 13);
  // The keys go on from Record, which took Recording's place.
  await d.wait(() => d.evaluate<boolean>(`document.activeElement === ${record}`));
  await d.wait(async () => (await listed(d))[0]?.status.kind === "stopped");
  await playsOn(d);
  const after = fixture.streams();
  expect(after.requests === before.requests && after.active === 1, "Watch stopped too", after);
  d.observed["stopped"] = { list: await listed(d), streams: after };
  await d.capture("watch-after-recording");

  // A second recording takes Now while the first waits under Recorded.
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
  await searchJourney(d);
  await size(d, 960, 600);
  await d.capture("recordings-960");
  await d.click("Back to Live TV at 960", named("header button", "Live TV"));
  // The strip's Recording opens its popover, whose Recordings opens the page.
  await d.click("Open Recording at 960", named("button", "Recording"));
  await d.wait(() => d.exists(RECORDING));
  await d.capture("recording-popover-960");
  await d.click("Open Recordings from it", named("button", "Recordings", RECORDING));
  await d.wait(() => d.exists(named("h1", "Recordings")));
  await size(d, 1280, 800);

  // The stopped one goes on from this computer where this viewer left it while it recorded: that
  // place was saved against what it had then, so it isn't taken as watched.
  const stoppedId = (await listed(d)).find((each) => each.status.kind === "stopped")!.id;
  d.observed["stoppedRow"] = await d.evaluate<string>(
    "document.querySelector('section[aria-label=Recorded] li').innerText",
  );
  expect(
    !String(d.observed["stoppedRow"]).includes("watched"),
    "A place saved while it recorded reads as watched",
    d.observed["stoppedRow"],
  );
  await d.click(
    "Resume the stopped recording",
    "document.querySelector('section[aria-label=Recorded] button[aria-label^=Resume]')",
  );
  // From five seconds before the place, as any copy resumes.
  await d.wait(
    () => d.evaluate<boolean>("(document.querySelector('video')?.currentTime ?? 0) > 0"),
    60_000,
  );
  d.observed["resumedAt"] = await titleState(d);
  const place = Number(/at (\d+) s/.exec(String(d.observed["stoppedRow"]))?.[1] ?? 0);
  expect(
    (d.observed["resumedAt"] as { time: number }).time >= place - 6,
    "It didn't go on from where it was left",
    d.observed["resumedAt"],
  );
  await d.wait(
    () =>
      d.evaluate<boolean>(`(document.querySelector('video')?.currentTime ?? 0) >= ${place - 3}`),
    60_000,
  );

  const playing = await d.evaluate<{ time: number; width: number; audio: number }>(
    `(() => { const v = document.querySelector('video');
    return { time: v.currentTime, width: v.videoWidth, audio: v.webkitAudioDecodedByteCount }; })()`,
  );

  expect(playing.width > 0 && playing.audio > 0, "No picture or sound", playing);
  d.observed["playing"] = playing;
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
  await d.wait(async () => fixture.streams().active === 0);
  d.observed["end"] = { list: await listed(d), streams: fixture.streams() };
  await d.capture("recordings-end");
  await groupJourney(d);
}

/** What the fake HLS host was asked for, by path. */
interface HlsFixture {
  requests(): readonly string[];
}

/**
 * The live HLS channel's segments the host sent from its `from`th request on, in order, as
 * "{stream} {sequence}": each once while Watch and its recording share them.
 */
const segmentsSent = (fixture: HlsFixture, from = 0) =>
  fixture
    .requests()
    .slice(from)
    .flatMap((path) => {
      const found = /^\/media\/(?:t\d+\/)?(compatible|qualities-\w+)-(\d+)\.ts$/.exec(path);

      return found ? [`${found[1]} ${found[2]}`] : [];
    });

export async function recordingsHlsScenario(d: Driver, fixture: HlsFixture, qualities = false) {
  const name = qualities ? "qualities" : "compatible";
  const shot = (what: string) => (qualities ? `hls-qualities-${what}` : `hls-${what}`);
  await size(d, 1280, 800);
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  d.action(`Search TEST | HLS ${name}`);
  await d.send("Input.insertText", { text: `TEST | HLS ${name}` });
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('[aria-label="Search results"] [aria-selected=true]')?.textContent.includes('HLS ${name}') ?? false`,
    ),
  );
  await d.key("Enter", 13);
  await d.wait(
    () =>
      d.evaluate<boolean>(
        "!!document.querySelector('[data-view=watch]') && (document.querySelector('video')?.currentTime ?? 0) >= 1",
      ),
    60_000,
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await d.click("Open Live TV", named("header button", "Live TV"));
  const record = named("button", "Record");
  await d.wait(() => d.exists(record));
  await playsOn(d);

  await d.click("Open Record", record);
  await d.wait(() => d.exists(POPUP));
  // The stream plays here, in one quality or the one Watch picked: recording it shares that
  // connection.
  await d.wait(() =>
    d.evaluate<boolean>(`${POPUP}.innerText.includes("Shares the connection playing here.")`),
  );
  d.observed["hlsPopover"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture(shot("record-popover"));
  const shared = fixture.requests().length;
  await d.click("Start recording", named("button", "Start recording", POPUP));
  const recordingButton = named("button", "Recording");
  await d.wait(() => d.exists(recordingButton), 60_000);
  const first = await listed(d);
  expect(first.length === 1 && first[0]!.status.kind === "recording", "Not recording", first);
  // Watch plays on through two segments more, as the recording grows.
  await playsOn(d);
  await playsOn(d);
  await playsOn(d);
  const grown = await listed(d);
  expect(grown[0]!.bytes > 0, "The recording took nothing", grown);
  d.observed["hlsRecording"] = { list: grown, segments: segmentsSent(fixture) };
  await d.capture(shot("live-recording"));

  // The recording stops from the strip's Recording, by keyboard: Watch plays on.
  const RECORDING = "document.querySelector('[role=dialog][aria-label=Recording]')";
  await d.click("Open Recording", recordingButton);
  await d.wait(() => d.exists(RECORDING));
  const FIXED = "Quality stays fixed while this records.";

  if (qualities) {
    // Watch holds one quality while the recording reads it, and the provider sends that one.
    await d.wait(() =>
      d.evaluate<boolean>(`${RECORDING}.innerText.includes(${JSON.stringify(FIXED)})`),
    );
    d.observed["hlsFixed"] = {
      popover: await d.evaluate<string>(`${RECORDING}.innerText`),
      playlists: fixture
        .requests()
        .slice(shared)
        .filter((path) => path.endsWith(".m3u8")),
    };
    await d.capture(shot("fixed"));

    const streams = new Set(
      segmentsSent(fixture, shared).map((each) => each.split(" ")[0] ?? each),
    );

    expect(streams.size === 1, "More than one quality was sent while both read", [...streams]);
  } else {
    expect(
      !(await d.evaluate<boolean>(`${RECORDING}.innerText.includes(${JSON.stringify(FIXED)})`)),
      "A stream of one quality said its quality is fixed",
    );
  }

  await d.key("Tab", 9);
  await d.key("Tab", 9);
  await d.wait(() =>
    d.evaluate<boolean>("document.activeElement?.textContent.trim() === 'Stop recording'"),
  );
  await d.key("Enter", 13);
  await d.wait(() => d.evaluate<boolean>(`document.activeElement === ${record}`));
  await d.wait(async () => (await listed(d))[0]?.status.kind === "stopped");
  await playsOn(d);
  await playsOn(d);
  d.observed["hlsStopped"] = { list: await listed(d), segments: segmentsSent(fixture) };
  await d.capture(shot("watch-after-recording"));

  // The host sent each segment once, Watch and the recording reading the same ones.
  const sent = segmentsSent(fixture);
  expect(sent.length > 4, "Too few segments were sent", sent);
  expect(new Set(sent).size === sent.length, "A segment was sent twice", sent);
}

const VIEW = "document.querySelector('[data-view=title]')";

/** Seconds in the player's "1:02 so far", or 0 without one. */
function soFar(text: string): number {
  const found = /(?:(\d+):)?(\d+):(\d+) so far/.exec(text);

  return found ? Number(found[1] ?? 0) * 3600 + Number(found[2]) * 60 + Number(found[3]) : 0;
}

/** The open title's picture, sound and position, and what its view says. */
const titleState = (d: Driver) =>
  d.evaluate<{ time: number; width: number; audio: number; text: string }>(
    `(() => { const v = document.querySelector('video');
    return { time: v.currentTime, width: v.videoWidth, audio: v.webkitAudioDecodedByteCount,
      text: ${VIEW}?.innerText ?? '' }; })()`,
  );

/**
 * The recording under Now plays from this computer while it records: decoded picture and sound,
 * how much it has so far, that closing keeps it recording, and Go to latest, which takes it to the
 * newest the session verifies and then waits there. None of it asks the provider for anything.
 * Leaving it saves this viewer's place, which Home's Continue watching shows.
 */
async function growingJourney(d: Driver, fixture: RecordingFixture) {
  const before = fixture.streams();
  const title = (await listed(d))[0]!.title;
  await d.click(
    "Play the recording while it records",
    "document.querySelector('section[aria-label=Now] button[aria-label^=Play]')",
  );
  await d.wait(
    () => d.evaluate<boolean>("(document.querySelector('video')?.currentTime ?? 0) >= 1"),
    60_000,
  );
  await d.wait(async () => {
    const { text } = await titleState(d);
    // Kept as it reads, for a run that waits in vain.
    d.observed["growingText"] = text;

    return text.includes("so far");
  });
  const opened = await titleState(d);
  expect(opened.width > 0 && opened.audio > 0, "No picture or sound", opened);
  expect(
    opened.text.includes("Closing the player keeps recording."),
    "The player doesn't say closing keeps recording",
    opened.text,
  );
  const latest = named("[data-view=title] button", "Go to latest");
  await d.wait(() => d.evaluate<boolean>(`${latest}?.disabled === false`), 30_000);
  d.observed["growingOpened"] = { ...opened, streams: fixture.streams() };
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 420 });
  await d.capture("growing-playing");

  await d.click("Go to latest", latest);
  // It lands near the newest picture, and Go to latest has nowhere to go.
  await d.wait(() => d.evaluate<boolean>(`${latest}?.disabled === true`), 60_000);
  await d.wait(async () => (await titleState(d)).time > opened.time + 5, 30_000);
  const landed = await titleState(d);
  // There it plays on as the recording grows, and what it has so far grows with it.
  await d.wait(async () => {
    const now = await titleState(d);

    return now.time >= landed.time + 3 && soFar(now.text) > soFar(landed.text);
  }, 30_000);
  const caught = await titleState(d);
  d.observed["growingLanded"] = landed;
  const streams = fixture.streams();
  expect(
    streams.requests === before.requests && streams.active === 1,
    "Playing the recording asked the provider again",
    streams,
  );
  d.observed["growingLatest"] = { ...caught, streams };
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 660, y: 430 });
  await d.capture("growing-latest");

  await d.click("Leave the recording", named("header button", "Back"));
  await d.wait(() =>
    d.evaluate<boolean>(`getComputedStyle(${named("h1", "Recordings")}).visibility === 'visible'`),
  );
  // Its row now offers Resume from this viewer's place in it, where they left.
  await d.wait(() =>
    d.exists(
      `document.querySelector('section[aria-label=Now] button[aria-label="Resume ${title}"]')`,
    ),
  );
  await d.wait(async () => {
    const row = await d.evaluate<string>(
      "document.querySelector('section[aria-label=Now] li').innerText",
    );

    const at = /at (\d+) (s|min)/.exec(row);

    return !!at && (at[2] === "min" || Number(at[1]) >= caught.time - 2);
  });
  d.observed["libraryResume"] = await d.evaluate<string>(
    "document.querySelector('section[aria-label=Now] li').innerText",
  );
  await d.capture("recordings-resume");

  await d.click("Open Home", named("header button", "Home"));
  await d.wait(() =>
    d.evaluate<boolean>(
      `[...document.querySelectorAll('section')].some(e => e.innerText.includes('Continue watching') && e.innerText.includes(${JSON.stringify(title)}))`,
    ),
  );

  const row = await d.evaluate<string>(
    "[...document.querySelectorAll('section')].find(e => e.innerText.includes('Continue watching')).innerText",
  );

  expect(/Recording · at \d+ (s|min)/.test(row), "Continue watching doesn't say where it is", row);
  expect(
    fixture.streams().requests === before.requests,
    "Home asked the provider",
    fixture.streams(),
  );
  d.observed["homeContinue"] = row;
  await d.capture("home-continue");
  await d.click("Back to Recordings", named("header button", "Recordings"));
  await d.wait(() => d.exists(named("h1", "Recordings")));
}

/**
 * Find a recording, from the keys: a word nothing has says so, the channel's name finds both
 * recordings, and emptying it brings Overview back.
 */
async function searchJourney(d: Driver) {
  const FIND = "document.querySelector('input[aria-label=\"Find a recording\"]')";

  const rows =
    "document.querySelectorAll('section[aria-label=Now] li, section[aria-label=Recorded] li').length";

  await d.click("Find a recording", FIND);
  await d.send("Input.insertText", { text: "zzz" });
  await d.wait(() =>
    d.evaluate<boolean>("document.body.innerText.includes('No recordings match zzz.')"),
  );
  await d.capture("recordings-search-none");

  for (let i = 0; i < 3; i++) await d.key("Backspace", 8);
  await d.send("Input.insertText", { text: "h.264" });
  await d.wait(() => d.evaluate<boolean>(`${rows} === 2`));
  d.observed["search"] = await d.evaluate<string>("document.querySelector('#root').innerText");
  expect(
    !(await d.exists("document.querySelector('section[aria-label=Scheduled]')")),
    "Searching left schedules listed",
  );
  await d.capture("recordings-search");

  for (let i = 0; i < 5; i++) await d.key("Backspace", 8);
  await d.wait(() =>
    d.evaluate<boolean>(
      `${named("nav button", "Overview")}?.getAttribute('aria-current') === 'page'`,
    ),
  );
}

const GRID = "document.querySelector('[role=grid]')";
const PANEL = "document.querySelector('[role=grid] [role=group]')";

/**
 * Follow programme on the programme on air, from the guide's details with nothing playing here:
 * the rule records it at once, and Recordings lists that recording as the rule's group, its row
 * named by its day, the heading saying what the rule follows where.
 */
async function groupJourney(d: Driver) {
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() =>
    d.exists("document.querySelector('[data-view=watch] button[aria-label=Stop]')"),
  );
  // Stopped, nothing playing here holds the one connection the rule records on.
  await d.click(
    "Stop playing",
    "document.querySelector('[data-view=watch] button[aria-label=Stop]')",
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await d.click("Open Live TV", named("header button", "Live TV"));

  if (!(await d.exists(GRID))) {
    await d.wait(() => d.exists(named("button", "Record")));
    await d.key("g", 71);
  }

  await d.wait(() =>
    d.evaluate<boolean>(`${GRID}?.querySelectorAll('[role=gridcell]').length > 4`),
  );
  // The programme on air, its details open.
  await d.key("ArrowRight", 39);
  await d.key("ArrowLeft", 37);
  const record = named("[role=grid] [role=region] button", "Record");
  await d.wait(() => d.exists(record));
  await d.click("Record the programme on air", record);
  await d.wait(() => d.exists(PANEL));
  await d.click("Follow programme", `${PANEL}.querySelector('[data-repeat=follow]')`);
  await d.wait(() => d.exists(named("button", "Turn on rule", PANEL)));
  await d.click("Turn on rule", named("button", "Turn on rule", PANEL));
  await d.wait(async () => !(await d.exists(PANEL)));

  // The rule records the programme on air at once.
  let made: { title: string } | undefined;
  await d.wait(async () => {
    made = (await listed(d)).find(
      (each) => each.scheduled?.rule !== undefined && each.status.kind === "recording",
    );

    return made !== undefined;
  }, 90_000);

  const name = made!.title;
  // A shelf's button holds its name, then its count.
  const shelf = `[...document.querySelectorAll('nav button')].find(e => e.firstElementChild?.textContent === ${JSON.stringify(name)})`;
  await d.click("Open Recordings", named("header button", "Recordings"));
  await d.wait(() => d.exists(shelf));
  await d.click("Open the rule's group", shelf);
  await d.wait(() => d.evaluate<boolean>(`${shelf}?.getAttribute('aria-current') === 'page'`));
  await d.wait(() => d.exists(named("h1", name)));
  const page = await d.evaluate<string>("document.querySelector('#root').innerText");
  expect(page.includes(`Follows ${name} on`), "The group doesn't say what it follows", page);

  const row = await d.evaluate<string>(
    "document.querySelector('section[aria-label=Now] li').innerText",
  );

  expect(!row.startsWith(name), "A group's row isn't named by its day", row);
  d.observed["group"] = { page, row };
  await d.capture("recordings-group");
  await d.click("Stop the rule's recording", named("li button", "Stop"));
  await d.wait(async () => !(await d.exists("document.querySelector('section[aria-label=Now]')")));

  // The side, Overview and the group in each language at the smallest window, then with
  // quarter-larger text.
  for (const [locale, recordings, overview] of [
    ["en_GB", "Recordings", "Overview"],
    ["nl_NL", "Opnames", "Overzicht"],
    ["fr_FR", "Enregistrements", "Vue d'ensemble"],
    ["es_ES", "Grabaciones", "Resumen"],
    ["de_DE", "Aufnahmen", "Übersicht"],
  ] as const) {
    await d.quit();
    await d.launch(locale);
    await size(d, 960, 600);
    await d.click(recordings, named("header button", recordings));
    await d.wait(() => d.exists(named("nav button", overview)));
    await d.wait(() => d.exists("document.querySelector('section li')"));
    await d.capture(`recordings-${locale}`);
    await d.click("Open the rule's group", shelf);
    await d.wait(() => d.exists(named("h1", name)));
    d.observed[`group-${locale}`] = await d.evaluate<string>(
      "document.querySelector('#root').innerText",
    );
    await d.capture(`recordings-${locale}-group`);
    await d.evaluate(
      "document.documentElement.style.fontSize = (parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.25) + 'px'",
    );
    await d.capture(`recordings-${locale}-group-larger`);
  }
}
