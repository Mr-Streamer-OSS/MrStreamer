// Run with xvfb-run -a pnpm verify:desktop picture-sound. Plays a direct and a converted channel
// and a title with two sound tracks through the window: as the stream comes, then with picture and
// sound adjustments set in More > Picture and sound, again after a restart, and after Reset from
// the title's Picture and sound menu, pressed with the keyboard. Chromium's Web Audio domain shows
// the route sound takes, never the player's store or IPC. The same window renders synthetic
// signals through the exact sound chain the player uses, offline, for timing, clipping, latency
// and cost.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { FakeChannel } from "../../../../apps/desktop/test/fake-provider.ts";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../../../../packages/contracts/src/json.ts";
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  type PlaybackAdjustments,
} from "../../../../packages/contracts/src/preferences.ts";
import type { Driver } from "./language.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const chainSource = join(desktop, "src/renderer/src/player/sound.ts");

/**
 * A constant-rate live encode for each fixture channel, so playback can be watched keeping pace:
 * a 16:9 picture with a 440 Hz tone, in AAC, which plays as sent, or in MP2 on the MP2 channel,
 * which the app converts.
 */
export function pictureSoundStreams(channel: FakeChannel, out: Writable, signal: AbortSignal) {
  if (!channel.fixture) return out.end();
  const audio = channel.name.includes("MP2") ? "mp2" : "aac";

  const encoder = spawn(
    process.env["MR_STREAMER_FFMPEG"] || "ffmpeg",
    [
      "-v",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=25",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "25",
      "-b:v",
      "400k",
      "-c:a",
      audio,
      "-b:a",
      "128k",
      "-f",
      "mpegts",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  encoder.once("error", (error) => out.destroy(error));
  encoder.stdout.pipe(out);
  signal.addEventListener("abort", () => encoder.kill(), { once: true });
}

/** What the scenario sets in the panel: every sound adjustment and the picture's crop and zoom. */
const ADJUSTED: PlaybackAdjustments = {
  soundDelayMs: 200,
  leveling: true,
  aspect: "source",
  crop: "4:3",
  zoom: 150,
};

const button = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

/**
 * The open Picture and sound panel's rows whose control passes the row's right edge, whose value
 * breaks onto a second line, or that make the menu scroll sideways: none in any language or text
 * size. Evaluate it with the panel open, as the journey does in English.
 */
export const PANEL_OVERFLOW = `(() => {
  const dialog = document.querySelector("[role=dialog]");
  if (!dialog) return ["no open menu"];
  const over = dialog.scrollWidth > dialog.clientWidth ? ["menu scrolls sideways"] : [];
  for (const control of dialog.querySelectorAll("[role=radio], [role=group] button")) {
    const row = control.closest("[role=group]") ?? control.closest("[role=radiogroup]").parentElement;
    const edge = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight);
    if (control.getBoundingClientRect().right > edge + 0.5) over.push(control.getAttribute("aria-label"));
  }
  for (const value of dialog.querySelectorAll("[role=group] [aria-live]"))
    if (value.getBoundingClientRect().height > parseFloat(getComputedStyle(value).lineHeight) * 1.5)
      over.push(value.textContent);
  return over;
})()`;

/** Chromium's Web Audio events, as the window's DevTools session reports them. */
type Listen = (event: string, listener: (params: Json | undefined) => void) => void;

type AudioGraph = {
  contexts: { id: string; type: string; sampleRate: number }[];
  nodes: string[];
  connections: number;
};

/** The part of Vite's build options this bundle uses; Vite is the desktop app's dependency. */
type ChainBuild = {
  configFile: false;
  logLevel: "silent";
  build: {
    write: false;
    minify: false;
    lib: { entry: string; formats: ["iife"]; name: string };
  };
};

type Built = { output: { code: string }[] };

/** The exact chain module, bundled as the renderer bundles it, for the window to run. */
async function bundledChain(): Promise<string> {
  const vite = (await import(createRequire(join(desktop, "package.json")).resolve("vite"))) as {
    build(config: ChainBuild): Promise<Built | Built[]>;
  };

  const built = await vite.build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: chainSource, formats: ["iife"], name: "__mrStreamerSound" },
    },
  });

  return (Array.isArray(built) ? built[0]! : built).output[0]!.code;
}

