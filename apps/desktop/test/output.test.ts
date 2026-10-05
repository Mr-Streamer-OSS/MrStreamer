import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Codec } from "@mrstreamer/contracts/playback";
import { Failed } from "@mrstreamer/core/failure";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { airplayAdapter } from "../src/main/receivers/airplay/adapter.ts";
import { castAdapter } from "../src/main/receivers/cast/adapter.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Output } from "../src/main/services/output.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeAirplayHelper } from "./fake-airplay-helper.ts";
import { startFakeCastReceiver } from "./fake-cast-receiver.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

// CI points this at the bundled build, with ffprobe beside it; locally the ones on PATH do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

const LOCAL: readonly Codec[] = ["h264", "aac", "mp3", "opus"];
const MOVIE = "TEST | Long subtitles";
const SHOWN = { name: "A movie" };
const ANCHOR = { x: 900, y: 40, width: 36, height: 36 };

/** What is waited for arrives in milliseconds; a busy machine gets the time it needs. */
const eventually = <T>(check: () => T | Promise<T>) =>
  vi.waitFor(check, { timeout: 8000, interval: 40 });

/**
 * The app's playback and output on a connected fake provider that allows one connection, with a
 * fake TV that takes Cast and a fake helper for AirPlay. The TV fetches nothing by itself: a test
 * that wants it to play asks for the stream as a TV does, with `fetches`.
 */
