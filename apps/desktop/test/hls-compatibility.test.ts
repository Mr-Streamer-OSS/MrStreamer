import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { Playback } from "../src/main/services/playback.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeHls } from "./fake-hls.ts";
import { promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";
import { fixture } from "./fake-provider.ts";

const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const dispose: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});
async function app() {
  const host = await startFakeHls();
  dispose.push(() => host.close());
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: FFMPEG, ffprobe: FFPROBE }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir: await tempDir(),
          secrets: testSecrets,
          providerOptions: { userAgent },
        }),
      ),
    ),
  );
  dispose.push(() => runtime.dispose());
  const subscription = await (
    await promised(runtime, Subscriptions)
  ).add({ server: host.link, username: "", password: "" });
  const playback = await promised(runtime, Playback);
  const channel = (name: string) => ({ subscriptionId: subscription.id, id: `${name}.test` });
  return { host, playback, channel };
}

function decoded(bytes: Buffer) {
  const decode = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
    { input: bytes, encoding: "utf8" },
  );
  expect(decode.status, decode.stderr).toBe(0);
  const probe = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_streams", "-show_packets", "-of", "json", "pipe:0"],
    { input: bytes, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout) as {
    streams: { codec_name: string; codec_type: string; id: string; tags?: { language?: string } }[];
    packets: { codec_type: string; pts_time?: string; dts_time?: string }[];
  };
}

it("keeps compatible local HLS lazy and byte-preserving", async () => {
  const { host, playback, channel } = await app();
  const session = await playback.open(channel("compatible"), ["h264", "aac"]);
  expect(session.format).toBe("hls");
  expect(host.requests().filter((path) => path.startsWith("/media/"))).toEqual([]);
  const playlist = await (await fetch(session.url)).text();
  const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"))!;
  expect(Buffer.from(await (await fetch(segment)).arrayBuffer())).toEqual(
    fixture("h264-aac.mpegts"),
  );
  await playback.close(session.sessionId);
  expect((await fetch(segment)).status).toBe(410);
});

it("converts ordered epochs with changed PIDs/PCR/codecs, stable selected sound and supported subtitles", async () => {
  const { host, playback, channel } = await app();
  const session = await playback.open(channel("epochs"), ["h264", "aac"], {
    repair: true,
    audioLanguage: "nl",
  });
  expect(session.format).toBe("mpegts");
  const answer = await fetch(session.url);
  expect(answer.status).toBe(200);
  const output = decoded(Buffer.from(await answer.arrayBuffer()));
  expect(output.streams.find((stream) => stream.codec_type === "video")?.codec_name).toBe("h264");
  const audio = output.streams.filter((stream) => stream.codec_type === "audio");
  expect(audio).toHaveLength(1);
  expect(audio[0]).toMatchObject({ codec_name: "aac", id: "0x102", tags: { language: "dut" } });
  expect(
    output.streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => stream.codec_name),
  ).toEqual(expect.arrayContaining(["dvb_subtitle", "dvb_teletext"]));
  const video = output.packets
    .filter((packet) => packet.codec_type === "video")
    .map((packet) => Number(packet.pts_time));
  expect(Math.max(...video) - Math.min(...video)).toBeGreaterThan(23);
  // Presentation may reorder inside a GOP. Compare each six-second epoch's observed range.
  for (const time of [7, 13, 19])
    expect(video.some((pts) => pts > time && pts < time + 1)).toBe(true);
  expect(host.stats().peak).toBe(1);
  expect(host.requests().filter((path) => /epochs-\d.ts/.test(path))).toEqual(
    [0, 1, 2, 3].map((index) => `/media/epochs-${index}.ts`),
  );
  expect(await playback.failure(session.sessionId)).toBeNull();
}, 20_000);

