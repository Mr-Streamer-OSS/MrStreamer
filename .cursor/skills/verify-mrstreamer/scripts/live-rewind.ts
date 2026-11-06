// Run with xvfb-run -a pnpm verify:desktop live-rewind. The optional
// REWIND_EXPIRY=1 journey waits for the real thirty-minute window to expire.
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { FakeChannel } from "../../../../apps/desktop/test/fake-provider.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Driver } from "./language.ts";

let fixtureEpoch = 0;
let breakRequested = false;

/** Fault injection belongs to the owned fake provider, never a product IPC setter. */
export function breakRewindStream() {
  breakRequested = true;
}

/** A constant-rate fixture with decoded seconds encoded as twelve black/white squares over a nonlooping one-hour epoch. */
export function rewindStreams(channel: FakeChannel, out: Writable, signal: AbortSignal) {
  if (!channel.fixture) return out.end();

  const boxes = [
    "drawbox=x=0:y=0:w=384:h=32:color=black:t=fill",
    ...Array.from(
      { length: 12 },
      (_, bit) =>
        `drawbox=x=${bit * 32}:y=0:w=32:h=32:color=white:t=fill:enable='mod(floor(t/${2 ** bit}),2)'`,
    ),
  ];

  const encoder = spawn(
    process.env["MR_STREAMER_FFMPEG"] || "ffmpeg",
    [
      "-v",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=25:duration=3600",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3600",
      "-vf",
      boxes.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "25",
      "-b:v",
      "400k",
      "-maxrate",
      "400k",
      "-bufsize",
      "800k",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-muxrate",
      "900k",
      "-f",
      "mpegts",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let errors = "";
  encoder.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4096);
  });
  encoder.once("error", (error) => out.destroy(error));
  encoder.once("exit", (code) => {
    if (code && !signal.aborted && !breakRequested)
      out.destroy(new Error(`Identity fixture failed: ${errors}`));
  });
  encoder.stdout.once("data", () => {
    fixtureEpoch = Date.now();
  });
  encoder.stdout.pipe(out);

  const timer = setInterval(() => {
    if (!breakRequested) return;
    clearInterval(timer);
    encoder.stdout.unpipe(out);
    encoder.kill();
    out.end();
    breakRequested = false;
  }, 100);

  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
      encoder.kill();
    },
    { once: true },
  );
  encoder.once("exit", () => clearInterval(timer));
}

const group = "document.querySelector('[data-live-timeline]')";