async function casting(options: { fetchMs?: number; checkpointMs?: number } = {}) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
  const tv = await startFakeCastReceiver();
  const helper = await startFakeAirplayHelper();
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(await tempDir()),
      ffmpeg: FFMPEG,
      ffprobe: FFPROBE,
      output: {
        adapters: [
          castAdapter({
            discovery: tv.discovery,
            timings: {
              request: 3000,
              launch: 3000,
              load: 3000,
              close: 200,
              status: 60_000,
              reconnect: [20, 20, 20],
              attempt: 500,
            },
          }),
          airplayAdapter({
            helper: helper.helper,
            args: helper.args,
            timings: { chosen: 300, settle: 150, quit: 500 },
          }),
        ],
        addresses: () => ["127.0.0.1"],
        fetchMs: options.fetchMs ?? 60_000,
        ...(options.checkpointMs ? { checkpointMs: options.checkpointMs } : {}),
      },
    }),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const source = await subscriptions.source();
  const playback = await promised(runtime, Playback);
  const output = await promised(runtime, Output);
  const viewing = await promised(runtime, ViewingRecord);
  const changes = await collect(runtime, (await runtime.runPromise(Output)).changes);

  const movie = provider.titles.movies.find((each) => each.name.startsWith(MOVIE))!;
  const title: TitleRef = { kind: "movie", id: String(movie.id) };
  const file = source!.provider.titleFile("movie", title.id, movie.container);
  /** A channel that streams without end. */
  const channel = String(
    provider.catalogue.channels.find((each) => !each.offline && !each.fixture)!.streamId,
  );
  /** Connects to the TV, as picking it in the app's list does. */
  const connect = async () => {
    await output.scan(true);
    await eventually(async () => expect((await output.status()).receivers).toHaveLength(1));
    return output.connect(tv.receiver.id);
  };
  /** Opens the movie for the receiver and plays it from `position` seconds. */
  const play = async (position = 0) => {
    const opened = await output.openTitle(title, file);
    const media = await output.playTitle(opened.sessionId, {
      position,
      audio: null,
      subtitle: null,
      shown: SHOWN,
    });
    return { opened, media };
  };
  /** The LOAD the TV was sent last. */
  const loaded = () =>
    tv.requests("LOAD").at(-1) as { media: { contentId: string } } & Record<string, unknown>;
  /** Asks for the stream the TV was sent as a TV does: its playlists and its first segment. */
  const fetches = async () => {
    const main = await (await fetch(loaded().media.contentId)).text();
    const stream = main.split("\n").find((line) => line && !line.startsWith("#"))!;
    const video = new URL(stream, loaded().media.contentId).href;
    const first = (await (await fetch(video)).text())
      .split("\n")
      .find((line) => /^[^#]/.test(line))!;
    return fetch(new URL(first, video).href);
  };
  const state = async () => (await output.status()).output;
  /** How far the record says the movie got under the connected account, in seconds; null when it has nothing. */
  const saved = async () => (await viewing.progress({ movieIds: [title.id] }))[0]?.position ?? null;
  return {
    saved,
    provider,
    tv,
    helper,
    subscriptions,
    playback,
    output,
    changes,
    title,
    file,
    channel,
    connect,
    play,
    loaded,
    fetches,
    state,
    dispose: () => runtime.dispose(),
  };
}

/** What a rejected call failed with. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (cause: unknown) => (cause instanceof Failed ? cause.error : cause),
  );

describe.skipIf(!hasTools)("playback on a receiver", () => {
  it("leaves what plays here alone while receivers are looked for and one is connected", async () => {
    const { provider, tv, playback, output, connect, channel } = await casting();
    const local = await playback.open(channel, LOCAL);
    const watching = new AbortController();
    void fetch(local.url, { signal: watching.signal }).catch(() => {});
    await eventually(() => expect(provider.activeStreams()).toBe(1));

    expect((await output.status()).offers).toEqual(["cast", "airplay"]);
    const connected = await connect();
    expect(connected.output).toMatchObject({
      kind: "receiver",
      receiver: { kind: "cast", name: "TV" },
      media: null,
      failure: null,
    });
    // Nothing was sent to the TV, and the stream here still plays on its one connection.
    expect(tv.requests("LOAD")).toHaveLength(0);
    expect(provider.streamRequests()).toBe(1);
    expect(provider.activeStreams()).toBe(1);
    expect(await output.remote()).toBe(true);
    watching.abort();
  });

  it("hands a title to the receiver at its position and follows the receiver's clock", async () => {
    const { provider, tv, playback, connect, play, loaded, fetches, state, changes, title, file } =
      await casting();
    const local = await playback.openTitle(title, file, LOCAL);
    await connect();

    const { opened, media } = await play(42);
    // The session here closed first: one connection to the provider, now the receiver's.
    expect((await fetch(`${local.url}?start=0`)).status).toBe(410);
    expect(opened.duration).toBeCloseTo(150, 0);
    expect(opened.shows).toEqual(["text"]);
    expect(media).toMatchObject({ state: "loading", position: 42, item: { kind: "title", title } });
    // The TV got an address of this computer under a token, and nothing of the provider's.
    expect(loaded().media.contentId).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/master\.m3u8$/,
    );
    expect(JSON.stringify(tv.requests("LOAD"))).not.toContain("demo");
    expect(loaded()).toMatchObject({ currentTime: 42, autoplay: true });
    expect((await fetches()).status).toBe(200);

    tv.status({ playerState: "PLAYING", currentTime: 43.5 });
    await eventually(async () =>
      expect(await state()).toMatchObject({
        media: { generation: media.generation, state: "playing", position: 43.5 },
      }),
    );
    expect(changes.at(-1)?.output).toMatchObject({ media: { state: "playing" } });
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("passes on what the viewer does, and drops what was meant for an earlier load", async () => {
    const { tv, output, connect, play, state } = await casting();
    await connect();
    const first = await play(10);
    tv.status({ playerState: "PLAYING", currentTime: 10 });

    await output.command(first.media.generation, { command: "pause" });
    await output.command(first.media.generation, { command: "seek", position: 95 });
    expect(tv.requests("PAUSE")).toHaveLength(1);
    expect(tv.requests("SEEK").at(-1)).toMatchObject({ currentTime: 95 });

    // The same title with another sound track is another load.
    const second = await output.playTitle(first.opened.sessionId, {
      position: 95,
      audio: first.opened.audio[0]!.id,
      subtitle: null,
      shown: SHOWN,
    });
    expect(second.generation).toBeGreaterThan(first.media.generation);
    const paused = tv.requests("PAUSE").length;
    await output.command(first.media.generation, { command: "pause" });
    await output.command(first.media.generation, { command: "seek", position: 5 });
    expect(tv.requests("PAUSE")).toHaveLength(paused);
    expect(tv.requests("SEEK").at(-1)).toMatchObject({ currentTime: 95 });
    expect(await state()).toMatchObject({ media: { generation: second.generation } });
  });

  it("counts a title as ended only when the receiver played it to the end", async () => {
    const { tv, output, connect, play, state, provider } = await casting();
    await connect();
    const first = await play(140);
    tv.status({ playerState: "PLAYING", currentTime: 149 });
    tv.idle("FINISHED");
    await eventually(async () =>
      expect(await state()).toMatchObject({
        media: { generation: first.media.generation, state: "ended" },
      }),
    );

    // Played again, and the TV's connection breaks for good: gone, and never an end.
    await play(100);
    tv.status({ playerState: "PLAYING", currentTime: 101 });
    tv.refusing = true;
    tv.drop();
    await eventually(async () =>
      expect(await state()).toMatchObject({ kind: "lost", failure: { kind: "unreachable" } }),
    );
    // What it played is closed with it: the provider's connection is free.
    await eventually(() => expect(provider.activeStreams()).toBe(0));
    expect(await output.remote()).toBe(true);
  }, 20_000);

  it("says so when the receiver takes a stream it never asks this computer for", async () => {
    const { tv, connect, play, state, provider } = await casting({ fetchMs: 300 });
    await connect();
    await play(0);

    await eventually(async () =>
      expect(await state()).toMatchObject({
        kind: "receiver",
        media: null,
        failure: { kind: "not-fetched" },
      }),
    );
    // The TV is told to stop waiting, and the session it never used is closed.
    expect(tv.requests("STOP").length).toBeGreaterThanOrEqual(1);
    await eventually(() => expect(provider.activeStreams()).toBe(0));
  });

  it("keeps a receiver that asked for its stream past the wait for it", async () => {
    const { connect, play, fetches, state } = await casting({ fetchMs: 300 });
    await connect();
    const { media } = await play(0);
    expect((await fetches()).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await state()).toMatchObject({ media: { generation: media.generation }, failure: null });
  });

  it("goes back to this computer with the receiver's session closed first", async () => {
    const { tv, output, connect, play, loaded, fetches, state, provider } = await casting();
    await connect();
    await play(30);
    expect((await fetches()).status).toBe(200);
    const address = loaded().media.contentId;

    await output.disconnect();
    expect(await state()).toEqual({ kind: "local" });
    expect(await output.remote()).toBe(false);
    // Nothing of the receiver's is left to ask for, and the provider's connection is free.
    await expect(fetch(address)).rejects.toThrow();
    await eventually(() => expect(provider.activeStreams()).toBe(0));
    expect(tv.app).toBeNull();
  });

  it("saves how far the receiver got from what it confirms, never from an earlier load", async () => {
    const { tv, connect, play, state, saved } = await casting({ checkpointMs: 100 });
    await connect();
    await play(10);
    // Loading says nothing of how far it got.
    expect(await saved()).toBeNull();

    tv.status({ playerState: "PLAYING", currentTime: 30 });
    // While it plays, now and then.
    await eventually(async () => expect(await saved()).toBeGreaterThanOrEqual(30));
    tv.status({ playerState: "PAUSED", currentTime: 61 });
    await eventually(async () => expect(await saved()).toBeCloseTo(61, 0));

    // Another load of the title, from further back. What the TV still says of the first one,
    // that it played to the end, moves neither the clock nor what is saved.
    const second = await play(20);
    tv.send({
      type: "MEDIA_STATUS",
      status: [
        { mediaSessionId: 1, playerState: "IDLE", idleReason: "FINISHED", currentTime: 150 },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await state()).toMatchObject({
      media: { generation: second.media.generation, state: "loading" },
    });
    expect(await saved()).toBeCloseTo(61, 0);
  });

  it("saves a receiver's progress under the account it began with, and ends it when another connects", async () => {
    const { tv, output, subscriptions, connect, play, state, saved } = await casting();
    const other = await fakeProvider({ maxConnections: 1 });
    await connect();
    const { media } = await play(10);
    tv.status({ playerState: "PLAYING", currentTime: 80 });
    await eventually(async () => expect(await state()).toMatchObject({ media: { position: 80 } }));
    const stops = tv.requests("STOP").length;

    // As the app does when another login is entered: the receiver's title ends first.
    await output.accountChanged();
    expect(await saved()).toBeGreaterThanOrEqual(80);
    expect(await state()).toMatchObject({ kind: "receiver", media: null, failure: null });
    expect(tv.requests("STOP").length).toBeGreaterThan(stops);
    await subscriptions.connect({ server: other.url, username: "demo", password: "demo" });

    // What the TV says after that is of a load that is gone: the new account's record stays empty.
    tv.status({ playerState: "PAUSED", currentTime: 120 });
    await output.command(media.generation, { command: "seek", position: 140 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await saved()).toBeNull();
  });

  it("has the receiver stop when something plays here instead", async () => {
    const { tv, playback, connect, play, state, channel } = await casting();
    await connect();
    await play(0);
    const stops = tv.requests("STOP").length;

    await playback.open(channel, LOCAL);
    await eventually(async () =>
      expect(await state()).toMatchObject({ kind: "receiver", media: null, failure: null }),
    );
    expect(tv.requests("STOP").length).toBeGreaterThan(stops);
  });

  it("plays a channel on the receiver, and says why when its stream stops", async () => {
    const { provider, tv, output, connect, loaded, state } = await casting();
    await connect();
    const offline = provider.catalogue.channels.find((each) => each.name === "TEST | H.264 + AAC")!;

    const media = await output.playChannel(String(offline.streamId), {
      variants: [String(offline.streamId)],
      shown: { name: "A channel" },
    });
    expect(media).toMatchObject({ state: "loading", duration: null, item: { kind: "channel" } });
    expect(loaded()).toMatchObject({ media: { streamType: "LIVE" } });
    expect(loaded().media.contentId).toMatch(/\/r\/[\w-]+\/live\.m3u8$/);
    tv.status({ playerState: "PLAYING", currentTime: 2 });
    // The fixture's three seconds are over, which the playlist says: the TV plays out what it
    // has and goes idle.
    await eventually(async () =>
      expect(await (await fetch(loaded().media.contentId)).text()).toContain("#EXT-X-ENDLIST"),
    );
    tv.idle("FINISHED");
    await eventually(async () =>
      expect(await state()).toMatchObject({
        media: null,
        failure: { kind: "stream", failure: { kind: "network" } },
      }),
    );
  }, 15_000);

  it("stops the receiver and frees the provider when the app quits", async () => {
    const { tv, provider, connect, play, fetches, dispose } = await casting();
    await connect();
    await play(0);
    expect((await fetches()).status).toBe(200);

    await dispose();
    expect(tv.app).toBeNull();
    await eventually(() => expect(provider.activeStreams()).toBe(0));
  });
});

describe.skipIf(!hasTools)("playback through the system's list of receivers", () => {
  it("changes nothing when the viewer closes the list without picking", async () => {
    const { helper, playback, output, provider, channel, state } = await casting();
    const local = await playback.open(channel, LOCAL);
    const watching = new AbortController();
    void fetch(local.url, { signal: watching.signal }).catch(() => {});
    await eventually(() => expect(provider.activeStreams()).toBe(1));

    const picking = output.pick(ANCHOR);
    expect(await helper.took("showPicker")).toMatchObject({ anchor: ANCHOR });
    await eventually(async () =>
      expect(await state()).toEqual({ kind: "connecting", protocol: "airplay", receiver: null }),
    );
    helper.dismiss();

    expect((await picking).output).toEqual({ kind: "local" });
    expect(helper.commands.filter((command) => command.cmd === "load")).toHaveLength(0);
    expect(provider.activeStreams()).toBe(1);
    expect(provider.streamRequests()).toBe(1);
    watching.abort();
  });

  it("plays on the receiver the viewer picks, and comes back when it lets go", async () => {
    const { helper, output, play, state, provider } = await casting();
    const picking = output.pick(ANCHOR);
    await helper.took("showPicker");
    helper.choose();
    // The system keeps the receiver's name to itself.
    expect((await picking).output).toMatchObject({
      kind: "receiver",
      receiver: { kind: "airplay", name: null },
    });

    const { media } = await play(25);
    const load = await helper.took("load");
    expect(load).toMatchObject({ generation: media.generation, position: 25, paused: false });
    expect(load.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/master\.m3u8$/);
    helper.status("playing", 26, 150);
    await eventually(async () =>
      expect(await state()).toMatchObject({ media: { state: "playing", position: 26 } }),
    );

    // The viewer picks this computer in the system's list: nothing failed.
    helper.external(false);
    await eventually(async () => expect(await state()).toEqual({ kind: "local" }));
    await eventually(() => expect(provider.activeStreams()).toBe(0));
  });

  it("gives up the list when the viewer goes back to this computer meanwhile", async () => {
    const { helper, output, state } = await casting();
    const picking = failure(output.pick(ANCHOR));
    await helper.took("showPicker");

    await output.disconnect();
    expect(await picking).toMatchObject({ kind: "output", failure: { kind: "unreachable" } });
    expect(await state()).toEqual({ kind: "local" });
  });
});
