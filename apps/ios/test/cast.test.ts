import { nativePlayer } from "./native-player.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Play on TV through the open sender: what the TV is told, what the phone keeps, and how the
// stream's readers and the provider's connection are let go of. The native Cast module is a
// stand-in that hands the sender's bytes to a fake TV speaking the Cast protocol (decoded here
// on its own, apart from the sender's code) and plays the relay's part. No real TV, network or
// iOS runs here.

const given: Array<{ uri: string } | null> = [];
const fakePlayer = nativePlayer((source) => void given.push(source));

vi.mock("expo-file-system", () => import("./native-files.ts"));

vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((done, refuse) => {
    resolve = done;
    reject = refuse;
  });

  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((done) => setTimeout(done, 0));
};

// --- A fake TV on the other end of the channel --------------------------------------------------

interface Sent {
  readonly to: string;
  readonly namespace: string;
  readonly payload: Record<string, unknown>;
}

/** Reads one protobuf CastMessage frame, as a TV would. */
function readFrames(bytes: Buffer): Sent[] {
  const out: Sent[] = [];

  for (let at = 0; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const body = bytes.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    const fields = new Map<number, string>();

    for (let i = 0; i < body.length;) {
      const tag = body[i++]!;

      if ((tag & 7) === 0) {
        while (body[i++]! & 0x80);
        continue;
      }

      let size = 0;

      for (let shift = 0; ; shift += 7) {
        const byte = body[i++]!;
        size |= (byte & 0x7f) << shift;

        if (byte < 0x80) break;
      }

      fields.set(tag >> 3, body.subarray(i, i + size).toString("utf8"));
      i += size;
    }

    out.push({
      to: fields.get(3)!,
      namespace: fields.get(4)!,
      payload: JSON.parse(fields.get(6)!) as Record<string, unknown>,
    });
  }

  return out;
}

/** A frame from the TV. */
function frame(from: string, namespace: string, payload: object): string {
  const text = (field: number, value: string) => {
    const bytes = Buffer.from(value);

    return Buffer.concat([Buffer.from([(field << 3) | 2, ...varint(bytes.length)]), bytes]);
  };

  const body = Buffer.concat([
    Buffer.from([8, 0]),
    text(2, from),
    text(3, "sender-0"),
    text(4, namespace),
    Buffer.from([40, 0]),
    text(6, JSON.stringify(payload)),
  ]);

  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);

  return Buffer.concat([length, body]).toString("base64");
}

function varint(value: number): number[] {
  const bytes = [];

  for (; value > 0x7f; value >>>= 7) bytes.push((value & 0x7f) | 0x80);

  return [...bytes, value];
}

const RECEIVER = "urn:x-cast:com.google.cast.receiver";
const MEDIA = "urn:x-cast:com.google.cast.media";

/** Everything the TV was sent, in order. */
let sent: Sent[] = [];

/** What the TV does with what it's sent; tests replace parts. */
let tvTime = 0;
let tvState = "PLAYING";

const listeners = new Map<string, (event: never) => void>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);

const tvSays = (channel: string, from: string, namespace: string, payload: object) =>
  emit("onData", { channel, data: frame(from, namespace, payload) });

function answerAsTv(channel: string, message: Sent) {
  const { type, requestId } = message.payload;

  const status = () => ({
    type: "MEDIA_STATUS",
    requestId,
    status:
      tvState === "GONE"
        ? []
        : [
            {
              mediaSessionId: 1,
              playerState: tvState,
              currentTime: tvTime,
              media: { duration: 600 },
            },
          ],
  });

  if (message.namespace === RECEIVER && type === "LAUNCH") {
    tvSays(channel, "receiver-0", RECEIVER, {
      type: "RECEIVER_STATUS",
      requestId,
      status: {
        applications: [{ appId: "CC1AD845", sessionId: "s1", transportId: "t1" }],
        volume: { level: 0.4, muted: false },
      },
    });
  } else if (message.namespace === RECEIVER && type === "STOP") {
    tvSays(channel, "receiver-0", RECEIVER, {
      type: "RECEIVER_STATUS",
      requestId,
      status: { applications: [] },
    });
  } else if (message.namespace === MEDIA && type === "LOAD") {
    tvTime = Number(message.payload["currentTime"] ?? 0);
    tvSays(channel, "t1", MEDIA, status());
  } else if (message.namespace === MEDIA && type === "STOP") {
    tvState = "IDLE";
    tvSays(channel, "t1", MEDIA, status());
  } else if (message.namespace === MEDIA && type === "GET_STATUS") {
    tvSays(channel, "t1", MEDIA, status());
  }
}