/** Offline renders of synthetic signals through `soundChain`, in the window's own Chromium. */
const MEASURE = `(async () => {
  const { soundChain } = globalThis.__mrStreamerSound;
  const rate = 48000;
  // Chromium's two compressors each look ahead 6 ms; all onset gates allow 1 ms.
  const lookaheadMs = 12;
  const toleranceSamples = rate / 1000;
  const render = async (seconds, channels, fill, adjustments, outputs = channels) => {
    const context = new OfflineAudioContext(outputs, Math.round(seconds * rate), rate);
    const buffer = context.createBuffer(channels, context.length, rate);
    for (let c = 0; c < channels; c++) fill(buffer.getChannelData(c), c);
    const source = new AudioBufferSourceNode(context, { buffer, channelCount: channels });
    const chain = soundChain(context, source);
    chain.set(adjustments);
    chain.output.connect(context.destination);
    source.start(0);
    const began = performance.now();
    const out = await context.startRendering();
    return { out, ms: performance.now() - began };
  };
  const at = 0.5 * rate;
  const impulse = (data) => { data[at] = 1; };
  const onset = (data) => data.findIndex((x) => Math.abs(x) > 0.001);
  const timing = [];
  for (const leveling of [false, true])
    for (const soundDelayMs of [0, 40, 200, 2000]) {
      const { out } = await render(3, 2, impulse, { soundDelayMs, leveling });
      const index = onset(out.getChannelData(0));
      timing.push({ soundDelayMs, leveling, measuredMs: index < 0 ? null : (index - at) / (rate / 1000) });
    }
  // Quiet speech level, then full scale, then sudden full-scale bursts after silence.
  const program = (data) => {
    for (let i = 0; i < data.length; i++) {
      const t = i / rate, tone = Math.sin(2 * Math.PI * 220 * t);
      data[i] = t < 4 ? 0.01 * tone : t < 8 ? tone : (Math.floor(t * 4) % 2 ? Math.sign(tone) : 0);
    }
  };
  const rms = (data, from, to) => {
    let sum = 0;
    for (let i = from * rate; i < to * rate; i++) sum += data[i] * data[i];
    return 20 * Math.log10(Math.sqrt(sum / ((to - from) * rate)));
  };
  const levels = [];
  for (const leveling of [false, true]) {
    const { out } = await render(12, 2, program, { soundDelayMs: 0, leveling });
    const data = out.getChannelData(0);
    let peak = 0, atFullScale = 0;
    for (const x of data) { peak = Math.max(peak, Math.abs(x)); if (Math.abs(x) >= 1) atFullScale++; }
    levels.push({ leveling, peak, samplesAtOrAboveFullScale: atFullScale,
      quietDb: rms(data, 1, 4), loudDb: rms(data, 5, 8), quietToLoudDb: rms(data, 5, 8) - rms(data, 1, 4) });
  }
  // Six channels, each with its own impulse: which still carry sound after the chain.
  const channels = [];
  for (const leveling of [false, true]) {
    const { out } = await render(1, 6, (data, c) => { data[at / 2 + c * 100] = 1; }, { soundDelayMs: 40, leveling }, 6);
    const onsets = [...Array(6).keys()].map(c => onset(out.getChannelData(c)));
    for (let c = 0; c < 6; c++) {
      const expected = at / 2 + c * 100 + (40 + (leveling ? lookaheadMs : 0)) * rate / 1000;
      if (Math.abs(onsets[c] - expected) > toleranceSamples) throw new Error("Channel timing or identity lost: " + JSON.stringify(onsets));
    }
    channels.push({ leveling, carrying: onsets.filter(i => i >= 0).length, onsets });
  }
  // A centre-only 5.1 source must reach both stereo speakers equally, including with leveling.
  const stereoCentre = [];
  for (const leveling of [false, true]) {
    const { out } = await render(1, 6, (data, c) => { if (c === 2) data[at] = 0.01; }, { soundDelayMs: 40, leveling }, 2);
    const left = out.getChannelData(0), right = out.getChannelData(1);
    const onsets = [onset(left), onset(right)];
    const peaks = [left, right].map(data => data.reduce((peak, x) => Math.max(peak, Math.abs(x)), 0));
    const expected = at + (40 + (leveling ? lookaheadMs : 0)) * rate / 1000;
    const mismatch = left.some((x, i) => Math.abs(x - right[i]) > 0.000001);
    if (mismatch || peaks.some(x => x < 0.001 || x >= 1) || onsets.some(i => Math.abs(i - expected) > toleranceSamples))
      throw new Error("Stereo centre dialogue lost, unbalanced or mistimed: " + JSON.stringify({ leveling, peaks, onsets, mismatch }));
    // The unprocessed speaker downmix of centre is sqrt(0.5) in each side (Web Audio speaker rules).
    if (!leveling && peaks.some(x => Math.abs(x - Math.SQRT1_2 * 0.01) > 0.000001))
      throw new Error("Unexpected centre speaker downmix: " + JSON.stringify(peaks));
    stereoCentre.push({ leveling, peaks, onsets, mismatch });
  }
  const flushes = [];
  for (const leveling of [false, true]) {
    const context = new OfflineAudioContext(2, rate * 2, rate);
    const buffer = context.createBuffer(2, rate * 2, rate);
    for (let c = 0; c < 2; c++) { buffer.getChannelData(c)[rate / 4] = 1; buffer.getChannelData(c)[rate * 3 / 4] = 1; }
    const source = new AudioBufferSourceNode(context, { buffer });
    const chain = soundChain(context, source);
    chain.set({ soundDelayMs: 200, leveling });
    chain.output.connect(context.destination);
    source.start();
    const suspended = context.suspend(0.3);
    const rendering = context.startRendering();
    await suspended;
    chain.flush();
    await context.resume();
    const out = await rendering;
    const data = out.getChannelData(0);
    const stale = data.slice(Math.ceil(0.3 * rate), Math.floor(0.9 * rate)).some(x => Math.abs(x) > 0.001);
    const freshAt = onset(data);
    if (stale || Math.abs(freshAt - (0.95 + (leveling ? lookaheadMs / 1000 : 0)) * rate) > toleranceSamples)
      throw new Error("Flush replayed stale sound or lost fresh sound");
    flushes.push({ leveling, stale, freshAt });
  }
  const cost = [];
  for (const leveling of [false, true]) {
    const { ms } = await render(60, 2, program, { soundDelayMs: 200, leveling });
    cost.push({ leveling, secondsRendered: 60, renderMs: ms, timesRealtime: 60000 / ms });
  }
  for (const t of timing) {
    const expected = t.soundDelayMs + (t.leveling ? lookaheadMs : 0);
    if (t.measuredMs === null || Math.abs(t.measuredMs - expected) > 1)
      throw new Error("Impulse delay outside 1 ms: " + JSON.stringify(t));
  }
  const plain = levels.find(x => !x.leveling), leveled = levels.find(x => x.leveling);
  if (!leveled || !plain || leveled.peak <= 0 || leveled.peak >= 1 || leveled.samplesAtOrAboveFullScale !== 0 || leveled.quietToLoudDb >= plain.quietToLoudDb - 5)
    throw new Error("Leveling missing, clipping or ineffective: " + JSON.stringify(levels));
  if (channels.some(c => c.carrying !== 6)) throw new Error("Channel loss: " + JSON.stringify(channels));
  if (cost.some(c => !Number.isFinite(c.timesRealtime) || c.timesRealtime < 10)) throw new Error("Render cost exceeds 10% realtime: " + JSON.stringify(cost));
  return { sampleRate: rate, timing, levels, channels, stereoCentre, flushes, cost };
})()`;