it("carries the archive stop window across the same PID/PCR-changing discontinuity with bounded provider bytes", async () => {
  const { host, playback, channel } = await app();
  const start = Math.floor((Date.now() - 60000) / 1000) * 1000;
  const session = await playback.open(channel("archive"), ["h264", "aac"], {
    repair: true,
    archive: { start, end: start + 8000 },
  });
  const output = decoded(Buffer.from(await (await fetch(session.url)).arrayBuffer()));
  const times = output.packets
    .filter((packet) => packet.codec_type === "video")
    .map((packet) => Number(packet.pts_time));
  expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(7);
  expect(Math.max(...times) - Math.min(...times)).toBeLessThan(10);
  expect(host.requests().filter((path) => /archive-\d.ts/.test(path))).toEqual([
    "/media/archive-0.ts",
    "/media/archive-1.ts",
  ]);
  expect(host.stats().bytes).toBeLessThanOrEqual(
    fixture("hls-epoch-0.mpegts").length + fixture("hls-epoch-1.mpegts").length,
  );
  expect(host.stats().active).toBe(0);
}, 20_000);

it.each([
  '#EXT-X-KEY:METHOD=AES-128,URI="key"',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXT-X-BYTERANGE:100@0",
  '#EXT-X-PART:DURATION=0.5,URI="part.ts"',
])(
  "preserves direct local/receiver passthrough and refuses only requested local repair for %s",
  async (tag) => {
    const { host, playback, channel } = await app();
    host.overrides.set("/media/compatible.m3u8", {
      body: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${tag}\n#EXTINF:6,\ncompatible-0.ts\n#EXT-X-ENDLIST\n`,
    });
    const local = await playback.open(channel("compatible"), ["h264", "aac"]);
    expect(local.format).toBe("hls");
    expect(await (await fetch(local.url)).text()).toContain(tag.split(":")[0]);
    await expect(
      playback.open(channel("compatible"), ["h264", "aac"], { repair: true }),
    ).rejects.toMatchObject({
      error: {
        kind: "stream",
        failure: {
          kind: "unsupported",
          diagnostic: { diagnostic_stage: "inspect", diagnostic_reason: "hls_subset_unsupported" },
        },
      },
    });
    const receiver = await playback.openReceiver(channel("compatible"), {
      address: "127.0.0.1",
      decoders: ["h264", "aac"],
    });
    expect(await (await fetch(receiver.url)).text()).toContain(tag.split(":")[0]);
    expect(host.requests().filter((path) => path.endsWith(".ts"))).toHaveLength(0);
  },
);

it("retains external audio receiver passthrough despite incompatible declared codecs", async () => {
  const { host, playback, channel } = await app();
  const receiver = await playback.openReceiver(channel("excluded"), {
    address: "127.0.0.1",
    decoders: ["h264", "aac"],
  });
  const master = await (await fetch(receiver.url)).text();
  expect(master).toContain("TYPE=AUDIO");
  expect(master).not.toContain(host.origin);
  await expect(
    playback.open(channel("excluded"), ["h264", "aac"], { repair: true }),
  ).rejects.toMatchObject({
    error: {
      failure: { kind: "unsupported", diagnostic: { diagnostic_reason: "hls_subset_unsupported" } },
    },
  });
});

it.each([401, 403, 404, 500])(
  "preserves the provider %i category during compatibility inspection",
  async (status) => {
    const { host, playback, channel } = await app();
    host.overrides.set("/media/epochs-0.ts", { status });
    await expect(
      playback.open(channel("epochs"), ["h264", "aac"], { repair: true }),
    ).rejects.toMatchObject({
      error: {
        kind: "stream",
        failure: {
          kind: status < 404 ? "refused" : status === 404 ? "unavailable" : "provider-error",
          status,
        },
      },
    });
  },
);

