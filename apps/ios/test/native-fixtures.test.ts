import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catchUpPlaylist } from "../scripts/native-fixtures/catch-up.ts";

// The simulator fixture (scripts/fixture-server.ts) as native verification journeys reach it: its
// panel through core's Xtream adapter, its media through ffprobe, and its control port, run as a
// command in a session directory of its own.

const login = { username: "fixture", password: "fixture-pass" };
const root = join(import.meta.dirname, "../../..");
const MINUTE = 60_000;

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every byte of `url` that arrives, and whether the answer broke off before its end. */
function download(url: string, headers: Record<string, string> = {}, agent?: Agent) {
  return new Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: Buffer;
    broke: boolean;
  }>((resolve, reject) => {
    request(url, { headers, agent }, (response) => {
      const chunks: Buffer[] = [];
      let broke = false;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("aborted", () => (broke = true));
      response.on("error", () => (broke = true));
      response.on("close", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          broke: broke || !response.complete,
        }),
      );
    })
      .on("error", reject)
      .end();
  });
}

describe("the native verification fixture", () => {
  let server: ChildProcess;
  let out: string;
  let panel: string;
  let control: string;
  const provider = () =>
    xtreamProvider({ server: panel, ...login }, { userAgent: "fixture", live: "hls" });
  const post = (route: string) => fetch(`${control}${route}`, { method: "POST" });
  const text = async (url: string) => (await fetch(url)).text();

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "native-fixture-"));
    const [port, controlPort] = [await freePort(), await freePort()];
    panel = `http://127.0.0.1:${port}`;
    control = `http://127.0.0.1:${controlPort}`;
    // The default fixture, whatever FIXTURE_ settings the shell running the tests has.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("FIXTURE_")),
    );
    server = spawn(
      process.execPath,
      [join(root, "apps/ios/scripts/fixture-server.ts"), String(port), String(controlPort)],
      {
        env: { ...env, FIXTURE_OUT: out, FIXTURE_TITLES: "30" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("exit", (code) => reject(new Error(`fixture server exited with ${code}`)));
      server.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("fixture panel")) resolve();
      });
    });
  }, 300_000);
  afterAll(async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await exited;
    }
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("lists a Live channel whose English and Dutch sound and subtitles a player can choose", async () => {
    const { channels } = await provider().liveCatalogue();
    const tracks = channels.find((channel) => channel.name.includes("Live sound and subtitles"));
    expect(tracks).toMatchObject({ id: "7999", categoryIds: ["1"] });

    const { url } = await provider().liveStream("7999");
    const probed = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name:stream_tags=language",
          "-of",
          "json",
          url,
        ],
        { encoding: "utf8", timeout: 60_000 },
      ),
    ) as { streams: { codec_type: string; codec_name: string; tags?: { language?: string } }[] };
    expect(
      probed.streams.map((each) =>
        `${each.codec_type} ${each.codec_name} ${each.tags?.language ?? ""}`.trim(),
      ),
    ).toEqual(expect.arrayContaining(["video h264", "audio aac en", "audio aac nl"]));
    // ffprobe 6.1, which CI installs, leaves HLS subtitles out, so they are followed as listed.
    const listed = await text(url);
    expect(listed).toMatch(/#EXT-X-STREAM-INF:.*SUBTITLES="subtitles"/);
    for (const [language, name] of [
      ["en", "English"],
      ["nl", "Nederlands"],
    ]) {
      const declared = new RegExp(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",.*LANGUAGE="${language}".*URI="([^"]+)"`,
      ).exec(listed)?.[1];
      const playlist = new URL(declared ?? "", url);
      const segment = /^[^#\s].*$/m.exec(await text(playlist.href))?.[0];
      const cues = await text(new URL(segment ?? "", playlist).href);
      expect(cues).toMatch(/^WEBVTT\n/);
      expect(cues).toMatch(new RegExp(`\n${name} \\d+:\\d{2}\n`));
    }

    // Each rendition lists the same segments, so a switch lands where the picture is.
    const sequences = await Promise.all(
      ["picture", "sound-en", "sound-nl", "subtitles-en", "subtitles-nl"].map(
        async (rendition) =>
          /MEDIA-SEQUENCE:(\d+)/.exec(await text(`${panel}/hls/7999/${rendition}.m3u8`))?.[1],
      ),
    );
    // Fetched apart, they can straddle a new segment.
    const numbers = sequences.map(Number);
    expect(Math.max(...numbers) - Math.min(...numbers)).toBeLessThanOrEqual(1);
    const dutch = await text(`${panel}/hls/7999/subtitles-nl/6.vtt`);
    expect(dutch).toMatch(/X-TIMESTAMP-MAP=MPEGTS:\d+,LOCAL:00:00:00\.000/);
    expect(dutch).toContain("00:00:12.250 --> 00:00:13.750\nNederlands 0:12");
  }, 90_000);

  it("answers catch-up as HLS recordings of programmes within the days kept, never as Live", async () => {
    const now = Date.now();
    /** The catch-up playlist of `channel` from `start` to `end`, at the HLS address core makes. */
    const past = async (channel: string, start: number, end: number) => {
      const { url, format } = await provider().archiveStream(channel, { start, end });
      expect(format).toBe("hls");
      return fetch(url);
    };
    const seconds = (playlist: string) =>
      [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, [, each]) => sum + Number(each), 0);

    const aired = Math.floor((now - 2 * 60 * MINUTE) / MINUTE) * MINUTE;
    const ended = await past("1000", aired, aired + 30 * MINUTE);
    expect(ended.status).toBe(200);
    const whole = await ended.text();
    expect(whole).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(whole).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(aired).toISOString()}`);
    expect(whole.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(seconds(whole)).toBeGreaterThanOrEqual(30 * 60);

    // Started over: what has aired so far, growing until the programme ends.
    const started = Math.floor((now - 3 * MINUTE) / MINUTE) * MINUTE;
    const running = await (await past("1000", started, started + 60 * MINUTE)).text();
    expect(running).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(running).not.toContain("#EXT-X-ENDLIST");
    expect(seconds(running)).toBeGreaterThan(2 * 60);
    expect(seconds(running)).toBeLessThanOrEqual((Date.now() - started) / 1000);
    const segment = /^\/hls\/.*$/m.exec(running)?.[0] ?? "";
    expect(segment).toMatch(/^\/hls\/1000\/past\/\d+\.ts$/);
    expect((await fetch(`${panel}${segment}`)).status).toBe(200);
    expect(await (await fetch(`${control}/past`)).json()).toContain("1000");
    expect(await (await fetch(`${control}/live`)).json()).not.toContain("1000");

    // A channel without catch-up, a programme older than the days kept and one yet to start.
    expect((await past("1001", aired, aired + 30 * MINUTE)).status).toBe(404);
    expect(
      (await past("1000", now - 4 * 24 * 60 * MINUTE, now - 4 * 24 * 60 * MINUTE + 30 * MINUTE))
        .status,
    ).toBe(404);
    expect((await past("1000", now + 60 * MINUTE, now + 90 * MINUTE)).status).toBe(404);

    // A failing panel, then the same programme again.
    await post("/fail-live?id=1000&count=1");
    expect((await past("1000", aired, aired + 30 * MINUTE)).status).toBe(503);
    expect((await past("1000", aired, aired + 30 * MINUTE)).status).toBe(200);
  }, 60_000);

  it("sends title files at a pace, breaks one off, resumes it, and restarts one that changed", async () => {
    const { movies } = await provider().onDemandCatalogue();
    const movie = movies.find((each) => !each.name.startsWith("TEST"));
    if (!movie?.container) throw new Error("no movie");
    const { url } = await provider().titleFile("movie", movie.id, movie.container);
    const whole = await download(url);
    expect(whole).toMatchObject({ status: 200, broke: false });
    const etag = String(whole.headers["etag"]);

    expect((await post("/title-transfers?drop=100000")).status).toBe(200);
    // A player's first look at a file, ending before the drop, leaves it for the transfer.
    expect(await download(url, { Range: "bytes=0-1" })).toMatchObject({
      status: 206,
      broke: false,
    });
    const broken = await download(url);
    expect(broken).toMatchObject({ status: 200, broke: true });
    expect(broken.body.length).toBe(100_000);

    const resumed = await download(url, { Range: "bytes=100000-", "If-Range": etag });
    expect(resumed.status).toBe(206);
    expect(resumed.headers["content-range"]).toBe(
      `bytes 100000-${whole.body.length - 1}/${whole.body.length}`,
    );
    expect(sha256(Buffer.concat([broken.body, resumed.body]))).toBe(sha256(whole.body));
    const logged = (await (await fetch(`${control}/requests`)).json()) as {
      kind: string;
      range?: string;
    }[];
    expect(logged).toContainEqual(
      expect.objectContaining({ kind: "title", range: "bytes=100000-" }),
    );

    // A range that ends before it starts is ignored, as HTTP has it.
    const reversed = await download(url, { Range: "bytes=20-10" });
    expect(reversed).toMatchObject({ status: 200, broke: false });
    expect(reversed.body.length).toBe(whole.body.length);

    await post(`/title-transfers?replace=movie/${movie.id}`);
    const changed = await download(url, { Range: "bytes=100000-", "If-Range": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers["etag"]).not.toBe(etag);
    expect(changed.body.length).toBe(whole.body.length);

    await post("/title-transfers?rate=262144");
    const at = Date.now();
    const paced = await download(url, { Range: "bytes=0-524287" });
    expect(paced.body.length).toBe(524_288);
    expect(Date.now() - at).toBeGreaterThanOrEqual(1_500);
    // A range within one piece arrives at the pace too, rather than at once. Each check gets a
    // connection of its own, so it waits only for its own bytes.
    await post("/title-transfers?rate=65536");
    const single = Date.now();
    expect((await download(url, { Range: "bytes=0-32767" }, new Agent())).body.length).toBe(32_768);
    expect(Date.now() - single).toBeGreaterThanOrEqual(400);
    // A break under a pace comes once the bytes before it have taken their time.
    await post("/title-transfers?drop=32768");
    const breaking = Date.now();
    expect(await download(url, {}, new Agent())).toMatchObject({
      broke: true,
      body: { length: 32_768 },
    });
    expect(Date.now() - breaking).toBeGreaterThanOrEqual(400);
    // A slow pace holds a short probe only for its own two bytes, so the connection is free again.
    await post("/title-transfers?rate=1024");
    const probed = Date.now();
    const connection = new Agent({ keepAlive: true, maxSockets: 1 });
    for (const _ of [1, 2]) {
      expect(await download(url, { Range: "bytes=0-1" }, connection)).toMatchObject({
        status: 206,
        broke: false,
      });
    }
    connection.destroy();
    // Well under the 64 seconds a full piece's wait held each probe for.
    expect(Date.now() - probed).toBeLessThan(10_000);
    await post("/title-transfers?rate=0");
  }, 60_000);

  it("declares the source, commands and hashes of every piece of media it serves", async () => {
    const declared = (await (await fetch(`${control}/provenance`)).json()) as {
      source: { commit: string | null };
      artifacts: {
        inputs: ({ lavfi: string } | { file: string; sha256: string })[];
        command: string[] | string;
        files: { sha256: string }[];
      }[];
    };
    expect(declared.source.commit).toBe(
      execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    expect(JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"))).toEqual(declared);
    for (const { inputs } of declared.artifacts) {
      for (const input of inputs) {
        if ("file" in input) {
          expect(input.file).toMatch(/^apps\/desktop\/test\/fixtures\//);
          expect(sha256(readFileSync(join(root, input.file)))).toBe(input.sha256);
        }
      }
    }
    const hashes = new Set(
      declared.artifacts.flatMap(({ files }) => files.map((file) => file.sha256)),
    );
    // A TEST movie's clip, which the server sends as the repository has it.
    const { movies } = await provider().onDemandCatalogue();
    const clip = movies.find((each) => each.name === "TEST | Index at the end (NL)");
    if (!clip?.container) throw new Error("no TEST movie");
    const { url } = await provider().titleFile("movie", clip.id, clip.container);
    for (const path of [
      "/hls/7999/subtitles-nl/0.vtt",
      "/hls/7999/sound-nl/0.ts",
      "/hls/1000/past/0.ts",
      "/hls/2014/0.ts",
      url.slice(panel.length),
    ]) {
      expect([...hashes]).toContain(
        sha256(Buffer.from(await (await fetch(`${panel}${path}`)).arrayBuffer())),
      );
    }
  });
});

describe("catch-up around the panel's clock changes", () => {
  const media = { dir: "", segments: [{ file: "000.ts", seconds: 2 }] };
  /** Where the recording of half an hour from `start` begins, asked for at `now`, if anywhere. */
  const begins = (start: string, now: string) =>
    /PROGRAM-DATE-TIME:(\S+)/.exec(
      catchUpPlaylist({ id: "1000", days: 3, media }, 30, start, Date.parse(now)) ?? "",
    )?.[1] ?? null;

  it("takes a time the clock shows twice as the first, and refuses one it skips or no calendar has", () => {
    // Amsterdam goes back from 03:00 to 02:00 on 25 October 2026, and forward on 29 March.
    expect(begins("2026-10-25:02-30", "2026-10-25T01:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(begins("2026-03-29:02-30", "2026-03-29T05:00:00Z")).toBeNull();
    expect(begins("2026-03-29:03-30", "2026-03-29T05:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    expect(begins("2026-02-30:12-00", "2026-03-02T13:00:00Z")).toBeNull();
    expect(begins("2026-03-01:24-00", "2026-03-02T13:00:00Z")).toBeNull();
  });
});
