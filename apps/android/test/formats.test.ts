import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
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