const named = (text: string, scope = "document") =>
  `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

const check = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

/** Disk bytes of this owned profile only. A failed read is a failed measurement. */
async function bytes(folder: string): Promise<number> {
  const entries = await readdir(folder, { withFileTypes: true });

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(folder, entry.name);

      return entry.isDirectory() ? bytes(path) : (await stat(path)).size;
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

export async function liveRewindScenario(
  d: Driver,
  fixture: {
    pid: number;
    breakStream(): void;
    streams(): { requests: number; active: number };
  },
) {
  const samples: Record<string, unknown>[] = [];
  d.observed["resources"] = samples;

  const resources = async (stage: string) => {
    const history = join(d.profile, "live-history");

    // Main-process RSS on Linux, not a total app or HLS memory ceiling.
    const status =
      process.platform === "linux" ? await readFile(`/proc/${fixture.pid}/status`, "utf8") : "";

    samples.push({
      stage,
      at: new Date().toISOString(),
      historyBytes: await bytes(history),
      mainRssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
      streams: fixture.streams(),
    });
  };

  const video = () =>
    d.evaluate<{
      time: number;
      width: number;
      frames: number;
      audio: number;
      paused: boolean;
      identity: number;
      cursor: number;
      start: number;
      end: number;
    }>(`(() => {
    const v = document.querySelector('video');
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const ctx = c.getContext('2d'); if (v.videoWidth) ctx.drawImage(v, 0, 0, 640, 360);
    let identity = 0;
    for (let bit = 0; bit < 12; bit++) if (ctx.getImageData(bit * 32 + 16, 16, 1, 1).data[0] > 180) identity += 2 ** bit;
    const slider = document.querySelector('[data-live-timeline] input');
    return { identity, cursor: Number(slider.value), start: Number(slider.min), end: Number(slider.max), time: v?.currentTime ?? 0,
      width: v?.videoWidth ?? 0, frames: v?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
      audio: v?.webkitAudioDecodedByteCount ?? 0, paused: v?.paused ?? true };
  })()`);

  const picture = async (stage: string) => {
    const before = await video();
    await d.wait(async () => {
      const after = await video();

      return (
        after.width > 0 &&
        after.audio > 0 &&
        !after.paused &&
        after.time > Math.max(2, before.time + 0.4) &&
        after.frames > before.frames
      );
    });
    d.observed[stage] = await video();
    await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 500 });
    await d.capture(stage);
  };

  await d.click("Open Search", "document.querySelector('button[aria-label=Search]')");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() => d.exists(group));
  await picture("rewind-playing");
  await resources("playing");
  const initial = fixture.streams();
  let expectedRequests = initial.requests;
  const pausedIdentity = await video();
  await d.key("k", 75);
  await d.wait(() => d.exists(`${group}?.querySelector('button[aria-label=Play]')`));
  const pausedPoster = await d.evaluate<string>("document.querySelector('video').poster");
  check(pausedPoster.startsWith("data:image/jpeg"), "Pause lost the decoded frame");
  const end = await d.evaluate<number>(`${group}.querySelector('input').max * 1`);
  await d.wait(
    () => d.evaluate<boolean>(`${group}.querySelector('input').max * 1 > ${end + 12000}`),
    30_000,
  );
  check(
    fixture.streams().requests === initial.requests && fixture.streams().active === 1,
    "Pause opened or ended the provider stream",
  );
  await d.wait(async () => (await bytes(join(d.profile, "live-history"))) > 0, 120_000);
  const frozen = await d.evaluate<string>("document.querySelector('video').poster");
  check(frozen === pausedPoster, "The paused picture changed while capture advanced");
  await resources("paused-capturing");
  await d.capture("rewind-paused");

  if (process.env["REWIND_EXPIRY"] === "1") {
    d.action("Wait for the actual thirty-minute retained window to expire");
    await d.wait(
      () => d.evaluate<boolean>(`${group}.innerText.includes('Paused moment expired')`),
      32 * 60_000,
    );
    await d.capture("rewind-expired");
    d.observed["expiry"] = "Observed at the production thirty-minute target";
  } else d.observed["expiry"] = "Not run; REWIND_EXPIRY=1 waits for production retention";
  const resumeBounds = await video();
  const expectedIdentity = (at: number) => Math.max(0, (at - fixtureEpoch) / 1000);
  d.observed["fixtureEpoch"] = fixtureEpoch;
  const resumeTarget = Math.max(resumeBounds.start, pausedIdentity.cursor);
  await d.key("k", 75);
  await picture("rewind-resumed");
  const resumed = await video();
  check(
    Math.abs(resumed.identity - resumed.time - expectedIdentity(resumeTarget)) <= 5,
    "Resume decoded the wrong historical interval",
  );
  check(resumed.end - resumed.cursor > 8000, "Resume jumped to live");
  await d.key("j", 74);
  await picture("rewind-j");
  const backward = await video();
  check(
    Math.abs(
      backward.identity -
        backward.time -
        expectedIdentity(Math.max(backward.start, resumed.cursor - 10_000)),
    ) <= 5,
    "J decoded the wrong historical interval",
  );
  await d.key("l", 76);
  await picture("rewind-l");
  const forward = await video();
  check(
    Math.abs(
      forward.identity -
        forward.time -
        expectedIdentity(Math.min(forward.end, backward.cursor + 10_000)),
    ) <= 5,
    "L decoded the wrong historical interval",
  );
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 500 });
  await d.click(
    "Forward control before slider",
    `${group}.querySelector('button[aria-label="Forward 10 seconds"]')`,
  );
  await d.key("Tab", 9);
  await d.key("Home", 36);
  await picture("rewind-slider");
  const slider = await video();
  check(slider.cursor - slider.start < 5000, "Slider Home did not commit its cursor");
  check(
    Math.abs(slider.identity - slider.time - expectedIdentity(slider.start)) <= 5,
    "Slider Home decoded the wrong historical interval",
  );
  await d.key("Tab", 9);
  d.observed["sliderNextFocus"] = await d.evaluate<string>(
    "document.activeElement?.textContent ?? ''",
  );
  await d.click("Go live", named("Go live", group));
  await picture("rewind-go-live");
  await d.wait(() => d.evaluate<boolean>(`${named("Go live", group)}.disabled`));
  await resources("after-seeks");
  check(fixture.streams().requests === initial.requests, "Seeking reopened the provider");
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 400 });
  await d.capture("rewind-720");
  d.observed["layout720"] =
    await d.evaluate(`(() => { const r = ${group}.getBoundingClientRect(); return {
    width: innerWidth, left: r.left, right: r.right, overflow: ${group}.scrollWidth > ${group}.clientWidth }; })()`);
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (process.env["REWIND_RECOVERY"] === "1") {
    const beforeRecovery = await video();
    fixture.breakStream();
    await d.wait(() => Promise.resolve(fixture.streams().requests > expectedRequests), 60_000);
    await picture("rewind-recovered");
    const recovered = await video();
    check(
      recovered.start > beforeRecovery.start,
      "Recovery mixed the old and new capture timelines",
    );
    check(recovered.identity < 10, "Recovery decoded the old capture");
    expectedRequests = fixture.streams().requests;
    d.observed["recovery"] = { beforeRecovery, recovered };
  }

  // Start a recording through the normal Live TV popover, then stop Watch from Recordings.
  await d.key("Escape", 27);
  await d.click("Open Live TV", named("Live TV"));
  await d.click("Record", named("Record"));
  await d.click(
    "Start recording",
    named("Start recording", "document.querySelector('[role=dialog][aria-label=Record]')"),
  );
  await d.wait(() => d.exists(named("Recording")), 60_000);

  const recordings = () =>
    d.evaluate<{ bytes: number; status: { kind: string } }[]>(`(async () => {
    const r = await window.mrStreamer.invoke('recordings.list'); if (!r.ok) throw Error(r.error.kind); return r.value;
  })()`);

  await d.click(
    "Open Recordings and close view history",
    named("Recordings", "document.querySelector('header')"),
  );
  const from = (await recordings())[0]!.bytes;
  await d.wait(async () => (await recordings())[0]!.bytes > from, 30_000);
  check(
    fixture.streams().active === 1 && fixture.streams().requests === expectedRequests,
    "View close stopped or duplicated attached recording",
  );
  await d.wait(async () => (await bytes(join(d.profile, "live-history"))) === 0);
  await resources("view-closed-recording-continues");
  await d.capture("rewind-recording-continues");
  d.observed["attachedRecording"] = await recordings();
  d.observed["limits"] = [
    "Linux Xvfb functional decoding, not native GPU or audible output",
    "Main RSS excludes renderer, GPU, ffmpeg and HLS in-flight memory",
    "Historical PID epochs and injected gap/recovery not exercised by this single-layout fixture",
    "Screen-reader speech and translated/24-hour clock layouts require their own runs",
  ];
  // Quit closes the owned capture and recording; the parent retains proof and removes its profile.
  await d.quit();
  await d.wait(async () => (await bytes(join(d.profile, "live-history"))) === 0);
  d.observed["quitHistoryBytes"] = await bytes(join(d.profile, "live-history"));
  await d.launch();
}