/**
 * Chromium's Web Audio graph and the picture, after a channel, a title and its downloaded copy
 * started playing.
 */
export async function pictureSoundScenario(d: Driver, listen: () => Listen) {
  d.observed["pictureSoundLimits"] = [
    "Linux Xvfb development build, muted output; Web Audio graphs and offline renders prove routing, timing and level, not audible sound",
    "No native macOS or Windows, physical speakers, surround device, Bluetooth or receiver checks",
    "Adjustments set and reset through the player's Picture and sound controls; aspect is covered by the picture-fit contract test, not this journey",
  ];
  const graph: AudioGraph = { contexts: [], nodes: [], connections: 0 };

  const watchAudio = async () => {
    graph.contexts = [];
    graph.nodes = [];
    graph.connections = 0;
    const on = listen();
    on("WebAudio.contextCreated", (params) => {
      const context = (
        params as { context: { contextId: string; contextType: string; sampleRate: number } }
      ).context;

      graph.contexts.push({
        id: context.contextId,
        type: context.contextType,
        sampleRate: context.sampleRate,
      });
    });
    on("WebAudio.audioNodeCreated", (params) => {
      graph.nodes.push((params as { node: { nodeType: string } }).node.nodeType);
    });
    on("WebAudio.nodesConnected", () => {
      graph.connections++;
    });
    await d.send("WebAudio.enable");
  };

  const live = async () => {
    const [context] = graph.contexts.filter((each) => each.type === "realtime");

    if (!context) return null;

    const reply = (await d.send("WebAudio.getRealtimeData", { contextId: context.id })) as {
      realtimeData: Record<string, number>;
    };

    return reply.realtimeData;
  };

  // These are Chromium's reported route latencies, not an acoustic A/V measurement.
  const outputLatency = async () => {
    const prototype = (await d.send("Runtime.evaluate", {
      expression: "AudioContext.prototype",
    })) as { result: { objectId: string } };

    const objects = (await d.send("Runtime.queryObjects", {
      prototypeObjectId: prototype.result.objectId,
    })) as { objects: { objectId: string } };

    try {
      const result = (await d.send("Runtime.callFunctionOn", {
        objectId: objects.objects.objectId,
        functionDeclaration:
          "function() { return this.map(c => ({ state: c.state, baseLatency: c.baseLatency, outputLatency: c.outputLatency, timestamp: c.getOutputTimestamp() })); }",
        returnByValue: true,
      })) as {
        result: {
          value: {
            state: string;
            baseLatency: number;
            outputLatency: number;
            timestamp: { contextTime: number; performanceTime: number };
          }[];
        };
      };

      for (const c of result.result.value) {
        if (
          ![
            c.baseLatency,
            c.outputLatency,
            c.timestamp.contextTime,
            c.timestamp.performanceTime,
          ].every((n) => Number.isFinite(n) && n >= 0)
        )
          throw new Error("Invalid reported output latency");
      }

      return result.result.value;
    } finally {
      await d.send("Runtime.releaseObject", { objectId: objects.objects.objectId });
      await d.send("Runtime.releaseObject", { objectId: prototype.result.objectId });
    }
  };

  /** The video against the box `picture-fit.ts` gives its frame in the picture's area. */
  const picture = () =>
    d.evaluate<{
      frame: { width: number; height: number };
      area: { width: number; height: number };
      box: { left: number; top: number; width: number; height: number };
      time: number;
      frames: number;
      paused: boolean;
      clip: string;
    }>(`(() => {
      const v = document.querySelector('video'), area = v.parentElement.getBoundingClientRect(), box = v.getBoundingClientRect();
      return { frame: { width: v.videoWidth, height: v.videoHeight }, area: { width: area.width, height: area.height },
        box: { left: box.left - area.left, top: box.top - area.top, width: box.width, height: box.height },
        clip: getComputedStyle(v).clipPath, time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused };
    })()`);

  const playing = async (name: string, adjustments: PlaybackAdjustments | null) => {
    const before = await picture();
    await d.wait(async () => {
      const now = await picture();

      return (
        !now.paused &&
        now.frame.width > 0 &&
        now.frames > before.frames + 10 &&
        now.time > before.time + 1
      );
    }, 60_000);
    const now = await picture();

    // Independent fixture geometry: every source is 16:9, crop keeps its central 4:3,
    // then zoom is 150%. Do not reuse the production placement calculation here.
    if (adjustments && Math.abs(now.frame.width / now.frame.height - 16 / 9) > 0.01)
      throw new Error(`${name}: fixture is no longer 16:9`);
    const h = Math.min(now.area.height, (now.area.width * 3) / 4) * 1.5;
    const w = (h * 16) / 9;

    const expected = adjustments
      ? { left: (now.area.width - w) / 2, top: (now.area.height - h) / 2, width: w, height: h }
      : null;

    if (adjustments) {
      const clip = now.clip.match(/[\d.]+/g)?.map(Number);

      if (!clip || Math.abs(clip[0]!) > 0.5 || Math.abs(clip[1]! - w / 8) > 0.5)
        throw new Error(`${name}: missing central crop clip: ${now.clip}`);
    }

    const placed =
      expected === null ||
      (["left", "top", "width", "height"] as const).every(
        (side) => Math.abs(now.box[side] - expected[side]) < 1,
      );

    if (!placed)
      throw new Error(
        `${name}: picture at ${JSON.stringify(now.box)}, expected ${JSON.stringify(expected)}`,
      );
    // The element's clock keeps pace with the wall clock while sound takes its route.
    const began = Date.now();
    await d.wait(async () => (await picture()).time > now.time + 6, 30_000);

    const paced = {
      mediaSeconds: (await picture()).time - now.time,
      wallSeconds: (Date.now() - began) / 1000,
    };

    if (Math.abs(paced.mediaSeconds - paced.wallSeconds) > 1)
      throw new Error(`${name}: media clock drift exceeds one second: ${JSON.stringify(paced)}`);
    const latency = await outputLatency();
    const realtime = await live();
    const sources = graph.nodes.filter((node) => node === "MediaElementAudioSource").length;

    if (adjustments || name === "offline-reset") {
      if (
        graph.contexts.length !== 1 ||
        sources !== 1 ||
        latency.length !== 1 ||
        latency[0]?.state !== "running"
      )
        throw new Error(`${name}: expected one running routed element`);

      if (
        !realtime ||
        !Number.isFinite(realtime["renderCapacity"]) ||
        realtime["renderCapacity"]! >= 0.5
      )
        throw new Error(`${name}: audio render capacity missing or above 50%`);
    }

    d.observed[name] = {
      picture: now,
      expected: expected && { ...expected },
      paced,
      graph: {
        contexts: [...graph.contexts],
        nodes: [...graph.nodes],
        connections: graph.connections,
      },
      realtime,
      latency,
    };
    await d.capture(name);
  };

  // The player hides its bar while it plays untouched; a viewer moves the pointer first.
  let moves = 0;

  const wake = async () => {
    for (const x of [300, 340])
      await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + moves++, y: 500 });
  };

  const menu = (selector: string) =>
    `document.querySelector(${JSON.stringify(`[role=dialog] ${selector}`)})`;

  /** Presses `step` in the open panel until its row reads `value`, as a viewer does. */
  const stepTo = async (row: string, step: string, value: string) => {
    const reads = `${menu(`[role=group][aria-label="${row}"] [aria-live]`)}?.textContent === ${JSON.stringify(value)}`;

    for (let presses = 0; !(await d.exists(reads)); presses++) {
      if (presses > 40) throw new Error(`${row} never read ${value}`);
      await d.click(`${step} in ${row}`, menu(`button[aria-label="${step}"]`));
    }
  };

  const pick = (group: string, choice: string) =>
    d.click(
      `${choice} in ${group}`,
      menu(`[role=radiogroup][aria-label="${group}"] [aria-label="${choice}"]`),
    );

  /** Sets `ADJUSTED` in Live TV's More > Picture and sound and closes the menu. */
  const adjustInMore = async () => {
    await wake();
    await d.click("Open More", "document.querySelector('button[aria-label=\"More\"]')");
    await d.click("Open Picture and sound", menu('button[data-live-page="picture"]'));
    await stepTo("Sound delay", "Sound later", `${ADJUSTED.soundDelayMs} ms`);
    await pick("Leveling", "On");
    await pick("Crop", ADJUSTED.crop);
    await stepTo("Zoom", "Zoom In", `${ADJUSTED.zoom}%`);
    const overflow = await d.evaluate<string[]>(PANEL_OVERFLOW);

    if (overflow.length > 0)
      throw new Error(`Picture and sound rows overflow: ${overflow.join(", ")}`);
    await d.capture("picture-sound-panel");
    await d.key("Escape", 27);
    await d.wait(async () => !(await d.exists("document.querySelector('[role=dialog]')")));
  };

  const channel = async (name: string, stage: string, adjustments: PlaybackAdjustments | null) => {
    // From Watch, Back first: its bar hides while the picture plays.
    if (await d.exists("document.querySelector('[data-live-timeline]')")) {
      await wake();
      await d.key("Escape", 27);
      await d.wait(async () => !(await d.exists("document.querySelector('[data-live-timeline]')")));
    }

    await d.click("Open Search", "document.querySelector('button[aria-label=\"Search\"]')");
    await d.send("Input.insertText", { text: name });
    await d.wait(() =>
      d.exists("document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')"),
    );
    await d.key("Enter", 13);
    await playing(stage, adjustments);
  };

  const title = async (stage: string, adjustments: PlaybackAdjustments | null) => {
    await wake();
    await d.key("Escape", 27);
    await d.click("Open Movies", button("header button", "Movies"));
    await d.click("Open All movies", button("nav button", "All movies"));
    await d.click(
      "Open the two-track movie",
      "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))",
    );
    await d.click("Play the movie", button('[role="dialog"] button', "Play"));
    await d.wait(() => d.exists("document.querySelector('[data-view=title] video')"), 60_000);
    await playing(stage, adjustments);
    await d.evaluate(
      "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
    );
    await d.click(
      "Open Sound",
      "document.querySelector('[data-view=title] button[aria-label=Sound]')",
    );
    await d.click(
      "Switch to the Spanish sound track",
      "[...document.querySelectorAll('button[data-item]')].find(b => b.textContent.includes('Español'))",
    );
    await playing(`${stage}-switched-track`, adjustments);
  };

  // As the stream comes: Chromium plays the element itself, with no Web Audio at all.
  await watchAudio();
  await channel("H.264 + AAC", "direct-unadjusted", null);

  if (graph.contexts.length > 0) throw new Error("Unadjusted playback opened Web Audio.");
  // Set while the channel plays: they apply at once, and are saved for the next start.
  await adjustInMore();
  await playing("direct-adjusted-at-once", ADJUSTED);
  await d.quit();

  const path = join(d.profile, "preferences.json");

  const savedAdjustments = async () =>
    (JSON.parse(await readFile(path, "utf8")) as { playbackAdjustments?: Json })
      .playbackAdjustments;

  d.observed["savedAfterPanel"] = (await savedAdjustments()) ?? null;

  if (JSON.stringify(d.observed["savedAfterPanel"]) !== JSON.stringify(ADJUSTED))
    throw new Error("Panel choices did not persist");
  await d.launch();
  await watchAudio();
  await channel("H.264 + AAC", "direct-adjusted", ADJUSTED);
  await channel("H.264 + MP2", "converted-adjusted", ADJUSTED);
  await title("title-adjusted", ADJUSTED);
  // The downloaded copy, which plays from this computer's file. Back from the title is its details.
  await wake();
  await d.key("Escape", 27);
  await d.click("Download the movie", button('[role="dialog"] button', "Download"));
  await d.wait(() => d.exists(button('[role="dialog"] button', "Watch offline")), 120_000);
  await d.click("Watch offline", button('[role="dialog"] button', "Watch offline"));
  await d.wait(() => d.exists("document.querySelector('[data-view=title] video')"), 60_000);
  await playing("offline-adjusted", ADJUSTED);
  const sources = graph.nodes.filter((node) => node === "MediaElementAudioSource").length;

  if (graph.contexts.length !== 1 || sources !== 1)
    throw new Error(`Expected one context and one routed element, saw ${JSON.stringify(graph)}`);

  // Reset from the title's menu, with the keyboard: End reaches Reset, Enter presses it. The
  // picture fills its area again at once; the routed element retains output latency until the
  // window closes, and the next start plays as the stream comes, with no route at all.
  await d.evaluate(
    "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  await d.click(
    "Open Picture and sound",
    "document.querySelector('[data-view=title] button[aria-label=\"Picture and sound\"]')",
  );

  // Browser Tab traversal must leave the first step backwards and return forwards.
  for (const label of ["Sound sooner", "Zoom Out"]) {
    await d.evaluate(
      `document.querySelector('[role="dialog"] button[aria-label="${label}"]').focus()`,
    );
    await d.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    });
    await d.wait(() =>
      d.exists(
        `!document.querySelector('[role="dialog"] button[aria-label="${label}"]').closest('[role="group"]').contains(document.activeElement)`,
      ),
    );
    await d.key("Tab", 9);
    await d.wait(() =>
      d.exists(`document.activeElement?.getAttribute('aria-label') === '${label}'`),
    );
  }

  await d.key("End", 35);
  await d.wait(() => d.exists("document.activeElement?.textContent === 'Reset'"));
  await d.key("Enter", 13);
  await d.wait(() =>
    d.exists(
      "[...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent === 'Reset' && b.getAttribute('aria-disabled') === 'true')",
    ),
  );
  await d.key("Escape", 27);
  await playing("offline-reset", null);
  const reset = await picture();

  if (
    Math.abs(reset.box.width - reset.area.width) >= 1 ||
    Math.abs(reset.box.height - reset.area.height) >= 1
  )
    throw new Error(`After Reset the picture is ${JSON.stringify(reset.box)}, not its area`);
  await d.quit();
  d.observed["savedAfterReset"] = (await savedAdjustments()) ?? null;

  if (
    JSON.stringify(d.observed["savedAfterReset"]) !== JSON.stringify(DEFAULT_PLAYBACK_ADJUSTMENTS)
  )
    throw new Error(`Reset saved ${JSON.stringify(d.observed["savedAfterReset"])}`);
  await d.launch();
  await watchAudio();
  await channel("H.264 + AAC", "direct-after-reset", null);

  if (graph.contexts.length > 0) throw new Error("Playback after Reset opened Web Audio.");

  d.action("Render synthetic signals through the bundled sound chain in the window");
  await d.evaluate(await bundledChain());
  d.observed["soundMeasurements"] = await d.evaluate<Json>(MEASURE);
}