// --- The native module's relay and background ------------------------------------------------

/** Each token the relay served: what it reads, with what, and its revocation to settle. */
let served: Array<{
  token: string;
  url: string;
  headers: Record<string, string> | null;
  revoked: ReturnType<typeof deferred<void>> | null;
}> = [];

/** Each playlist the relay reads, by address. */
const playlists = new Map<string, string>();
const routes = new Map<string, string>();
let events: string[] = [];
let wifi = true;

/** Whether revocations wait for `relayCloses`, for tests that check what waits on them. */
let holding = false;

/** The channel the sender opened last. */
let channel = "";
let openChannel = async () => {};

Object.assign(globalThis, {
  expo: {
    modules: {
      Cast: {
        connect: async (name: string) => {
          channel = name;
          await openChannel();
        },
        write: (channel: string, data: string) => {
          for (const message of readFrames(Buffer.from(data, "base64"))) {
            sent.push(message);
            queueMicrotask(() => answerAsTv(channel, message));
          }
        },
        disconnect: () => events.push("disconnect"),
        serve: async (url: string, headers: Record<string, string> | null) => {
          if (!wifi) return null;
          const token = `tok${served.length + 1}`;
          served.push({ token, url, headers, revoked: null });
          routes.set(`${token}/0`, url);

          return { address: `http://192.168.1.20:5000/${token}/`, token };
        },
        route: (token: string, made: Array<{ id: string; url: string }>) => {
          for (const route of made) routes.set(`${token}/${route.id}`, route.url);
        },
        read: async (token: string, id: string) => {
          const url = routes.get(`${token}/${id}`)!;

          return { url, body: playlists.get(url) ?? "" };
        },
        answer: () => {},
        revoke: (token: string) => {
          const entry = served.find((each) => each.token === token)!;
          events.push(`revoke ${token}`);
          entry.revoked = deferred();

          if (!holding) entry.revoked.resolve();

          return entry.revoked.promise.then(() => void events.push(`revoked ${token}`));
        },
        endBackground: () => events.push("end background"),
        addListener: (event: string, listener: (event: never) => void) => {
          listeners.set(event, listener);

          return { remove: () => listeners.delete(event) };
        },
      },
    },
  },
});

const {
  onAdmission,
  play,
  playbackState,
  playHere,
  playOnTv,
  retry,
  setTvVolume,
  stop,
  togglePause,
} = await import("../src/playback.ts");

onAdmission({
  acquire: async (_subscription, lease) => void events.push(`acquire ${lease.split("-").pop()}`),
  release: (lease) => void events.push(`release ${lease.split("-").pop()}`),
});

const tv = { id: "tv1", name: "Living Room TV", model: "Chromecast" };
const PROVIDER = "http://provider.example:8080/movie/user/secret/42";
const options = { watch: true, login: ["user", "secret"], from: 120 };

const title = (id: string) => ({
  id,
  subscriptionId: "sub",
  title: "Estuary",
  place: "2026",
  live: false,
  next: false,
  versions: false,
});

const file = (container: string) => ({
  kind: "file" as const,
  originalLanguage: null,
  open: async () => ({
    url: `${PROVIDER}.${container}`,
    headers: { "User-Agent": "MrStreamer" },
    container,
  }),
});

/** Settles every revocation asked so far, as the native relay does once its readers ended. */
const relayCloses = async () => {
  for (const each of served) each.revoked?.resolve();
  await settle();
};