it("preconverts receiver AC-3 and preserves a continuous segment timeline across changed source epochs", async () => {
  const { host, playback, channel } = await app();
  const session = await playback.openReceiver(
    channel("epochs"),
    { address: "127.0.0.1", decoders: ["h264", "aac"] },
    { audioLanguage: "nl" },
  );
  const received = new Map<string, Buffer>();
  let final = "";
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    const response = await fetch(session.url);
    expect(response.status).toBe(200);
    final = await response.text();
    for (const line of final.split("\n").filter((line) => line && !line.startsWith("#"))) {
      const url = new URL(line, session.url).href;
      if (received.has(url)) continue;
      const segment = await fetch(url);
      expect(segment.status).toBe(200);
      received.set(url, Buffer.from(await segment.arrayBuffer()));
    }
    if (final.includes("#EXT-X-ENDLIST")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(final).toContain("#EXT-X-ENDLIST");
  expect(final).toContain("#EXT-X-DISCONTINUITY");
  const output = decoded(Buffer.concat([...received.values()]));
  expect(output.streams.find((stream) => stream.codec_type === "video")?.codec_name).toBe("h264");
  expect(output.streams.find((stream) => stream.codec_type === "audio")?.codec_name).toBe("aac");
  const times = output.packets
    .filter((packet) => packet.codec_type === "video")
    .map((packet) => Number(packet.pts_time));
  expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(12);
  for (let index = 1; index < times.length; index++)
    expect(times[index]! - times[index - 1]!).toBeGreaterThan(-0.1);
  expect(host.stats().peak).toBe(1);
  const oldSegment = received.keys().next().value!;
  await playback.close(session.sessionId);
  expect(host.stats().active).toBe(0);
  await expect(fetch(oldSegment)).rejects.toThrow();
}, 20_000);

it("replaces a converted session without exposing new-token resources or leaving an active reader", async () => {
  const { host, playback, channel } = await app();
  const old = await playback.open(channel("archive"), ["h264", "aac"], { repair: true });
  const response = await fetch(old.url);
  const reader = response.body!.getReader();
  expect((await reader.read()).value!.length).toBeGreaterThan(0);
  const replacement = await playback.open(channel("compatible"), ["h264", "aac"]);
  expect((await fetch(old.url)).status).toBe(410);
  expect(await playback.tracks(old.sessionId)).toBeNull();
  expect(replacement.url).not.toBe(old.url);
  await reader.cancel().catch(() => {});
  await playback.close(replacement.sessionId);
  expect(host.stats().active).toBe(0);
}, 20_000);

it("uses deterministic at-most-1080p master selection with exact provider headers", async () => {
  const { host, playback, channel } = await app();
  host.overrides.set("/media/epochs.m3u8", {
    body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=3840x2160\nnever.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\nnever2.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\nepochs-selected.m3u8\n",
  });
  const session = await playback.open(channel("epochs"), ["h264", "aac"], { repair: true });
  decoded(Buffer.from(await (await fetch(session.url)).arrayBuffer()));
  expect(host.requests().some((path) => path.includes("never"))).toBe(false);
}, 20_000);

it("polls one selected live playlist in sequence without a parallel adaptive reader", async () => {
  const { host, playback, channel } = await app();
  let polls = 0;
  host.overrides.set("/media/epochs.m3u8", {
    body: () => {
      const from = polls++ ? 1 : 0;
      return [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        `#EXT-X-MEDIA-SEQUENCE:${from}`,
        ...[from, from + 1, from + 2].flatMap((index) => ["#EXTINF:6,", `epochs-${index}.ts`]),
        ...(from ? ["#EXT-X-ENDLIST"] : []),
        "",
      ].join("\n");
    },
  });
  const session = await playback.open(channel("epochs"), ["h264", "aac"], { repair: true });
  decoded(Buffer.from(await (await fetch(session.url)).arrayBuffer()));
  expect(polls).toBe(2);
  expect(host.requests().filter((path) => /epochs-\d.ts/.test(path))).toEqual(
    [0, 1, 2, 3].map((index) => `/media/epochs-${index}.ts`),
  );
  expect(host.stats().peak).toBe(1);
}, 20_000);

it("accepts an explicit clear key reset without fetching a key", async () => {
  const { host, playback, channel } = await app();
  host.overrides.set("/media/epochs.m3u8", {
    body: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\nepochs-0.ts\n#EXT-X-ENDLIST\n",
  });
  const session = await playback.open(channel("epochs"), ["h264", "aac"], { repair: true });
  decoded(Buffer.from(await (await fetch(session.url)).arrayBuffer()));
}, 20_000);

it("keeps malformed playlists distinct from excluded conversion inputs", async () => {
  const { host, playback, channel } = await app();
  host.overrides.set("/media/epochs.m3u8", {
    body: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:NaN,\nepochs-0.ts\n",
  });
  await expect(
    playback.open(channel("epochs"), ["h264", "aac"], { repair: true }),
  ).rejects.toMatchObject({
    error: {
      failure: { kind: "unsupported", diagnostic: { diagnostic_reason: "malformed_input" } },
    },
  });
  expect(host.requests().some((path) => path.endsWith(".ts"))).toBe(false);
});

it("keeps picture and sound running when a declared subtitle stream supplies no packets", async () => {
  const { host, playback, channel } = await app();
  const source = fixture("hls-epoch-0.mpegts");
  const packets: Buffer[] = [];
  for (let offset = 0; offset + 188 <= source.length; offset += 188) {
    const pid = ((source[offset + 1]! & 31) << 8) | source[offset + 2]!;
    if (pid !== 259 && pid !== 260) packets.push(source.subarray(offset, offset + 188));
  }
  host.overrides.set("/media/epochs-0.ts", { body: Buffer.concat(packets) });
  const session = await playback.open(channel("epochs"), ["h264", "aac"], { repair: true });
  const output = decoded(Buffer.from(await (await fetch(session.url)).arrayBuffer()));
  expect(output.streams.some((stream) => stream.codec_type === "video")).toBe(true);
  expect(output.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
  expect(await playback.failure(session.sessionId)).toBeNull();
}, 20_000);

it("cancels a pending HLS inspection when another session replaces it", async () => {
  const { host, playback, channel } = await app();
  host.stalls.add("/media/epochs-0.ts");
  const pending = playback.open(channel("epochs"), ["h264", "aac"], { repair: true }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const deadline = performance.now() + 1500;
  while (!host.requests().includes("/media/epochs-0.ts") && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(host.requests()).toContain("/media/epochs-0.ts");
  const replacement = await playback.open(channel("compatible"), ["h264", "aac"]);
  expect(await pending).toHaveProperty("error");
  // The OS delivers the provider's close notification after cancellation settles in main.
  const closed = performance.now() + 500;
  while (host.stats().active && performance.now() < closed)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(host.stats().active).toBe(0);
  expect(replacement.format).toBe("hls");
  expect(host.requests().some((path) => path === "/media/epochs-1.ts")).toBe(false);
});

it("forwards excluded init, key and byte-range resources with auth on local and receiver paths", async () => {
  const { host, playback, channel } = await app();
  host.overrides.set("/media/compatible.m3u8", {
    body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-BYTERANGE:188@0\n#EXTINF:6,\ncompatible-0.ts\n#EXT-X-ENDLIST\n',
  });
  host.overrides.set("/media/key", { body: Buffer.alloc(16, 7) });
  host.overrides.set("/media/init.mp4", { body: Buffer.from("fixture-init") });
  host.overrides.set("/media/compatible-0.ts", {
    status: 206,
    headers: { "Content-Range": "bytes 0-187/1880" },
    body: Buffer.alloc(188, 0x47),
  });
  for (const receiver of [false, true]) {
    const session = receiver
      ? await playback.openReceiver(channel("compatible"), {
          address: "127.0.0.1",
          decoders: ["h264", "aac"],
        })
      : await playback.open(channel("compatible"), ["h264", "aac"]);
    const text = await (await fetch(session.url)).text();
    const uris = [...text.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]!);
    expect(uris).toHaveLength(2);
    const [key, init] = await Promise.all(
      uris.map(async (uri) => Buffer.from(await (await fetch(uri)).arrayBuffer())),
    );
    expect(key).toEqual(Buffer.alloc(16, 7));
    expect(init).toEqual(Buffer.from("fixture-init"));
    const segment = text.split("\n").find((line) => line && !line.startsWith("#"))!;
    const response = await fetch(new URL(segment, session.url), {
      headers: { Range: "bytes=0-187" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-187/1880");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(188, 0x47));
  }
  const ranges = host.resources.filter((resource) => resource.path === "/media/compatible-0.ts");
  expect(ranges).toHaveLength(2);
  expect(
    ranges.every(
      (resource) => resource.range === "bytes=0-187" && resource.agent === "HlsFixture/1.0",
    ),
  ).toBe(true);
});

it("classifies a dropped provider connection as network without a speculative repair retry", async () => {
  const { host, playback, channel } = await app();
  host.failures.add("/media/epochs-selected.m3u8");
  await expect(
    playback.open(channel("epochs"), ["h264", "aac"], { repair: true }),
  ).rejects.toMatchObject({ error: { failure: { kind: "network" } } });
  expect(host.requests().filter((path) => path === "/media/epochs-selected.m3u8")).toHaveLength(1);
});
