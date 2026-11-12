import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startFormats } from "./formats-server.ts";

let fixture: Awaited<ReturnType<typeof startFormats>>;
let out: string;

beforeAll(async () => {
  mkdirSync(resolve(".local/699"), { recursive: true });
  out = mkdtempSync(resolve(".local/699/http-"));
  fixture = await startFormats({ out });
}, 120000);

afterAll(async () => {
  await fixture?.close();

  if (out) rmSync(out, { recursive: true, force: true });
});

test("named titles use provider redirects and preserve range bytes; a held body resumes on recovery", async () => {
  const api = await fetch(
    `${fixture.url}/player_api.php?username=fixture&password=fixture-pass&action=get_vod_streams`,
  );

  const rows: { stream_id: number; name: string; container_extension: string }[] = await api.json();
  const movie = rows.find((row) => row.name === "native/h264-aac.mp4")!;
  expect(movie).toBeDefined();
  const url = `${fixture.url}/movie/fixture/fixture-pass/${movie.stream_id}.${movie.container_extension}`;
  const redirect = await fetch(url, { redirect: "manual" });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toMatch(/^\/files\//);
  const target = new URL(redirect.headers.get("location")!, fixture.url);
  const partial = await fetch(target, { headers: { Range: "bytes=0-31" } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toMatch(/^bytes 0-31\//);
  const first = new Uint8Array(await partial.arrayBuffer());
  expect(first.length).toBe(32);
  expect(Buffer.from(first).subarray(4, 8).toString()).toBe("ftyp");

  const conditions = (stalled: boolean) =>
    fetch(`${fixture.control}/link?startupMs=0&kbps=0&stalled=${stalled}`, { method: "POST" });

  expect((await conditions(true)).ok).toBe(true);
  const pending = fetch(target, { headers: { Range: "bytes=0-31" } });
  // Wait for the observed request, never a fixed startup sleep.
  await expect
    .poll(async () => (await (await fetch(`${fixture.control}/state`)).json()).held)
    .toBe(1);
  expect((await conditions(false)).ok).toBe(true);
  const recovered = await pending;
  expect(recovered.status).toBe(206);
  expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(first);
  await expect
    .poll(async () => (await (await fetch(`${fixture.control}/state`)).json()).active)
    .toBe(0);
});

test("a provider without byte ranges returns the complete title when the player asks for a part", async () => {
  const whole = await startFormats({ out: resolve(out, "whole"), noRanges: true });

  try {
    const movie = whole.files.find((file) => file.name === "native/h264-aac.mp4")!;

    const response = await fetch(`${whole.url}/movie/fixture/fixture-pass/${movie.id}.mp4`, {
      headers: { Range: "bytes=0-31" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBeGreaterThan(32);
    expect(body.subarray(4, 8).toString()).toBe("ftyp");
  } finally {
    await whole.close();
  }
}, 120000);

test("a native HLS title resolves its variant and segment on the same provider boundary", async () => {
  const movie = fixture.files.find((file) => file.name === "native/hls-ladder/index.m3u8")!;
  const response = await fetch(`${fixture.url}/movie/fixture/fixture-pass/${movie.id}.m3u8`);
  const master = await response.text();
  expect(master).toContain("#EXT-X-STREAM-INF");
  const variant = master.split("\n").find((line) => line.startsWith("/native/"))!;
  const playlist = await (await fetch(new URL(variant, fixture.url))).text();
  expect(playlist).toContain("#EXTINF:");
  const segment = playlist.split("\n").find((line) => line.startsWith("/native/"))!;
  const body = Buffer.from(await (await fetch(new URL(segment, fixture.url))).arrayBuffer());
  expect(body.length).toBeGreaterThan(188);
  expect(body[0]).toBe(0x47);
});

const state = async () => await (await fetch(`${fixture.control}/state`)).json();
const conditions = (query: string) => fetch(`${fixture.control}/link?${query}`, { method: "POST" });

test("invalid complete control commands preserve conditions and event history", async () => {
  await conditions("startupMs=1500&kbps=256&stalled=false");
  const before = await state();

  try {
    for (const query of [
      "stalled=false",
      "startupMs=&kbps=&stalled=false",
      "startupMs=0&kbps=0&kbps=256&stalled=false",
      "startupMs=0&kbps=0&stalled=false&typo=1",
      "startupMs=-1&kbps=0&stalled=false",
      "startupMs=0&kbps=0&stalled=yes",
    ]) {
      expect((await conditions(query)).status, query).toBe(400);
      expect(await state()).toEqual(before);
    }
  } finally {
    await conditions("startupMs=0&kbps=0&stalled=false");
  }
});

test("public series episodes and archives serve silent provenance bytes and retain auth failures", async () => {
  // Hosted runs failed here with a bare `fetch failed`/`read ECONNRESET` (#885). Each network
  // step names itself on failure, with the time since the previous step (peak() blocks this
  // process, servers included) and the fixture's recent in-memory transport diagnosis.
  let settled = performance.now();

  const step = async <T>(name: string, run: () => Promise<T>) => {
    const started = performance.now();

    try {
      return await run();
    } catch (error) {
      // Let the fixture observe a peer close queued with the client's rejection.
      await nextTurn();
      throw new Error(
        `${name} failed, started at ${Math.round(started)}ms, ${Math.round(started - settled)}ms after the previous step\n${JSON.stringify(fixture.diagnostics.slice(-30))}`,
        { cause: error },
      );
    } finally {
      settled = performance.now();
    }
  };

  const episode = await step("episode fetch", () =>
    fetch(`${fixture.url}/series/fixture/fixture-pass/81000.mkv`),
  );

  const saved = resolve(out, "served-episode.mkv");
  writeFileSync(saved, Buffer.from(await step("episode body", () => episode.arrayBuffer())));
  const { peak } = await import("../../ios/scripts/native-fixtures/media.ts");
  expect(peak(saved)).toBeLessThan(-60);
  const movie = fixture.files.find((row) => row.name === "parity/title-h264-eac3-subs.mkv")!;

  const title = await step("movie fetch", () =>
    fetch(`${fixture.url}/movie/fixture/fixture-pass/${movie.id}.mkv`),
  );

  expect(readFileSync(saved)).toEqual(
    Buffer.from(await step("movie body", () => title.arrayBuffer())),
  );

  const channels = await step("channels", async () =>
    (
      await fetch(
        `${fixture.url}/player_api.php?username=fixture&password=fixture-pass&action=get_live_streams`,
      )
    ).json(),
  );

  const channel = channels.find((row: { tv_archive: number }) => row.tv_archive === 1);
  const archive = `/timeshift/fixture/fixture-pass/1/2026-11-05:12-00/${channel.stream_id}.ts`;
  const recording = await step("archive fetch", () => fetch(`${fixture.url}${archive}`));
  expect(recording.status).toBe(200);
  const file = resolve(out, "served-archive.ts");
  writeFileSync(file, Buffer.from(await step("archive body", () => recording.arrayBuffer())));
  expect(peak(file)).toBeLessThan(-60);

  const live = await step("live fetch", () =>
    fetch(`${fixture.url}/live/fixture/fixture-pass/${channel.stream_id}.ts`),
  );

  expect(Buffer.from(await step("live body", () => live.arrayBuffer()))).toEqual(
    readFileSync(file),
  );

  expect(
    (
      await step("wrong login", () =>
        fetch(`${fixture.url}${archive.replace("fixture-pass", "wrong")}`),
      )
    ).status,
  ).toBe(401);

  expect(
    (
      await step("missing channel", () =>
        fetch(`${fixture.url}${archive.replace(String(channel.stream_id), "999999")}`),
      )
    ).status,
  ).toBe(404);
}, 30000);

test("failed media reads keep HTTP status, unknown identity and completed empty responses", async () => {
  for (const path of [
    "/files/0/movie/987654",
    "/timeshift/fixture/fixture-pass/1/2026-11-05:12-00/1.ts",
  ]) {
    const response = await fetch(`${fixture.url}${path}`);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  }

  const { events } = await (await fetch(`${fixture.control}/state`)).json();
  const closed = events.filter((event: { event: string }) => event.event === "closed").slice(-2);
  expect(closed).toEqual([
    expect.objectContaining({ fixture: "unknown", status: 404, completed: true, exhausted: false }),
    expect.objectContaining({ status: 404, bytes: 0, completed: true, exhausted: false }),
  ]);
});

test("advertised movie matrix equals public catalogue and documented named files", async () => {
  const rows = await (
    await fetch(
      `${fixture.url}/player_api.php?username=fixture&password=fixture-pass&action=get_vod_streams`,
    )
  ).json();

  expect(rows.map((row: { name: string }) => row.name).sort()).toEqual(
    fixture.files.map((row) => row.name).sort(),
  );
  const doc = readFileSync(resolve("apps/android/docs/formats.md"), "utf8");

  const names = [
    ...doc.matchAll(
      /(?:parity|codecs|native|network)\/[\w./-]+\.(?:mpegts|mp4|mkv|mov|avi|webm|m2ts|bin|m3u8)/g,
    ),
  ].map(([name]) => name);

  expect([...new Set(names)].sort()).toEqual(fixture.files.map((row) => row.name).sort());
});

test("network source continues beyond old exhaustion, stalls and resumes with correlated redacted events", async () => {
  const abort = new AbortController();
  await conditions("startupMs=300&kbps=256&stalled=false");
  const started = performance.now();

  try {
    const response = await fetch(`${fixture.url}/live/fixture/fixture-pass/7998.ts`, {
      signal: abort.signal,
    });

    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(280);
    const reader = response.body!.getReader();
    let received = 0;

    while (received < 130000) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      received += chunk.value!.length;
    }

    expect(performance.now() - started).toBeGreaterThan(3500);
    await conditions("startupMs=0&kbps=256&stalled=true");
    await expect.poll(async () => (await state()).held).toBe(1);
    const snapshot = await state();

    const request = snapshot.events.findLast(
      (event: { event: string }) => event.event === "request",
    );

    expect(request.fixture).toBe("live/network/continuing.ts");
    expect(request.epochMs).toBeGreaterThan(1700000000000);
    await conditions("startupMs=0&kbps=0&stalled=false");
    expect((await reader.read()).done).toBe(false);
    // A concurrent range read must not become a synthetic provider-capacity refusal.
    const title = fixture.files.find((row) => row.name === "network/continuing.mpegts")!;

    const part = await fetch(`${fixture.url}/movie/fixture/fixture-pass/${title.id}.ts`, {
      headers: { Range: "bytes=0-187" },
    });

    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(188);
  } finally {
    abort.abort();
    await conditions("startupMs=0&kbps=0&stalled=false");
  }

  await expect.poll(async () => (await state()).active).toBe(0);
  const events = (await state()).events;

  const closed = events.findLast(
    (event: { fixture: string; event: string }) =>
      event.fixture === "live/network/continuing.ts" && event.event === "closed",
  );

  expect(closed.status).toBe(200);
  expect(closed.bytes).toBeGreaterThan(130000);
  expect(closed.exhausted).toBe(false);
  expect(JSON.stringify(events)).not.toMatch(/fixture-pass|http:|authorization|username/);
  const session = JSON.parse(readFileSync(resolve(out, "session.json"), "utf8"));
  expect(session.network.durationSeconds).toBeGreaterThanOrEqual(300);
  expect(session.network.bitrateKbps).toBeGreaterThan(1000);

  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,bit_rate",
        "-of",
        "json",
        session.network.file,
      ],
      { encoding: "utf8" },
    ),
  );

  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(300);
}, 20000);

test("measurement title pacing permits control before full buffering and records range/status/bytes", async () => {
  const movie = fixture.files.find((row) => row.name === "network/continuing.mpegts")!;
  const started = performance.now();

  const response = await fetch(`${fixture.url}/movie/fixture/fixture-pass/${movie.id}.ts`, {
    headers: { Range: "bytes=0-199999" },
  });

  expect(response.status).toBe(206);
  expect((await response.arrayBuffer()).byteLength).toBe(200000);
  expect(performance.now() - started).toBeGreaterThan(900);
  await expect.poll(async () => (await state()).active).toBe(0);

  const event = (await state()).events.findLast(
    (event: { fixture: string; event: string }) =>
      event.fixture === movie.name && event.event === "closed",
  );

  expect(event).toMatchObject({
    range: "bytes=0-199999",
    status: 206,
    bytes: 200000,
    completed: true,
    exhausted: false,
  });
});

test("closing a stalled server settles active and held accounting before the retained log", async () => {
  const abort = new AbortController();
  await conditions("startupMs=0&kbps=0&stalled=true");

  const pending = fetch(`${fixture.url}/live/fixture/fixture-pass/7998.ts`, {
    signal: abort.signal,
  }).catch(() => null);

  try {
    await expect.poll(async () => (await state()).held).toBe(1);
    await fixture.close();
    expect(JSON.parse(readFileSync(resolve(out, "network.json"), "utf8"))).toMatchObject({
      active: 0,
      held: 0,
    });
  } finally {
    abort.abort();
    await pending;
  }
});
