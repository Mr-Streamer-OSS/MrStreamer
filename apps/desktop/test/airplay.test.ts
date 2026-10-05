import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReceiverFailed,
  type AdapterEvent,
  type ReceiverMedia,
} from "../src/main/receivers/adapter.ts";
import { airplayAdapter, type AirplayTimings } from "../src/main/receivers/airplay/adapter.ts";
import { startFakeAirplayHelper } from "./fake-airplay-helper.ts";

const ANCHOR = { x: 900, y: 40, width: 36, height: 36 };
const PICKER = { kind: "picker", anchor: ANCHOR } as const;

/** Long enough never to run out in a test; a test shortens the wait it lets run out. */
const TIMINGS: AirplayTimings = {
  start: 10_000,
  answer: 5000,
  chosen: 5000,
  button: 5000,
  settle: 5000,
  quit: 1000,
  steady: 60_000,
};

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const each of opened.splice(0).reverse()) await each.close();
});

const never = () => new AbortController().signal;

const NO_ROUTES = { type: "routes", available: false } as const;
const ROUTES = { type: "routes", available: true } as const;

function media(generation: number, more: Partial<ReceiverMedia> = {}): ReceiverMedia {
  return {
    generation,
    url: `http://192.168.1.20:41000/r/token${generation}/master.m3u8`,
    live: false,
    position: 0,
    paused: false,
    duration: 180,
    subtitles: false,
    metadata: { title: "A title", subtitle: null, artworkUrl: null },
    ...more,
  };
}

/** A fake helper and an adapter that scans with it, so the helper runs and says what it sees. */
async function setup(timings: Partial<AirplayTimings> = {}) {
  const helper = await startFakeAirplayHelper();
  const adapter = airplayAdapter({
    helper: helper.helper,
    args: helper.args,
    timings: { ...TIMINGS, ...timings },
  });
  opened.push(helper, adapter);
  const events: AdapterEvent[] = [];
  adapter.listen((event) => events.push(event));
  adapter.scan(true);
  await helper.took("detect");
  await expect.poll(() => events, { interval: 5 }).toEqual([NO_ROUTES]);
  return {
    helper,
    adapter,
    events,
    /** What the adapter reported besides routes. */
    news: () => events.filter((event) => event.type !== "routes"),
    /**
     * Resolves once the adapter has read everything the helper said so far: a route change said
     * after it has come through.
     */
    async caughtUp() {
      const routes = events.filter((event) => event.type === "routes");
      helper.routes(routes.at(-1)?.available !== true);
      await expect
        .poll(() => events.filter((event) => event.type === "routes"), { interval: 5 })
        .toHaveLength(routes.length + 1);
    },
  };
}

/** As `setup`, with the viewer having picked a receiver in the list. */
async function connected(timings: Partial<AirplayTimings> = {}) {
  const made = await setup(timings);
  const connecting = made.adapter.connect(PICKER, never());
  await made.helper.took("showPicker");
  made.helper.choose();
  const connection = await connecting;
  if (!connection) throw new Error("The connect found no receiver.");
  return { ...made, connection };
}

