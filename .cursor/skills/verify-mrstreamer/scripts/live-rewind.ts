// Run with xvfb-run -a pnpm verify:desktop live-rewind. The optional
// REWIND_EXPIRY=1 journey waits for the real thirty-minute window to expire.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Driver } from "./language.ts";

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
    }>(`(() => {
    const v = document.querySelector('video'); return { time: v?.currentTime ?? 0,
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
  await d.key("k", 75);
  await d.wait(() => d.exists(`${group}?.querySelector('button[aria-label=Play]')`));
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
  await d.key("k", 75);
  await picture("rewind-resumed");
  await d.key("j", 74);
  await picture("rewind-j");
  await d.key("l", 76);
  await picture("rewind-l");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 500 });
  await d.click(
    "Forward control before slider",
    `${group}.querySelector('button[aria-label="Forward 10 seconds"]')`,
  );
  await d.key("Tab", 9);
  await d.key("Home", 36);
  await picture("rewind-slider");
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
    fixture.streams().active === 1 && fixture.streams().requests === initial.requests,
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