const loads = () => sent.filter((each) => each.payload["type"] === "LOAD");

beforeEach(async () => {
  holding = false;
  const stopping = stop();
  await relayCloses();
  await stopping;
  await settle();
  sent = [];
  events = [];
  served = [];
  given.length = 0;
  routes.clear();
  playlists.clear();
  tvTime = 0;
  tvState = "PLAYING";
  wifi = true;
  openChannel = async () => {};
});

describe("Play on TV", () => {
  it("does not report a superseded connection's late refusal", async () => {
    const refused = deferred();
    openChannel = () => refused.promise;
    const first = playOnTv(tv);
    openChannel = async () => {};

    const other = { ...tv, id: "tv2", name: "Bedroom TV" };
    expect(await playOnTv(other)).toBeNull();

    refused.reject(new Error("No route to host"));
    expect(await first).toBeNull();
    expect(playbackState.get().tv).toEqual({ kind: "on", tv: other });
  });

  it("gives the TV only the relay's address, and keeps the provider's address and login on the phone", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    expect(given.at(-1)?.uri).toContain(PROVIDER);

    expect(await playOnTv(tv)).toBeNull();
    await relayCloses();

    expect(served.at(-1)).toMatchObject({
      url: `${PROVIDER}.mp4`,
      headers: { "User-Agent": "MrStreamer" },
    });
    const [load] = loads();
    expect(load?.payload).toMatchObject({
      autoplay: true,
      currentTime: 120,
      media: {
        contentId: "http://192.168.1.20:5000/tok1/0.mp4",
        contentType: "video/mp4",
        streamType: "BUFFERED",
        metadata: { title: "Estuary", subtitle: "2026" },
      },
    });
    expect(JSON.stringify(sent)).not.toMatch(/provider|secret|User-Agent/);
    expect(playbackState.get().tv).toEqual({ kind: "on", tv });
    expect(playbackState.get().phase.kind).toBe("playing");
  });

  it("controls the TV: pause, and its own volume", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    togglePause();
    setTvVolume(0.7);
    await settle();
    expect(sent.find((each) => each.payload["type"] === "PAUSE")?.payload).toMatchObject({
      mediaSessionId: 1,
    });
    expect(sent.find((each) => each.payload["type"] === "SET_VOLUME")?.payload).toMatchObject({
      volume: { level: 0.7 },
    });
  });

  it("pauses the TV for a Pause pressed while it connected", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    const connecting = playOnTv(tv);
    togglePause();
    await connecting;
    await relayCloses();
    const kinds = sent.map((each) => each.payload["type"]);
    expect(kinds.includes("PAUSE") || loads()[0]?.payload["autoplay"] === false).toBe(true);
  });

  it("Stop stops the TV's media before the relay goes, and returns the lease only once it closed", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    events = [];
    sent = [];
    holding = true;

    const stopping = stop();
    await settle();
    expect(sent[0]).toMatchObject({ namespace: MEDIA, payload: { type: "STOP" } });
    expect(events).toContain("revoke tok1");
    expect(events.some((each) => each.startsWith("release"))).toBe(false);

    await relayCloses();
    await stopping;
    await settle();
    expect(events.indexOf("revoked tok1")).toBeLessThan(
      events.findIndex((each) => each.startsWith("release")),
    );
    expect(sent.map((each) => each.payload["type"])).toEqual(
      expect.arrayContaining(["STOP", "CLOSE"]),
    );
    expect(playbackState.get().tv).toEqual({ kind: "off" });
  });

  it("refuses a file the TV can't be given, before anything reaches it", async () => {
    await playOnTv(tv);
    void play(title("m2"), file("avi"), options);
    await settle();
    expect(loads()).toEqual([]);
    expect(served).toEqual([]);
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "This file type can't play on a TV.",
    });
  });

  it("refuses a protected channel before anything reaches the TV, and lets go of its lease", async () => {
    await playOnTv(tv);
    playlists.set(
      "http://provider.example/live/1.m3u8",
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts\n',
    );
    void play(
      { ...title("c1"), live: true },
      {
        kind: "live",
        explicit: false,
        candidates: [
          {
            variantId: "v",
            open: async () => ({ url: "http://provider.example/live/1.m3u8", container: "m3u8" }),
          },
        ],
      },
      { watch: true, login: [] },
    );
    await relayCloses();
    expect(loads()).toEqual([]);
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "Its stream is protected, so it can't play on a TV.",
    });
    expect(events.some((each) => each.startsWith("release"))).toBe(true);
  });

  it("plays a channel's HLS live, with the segment format its playlist names", async () => {
    await playOnTv(tv);
    playlists.set(
      "http://provider.example/live/1.m3u8",
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhd/index.m3u8\n",
    );
    playlists.set("http://provider.example/live/hd/index.m3u8", "#EXTM3U\n#EXTINF:6,\nseg1.ts\n");
    void play(
      { ...title("c1"), live: true },
      {
        kind: "live",
        explicit: false,
        candidates: [
          {
            variantId: "v",
            open: async () => ({ url: "http://provider.example/live/1.m3u8", container: "m3u8" }),
          },
        ],
      },
      { watch: true, login: [] },
    );
    await settle();
    expect(loads()[0]?.payload).toMatchObject({
      media: {
        contentId: "http://192.168.1.20:5000/tok1/0.m3u8",
        streamType: "LIVE",
        hlsSegmentFormat: "ts",
        hlsVideoSegmentFormat: "mpeg2_ts",
      },
    });
    expect(loads()[0]?.payload).not.toHaveProperty("currentTime");
  });

  it("says when the phone isn't on Wi-Fi", async () => {
    wifi = false;
    await playOnTv(tv);
    void play(title("m3"), file("mp4"), options);
    await settle();
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "Connect this iPhone to Wi-Fi to play on a TV.",
    });
  });

  it("stops the TV when the app leaves the foreground, holding iOS's time until the relay closed", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    events = [];
    sent = [];
    holding = true;

    emit("onBackground", {});
    await settle();
    expect(sent.map((each) => each.payload["type"])[0]).toBe("STOP");
    expect(events).not.toContain("end background");

    await relayCloses();
    expect(events.indexOf("revoked tok1")).toBeLessThan(events.indexOf("end background"));
    expect(events.some((each) => each.startsWith("release"))).toBe(true);
    expect(playbackState.get().tv).toEqual({ kind: "ended", tv, why: "left" });
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "Stopped on the TV when you left the app.",
    });
  });

  it("says the TV was lost when its connection goes, keeping where the title got to", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvSays(channel, "t1", MEDIA, {
      type: "MEDIA_STATUS",
      status: [{ mediaSessionId: 1, playerState: "PLAYING", currentTime: 300 }],
    });
    emit("onClosed", { channel });
    await relayCloses();
    expect(playbackState.get().phase).toMatchObject({ error: "Lost Living Room TV." });
    expect(events.some((each) => each.startsWith("release"))).toBe(true);

    retry();
    await settle();
    expect(given.at(-1)?.uri).toContain(PROVIDER);
    fakePlayer.ready();
    expect(fakePlayer.currentTime).toBe(300);
  });

  it.each([
    ["interrupts it", { mediaSessionId: 1, playerState: "IDLE", idleReason: "INTERRUPTED" }],
    ["loads its own", { mediaSessionId: 2, playerState: "PLAYING" }],
  ])(
    "ends the TV route when another sender %s, keeping the title's place and their receiver",
    async (_, status) => {
      void play(title("m1"), file("mp4"), options);
      await settle();
      await playOnTv(tv);
      await relayCloses();
      tvSays(channel, "t1", MEDIA, {
        type: "MEDIA_STATUS",
        status: [{ mediaSessionId: 1, playerState: "PLAYING", currentTime: 300 }],
      });
      sent = [];
      tvSays(channel, "t1", MEDIA, { type: "MEDIA_STATUS", status: [status] });
      await relayCloses();
      expect(playbackState.get().tv).toEqual({ kind: "ended", tv, why: "stopped" });
      expect(events.some((each) => each.startsWith("release"))).toBe(true);
      expect(
        sent.some((each) => each.namespace === RECEIVER && each.payload["type"] === "STOP"),
      ).toBe(false);
      retry();
      await settle();
      fakePlayer.ready();
      expect(fakePlayer.currentTime).toBe(300);
    },
  );

  it("says the TV stopped, not that it was lost, when its receiver goes", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvSays(channel, "receiver-0", RECEIVER, {
      type: "RECEIVER_STATUS",
      status: { applications: [] },
    });
    await relayCloses();
    expect(playbackState.get().tv).toEqual({ kind: "ended", tv, why: "stopped" });
    expect(playbackState.get().phase).toMatchObject({
      error: "Living Room TV stopped playing it.",
    });
  });

  it("ends the route when the TV, asked, no longer names this load's media", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    // The fake TV answers this load's next poll with no media at all.
    tvState = "GONE";
    await new Promise((done) => setTimeout(done, 1100));
    await relayCloses();
    expect(playbackState.get().tv).toEqual({ kind: "ended", tv, why: "stopped" });
    expect(events.some((each) => each.startsWith("release"))).toBe(true);
  });

  it("takes a TV with nothing to name after a title finished as finished, not stopped", async () => {
    const ended = vi.fn();
    void play(title("m1"), file("mp4"), { ...options, ended });
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvSays(channel, "t1", MEDIA, {
      type: "MEDIA_STATUS",
      status: [{ mediaSessionId: 1, playerState: "IDLE", idleReason: "FINISHED" }],
    });
    tvState = "GONE";
    await new Promise((done) => setTimeout(done, 1100));
    await settle();
    expect(ended).toHaveBeenCalledOnce();
    expect(playbackState.get().tv).toEqual({ kind: "on", tv });
    expect(playbackState.get().phase.kind).toBe("paused");
  });

  it("keeps where the title got to when the TV fails it", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvSays(channel, "t1", MEDIA, {
      type: "MEDIA_STATUS",
      status: [{ mediaSessionId: 1, playerState: "PLAYING", currentTime: 300 }],
    });
    tvSays(channel, "t1", MEDIA, {
      type: "MEDIA_STATUS",
      status: [{ mediaSessionId: 1, playerState: "IDLE", idleReason: "ERROR" }],
    });
    await relayCloses();
    expect(playbackState.get().phase).toMatchObject({ error: "Living Room TV couldn't play it." });
    playHere();
    await relayCloses();
    fakePlayer.ready();
    expect(fakePlayer.currentTime).toBe(300);
  });

  it("takes no answer to another load's request as this load's end", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvSays(channel, "t1", MEDIA, {
      type: "MEDIA_STATUS",
      requestId: 9999,
      status: [{ mediaSessionId: 7, playerState: "IDLE", idleReason: "FINISHED" }],
    });
    await settle();
    expect(playbackState.get().tv).toEqual({ kind: "on", tv });
    expect(playbackState.get().phase.kind).toBe("playing");
  });

  it("doesn't start the TV when the app leaves while it connects", async () => {
    const connecting = playOnTv(tv);
    emit("onBackground", {});
    await connecting;
    await settle();
    expect(playbackState.get().tv).toEqual({ kind: "off" });
    expect(events).toContain("end background");
  });

  it("Disconnect plays the title here again, from where the TV was", async () => {
    void play(title("m1"), file("mp4"), options);
    await settle();
    await playOnTv(tv);
    await relayCloses();
    tvTime = 300;
    await new Promise((done) => setTimeout(done, 1100));
    await settle();
    given.length = 0;

    playHere();
    await relayCloses();
    expect(given.at(-1)?.uri).toContain(PROVIDER);
    expect(
      sent.some((each) => each.namespace === RECEIVER && each.payload["type"] === "STOP"),
    ).toBe(true);
    expect(playbackState.get().tv).toEqual({ kind: "off" });
    fakePlayer.ready();
    expect(fakePlayer.currentTime).toBe(300);
  });
});