describe("AirPlay adapter", () => {
  it("resolves null and loads nothing when the viewer closes the list without picking", async () => {
    const { helper, adapter, news } = await setup({ chosen: 30 });

    const connecting = adapter.connect(PICKER, never());
    expect((await helper.took("showPicker")).anchor).toEqual(ANCHOR);
    helper.dismiss();

    expect(await connecting).toBeNull();
    // The helper is told to hold nothing once nothing was chosen.
    await helper.took("unload");
    expect(helper.commands.map((command) => command.cmd)).not.toContain("load");
    expect(news()).toEqual([]);
  });

  it("connects only once external playback is on", async () => {
    const { helper, adapter, caughtUp } = await setup();
    let settled = false;
    const connecting = adapter.connect(PICKER, never()).finally(() => (settled = true));
    await helper.took("showPicker");

    // The list closes before the receiver plays: that alone connects nothing.
    helper.dismiss();
    await caughtUp();
    expect(settled).toBe(false);

    helper.external(true);
    expect(await connecting).toMatchObject({
      receiver: { id: "airplay", kind: "airplay", name: null },
      localAddress: null,
      decoders: ["h264", "aac"],
      volume: true,
    });
    await helper.took("hidePicker");
  });

  it("opens the list again on a connected receiver, which stays when nothing changes", async () => {
    const { helper, adapter, connection, caughtUp, news } = await connected();
    await helper.took("hidePicker");

    const again = adapter.connect(PICKER, never());
    await helper.took("showPicker");
    helper.dismiss();

    expect(await again).toBe(connection);
    await caughtUp();
    expect(helper.commands.map((command) => command.cmd)).not.toContain("unload");
    expect(news()).toEqual([{ type: "volume", level: 1, muted: false }]);
  });

  it("waits at the picker's own button, then counts nothing as chosen", async () => {
    const { helper, adapter } = await setup({ button: 30 });
    const connecting = adapter.connect(PICKER, never());
    const { request } = await helper.took("showPicker");

    // The list didn't open by itself, and the viewer never presses the button.
    helper.emit({ type: "picker", request, state: "manual" });

    expect(await connecting).toBeNull();
    await helper.took("hidePicker");
  });

  it("gives up the list when the connect is aborted", async () => {
    const { helper, adapter } = await setup();
    const waiting = new AbortController();
    const connecting = adapter.connect(PICKER, waiting.signal);
    await helper.took("showPicker");

    waiting.abort();

    await expect(connecting).rejects.toBeInstanceOf(ReceiverFailed);
    await helper.took("hidePicker");
    await helper.took("unload");
  });

  it("passes what the service asks to the helper, with the load's generation", async () => {
    const { helper, connection } = await connected();

    await connection.load(media(3, { position: 42, paused: true, subtitles: true }), never());
    await connection.play(3);
    await connection.pause(3);
    await connection.seek(3, 61.5);
    await connection.showSubtitles(3, false);
    await connection.setVolume({ level: 0.4 });
    await connection.stop(3);

    expect(helper.commands.slice(-7)).toMatchObject([
      {
        cmd: "load",
        generation: 3,
        url: media(3).url,
        position: 42,
        paused: true,
        live: false,
        subtitles: true,
      },
      { cmd: "play", generation: 3 },
      { cmd: "pause", generation: 3 },
      { cmd: "seek", generation: 3, position: 61.5 },
      { cmd: "subtitles", generation: 3, on: false },
      { cmd: "volume", level: 0.4 },
      { cmd: "stop", generation: 3 },
    ]);
  });

  it("reports what the player says as the load's status", async () => {
    const { helper, connection, events } = await connected();
    const statuses = () =>
      events.flatMap((event) => (event.type === "status" ? [event.status] : []));
    const began = Date.now();

    await connection.load(media(1), never());
    helper.status("buffering", 0);
    helper.status("playing", 12.5, 180);
    helper.status("paused", 13, 180);

    await expect.poll(statuses).toHaveLength(4);
    expect(statuses()).toMatchObject([
      { generation: 1, state: "loading", position: 0, duration: null },
      { generation: 1, state: "buffering", position: 0, duration: null },
      { generation: 1, state: "playing", position: 12.5, duration: 180 },
      { generation: 1, state: "paused", position: 13, duration: 180 },
    ]);
    for (const status of statuses()) {
      expect(status.at).toBeGreaterThanOrEqual(began);
      expect(status.at).toBeLessThanOrEqual(Date.now());
    }
  });

  it("tells a real end from a stop", async () => {
    const { helper, connection, events } = await connected();
    const states = () =>
      events.flatMap((event) =>
        event.type === "status" ? [`${event.status.generation} ${event.status.state}`] : [],
      );

    await connection.load(media(1), never());
    helper.status("ended", 180, 180);
    await connection.load(media(2), never());
    await connection.stop(2);

    await expect
      .poll(states)
      .toEqual(["1 loading", "1 ended", "1 stopped", "2 loading", "2 stopped"]);
  });

  it("keeps a late word on an earlier load under that load, and drops commands for it", async () => {
    const { helper, connection, events } = await connected();
    await connection.load(media(1), never());
    await connection.load(media(2), never());

    helper.emit({ type: "status", generation: 1, state: "playing", position: 50, duration: 180 });
    helper.status("playing", 1, 180);
    await connection.pause(1);
    await connection.seek(1, 90);
    await connection.stop(1);
    await connection.play(2);

    const playing = () =>
      events.flatMap((event) =>
        event.type === "status" && event.status.state === "playing" ? [event.status] : [],
      );
    await expect.poll(playing).toHaveLength(2);
    expect(playing()).toMatchObject([
      { generation: 1, position: 50 },
      { generation: 2, position: 1 },
    ]);
    expect(helper.commands.slice(-3).map((command) => command.cmd)).toEqual([
      "load",
      "load",
      "play",
    ]);
  });

  it("stops a load that is given up while the helper takes it", async () => {
    const { helper, connection } = await connected();
    const waiting = new AbortController();

    const loading = connection.load(media(5), waiting.signal);
    waiting.abort();

    await expect(loading).rejects.toBeInstanceOf(ReceiverFailed);
    expect(await helper.took("stop")).toMatchObject({ generation: 5 });
  });

  it("reports a load the player can't play, without the media's address", async () => {
    const { helper, connection, news } = await connected();
    await connection.load(media(1), never());

    helper.fail(`Cannot decode (CoreMediaErrorDomain -12909) ${media(1).url}`);

    await expect.poll(news).toContainEqual({
      type: "media-failed",
      generation: 1,
      failure: {
        kind: "media",
        detail: "Cannot decode (CoreMediaErrorDomain -12909) http://192.168.1.20:41000/…",
      },
    });
  });

  it("says the receiver let go once external playback stays off", async () => {
    const { helper, connection, news } = await connected({ settle: 30 });
    await connection.load(media(1), never());

    helper.external(false);

    await expect.poll(news).toContainEqual({ type: "released" });
    // The helper is told to let go of the media, so nothing of it plays on this computer.
    await helper.took("unload");
    await expect(connection.setVolume({ muted: true })).rejects.toMatchObject({
      failure: { kind: "unreachable" },
    });
  });

  it("says the connection broke when external playback ends after a failed load", async () => {
    const { helper, connection, news } = await connected({ settle: 30 });
    await connection.load(media(1), never());

    helper.fail("The network connection was lost. (NSURLErrorDomain -1005)");
    helper.external(false);

    await expect.poll(news).toContainEqual({ type: "lost", failure: { kind: "unreachable" } });
    expect(news()).not.toContainEqual({ type: "released" });
  });

  it("stays connected through a moment without external playback", async () => {
    const { helper, connection, news } = await connected({ settle: 60 });
    await connection.load(media(1), never());

    helper.external(false);
    helper.external(true);
    await sleep(150);

    expect(news()).not.toContainEqual({ type: "released" });
    await connection.play(1);
  });

  it("hears the receiver's volume", async () => {
    const { helper, news } = await connected();

    helper.emit({ type: "volume", level: 0.3, muted: true });

    await expect.poll(news).toEqual([
      { type: "volume", level: 1, muted: false },
      { type: "volume", level: 0.3, muted: true },
    ]);
  });

  it("passes on what the system sees, and says it again once scanning starts again", async () => {
    const { helper, adapter, events } = await setup();

    helper.routes(true);
    await expect.poll(() => events).toEqual([NO_ROUTES, ROUTES]);

    adapter.scan(false);
    expect(await helper.took("detect")).toMatchObject({ on: false });
    adapter.scan(true);
    expect(await helper.took("detect")).toMatchObject({ on: true });
    await expect.poll(() => events).toEqual([NO_ROUTES, ROUTES, ROUTES]);
  });

  it("fails a command the helper doesn't answer in time, and counts the helper as gone", async () => {
    const { helper, connection, news } = await connected({ answer: 500, quit: 100 });
    await connection.load(media(1), never());

    helper.silence();

    await expect(connection.play(1)).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    await expect.poll(news).toContainEqual({
      type: "lost",
      failure: { kind: "unavailable", detail: "the AirPlay helper stopped" },
    });
    expect(helper.running()).not.toContain(helper.pids[0]);
  });

  it("reports a crash as lost at once, and restarts the helper three times in a row at most", async () => {
    const { helper, adapter, connection, news, events } = await connected();
    helper.routes(true);

    helper.crash();
    await expect.poll(news).toContainEqual({
      type: "lost",
      failure: { kind: "unavailable", detail: "the AirPlay helper stopped" },
    });
    await expect(connection.setVolume({ level: 1 })).rejects.toBeInstanceOf(ReceiverFailed);

    // It scans, so the helper is started again: three times, each crashing in turn.
    for (const restarts of [1, 2, 3]) {
      expect(await helper.took("detect")).toMatchObject({ on: true });
      expect(helper.pids).toHaveLength(restarts + 1);
      helper.crash();
    }
    await expect.poll(() => helper.running()).toEqual([]);
    await expect.poll(() => events.at(-1)).toEqual(NO_ROUTES);

    await expect(adapter.connect(PICKER, never())).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
    expect(helper.pids).toHaveLength(4);
  });

  it("lets go of the receiver by ending the helper, and starts another while it scans", async () => {
    const { helper, connection, news } = await connected();
    const [first] = helper.pids;

    await connection.disconnect();

    expect(helper.running()).not.toContain(first);
    await expect.poll(() => helper.pids).toHaveLength(2);
    expect(await helper.took("detect")).toMatchObject({ on: true });
    expect(news()).toEqual([{ type: "volume", level: 1, muted: false }]);
  });

  it("leaves no process behind once closed", async () => {
    const { helper, adapter } = await connected();
    expect(helper.running()).toHaveLength(1);

    await adapter.close();

    expect(helper.running()).toEqual([]);
  });

  it("closes in bounded time when the helper says nothing, and leaves no process", async () => {
    const { helper, adapter } = await connected({ quit: 100 });
    helper.silence();
    const began = Date.now();

    await adapter.close();

    expect(Date.now() - began).toBeLessThan(1500);
    expect(helper.running()).toEqual([]);
  });

  it("ignores lines that are no events, and lines that are too long", async () => {
    const { helper, adapter, events } = await setup({ chosen: 30 });

    helper.write("not json");
    helper.write("[1, 2, 3]");
    helper.write(JSON.stringify({ type: "mystery", available: true }));
    helper.write(JSON.stringify({ type: "external", active: "yes" }));
    helper.write(JSON.stringify({ type: "external", active: true, padding: "x".repeat(70_000) }));
    helper.routes(true);

    await expect.poll(() => events).toEqual([NO_ROUTES, ROUTES]);
    // Had the long line counted, the helper would seem to play on a receiver already.
    const connecting = adapter.connect(PICKER, never());
    await helper.took("showPicker");
    helper.dismiss();
    expect(await connecting).toBeNull();
  });

  it("refuses a helper that speaks another protocol", async () => {
    const helper = await startFakeAirplayHelper({ protocol: 2 });
    const adapter = airplayAdapter({ helper: helper.helper, args: helper.args, timings: TIMINGS });
    opened.push(helper, adapter);

    await expect(adapter.connect(PICKER, never())).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
    await expect.poll(() => helper.running()).toEqual([]);
    // No other start would do better, so there is none.
    await expect(adapter.connect(PICKER, never())).rejects.toBeInstanceOf(ReceiverFailed);
    expect(helper.pids).toHaveLength(1);
  });

  it("is unavailable where the app has no helper", async () => {
    const adapter = airplayAdapter({ helper: null });
    const events: AdapterEvent[] = [];
    adapter.listen((event) => events.push(event));

    adapter.scan(true);
    await expect(adapter.connect(PICKER, never())).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
    await adapter.close();

    expect(events).toEqual([]);
  });

  it("has no receivers to connect to by id", async () => {
    const { adapter } = await setup();

    await expect(
      adapter.connect({ kind: "receiver", id: "airplay" }, never()),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
  });
});
