import type { Json } from "../../../../packages/contracts/src/json.ts";
// Record now through the built window, against the fake provider's one connection. A playable
// channel previews in Live TV, so Record says the recording shares the connection playing here,
// and starts it on Watch's own provider request while Watch plays on. Recordings, which stops the
// preview, shows it under Now still recording; back in Live TV Watch joins it again, and a Stop of
// the recording leaves Watch playing, all on that one request. A second recording takes Now
// again, and the stopped one plays from this computer. Its menu deletes it. Each state is captured at 1280 × 800 and the
// Recordings page also at 960 × 600. `recordingsHlsScenario` does the same for a live HLS channel
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

/** Three minutes of picture and sound with timestamps that never restart, made once by ffmpeg. */
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
    { id: string; title: string; bytes: number; status: { kind: string } }[]
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
