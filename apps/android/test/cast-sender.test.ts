import { expect, it, vi } from "vitest";
import type { Payload } from "../src/cast/sender.ts";

// A protocol stand-in independently decodes production sender frames; no receiver is qualified.
interface Sent {
  readonly to: string;
  readonly namespace: string;
  readonly payload: Payload;
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
      payload: JSON.parse(fields.get(6)!) as Payload,
    });
  }

  return out;
}

/** A frame from the TV. */
function frame(from: string, namespace: string, payload: Payload): string {
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

const emit = (event: string, payload: { channel: string; data?: string } | Record<string, never>) =>
  listeners.get(event)?.(payload as never);

const tvSays = (channel: string, from: string, namespace: string, payload: Payload) =>
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

const armStop = vi.fn();

Object.assign(globalThis, {
  expo: {
    modules: {
      Cast: {
        connect: async () => {},
        write: (channel: string, data: string) => {
          for (const message of readFrames(Buffer.from(data, "base64"))) {
            sent.push(message);
            queueMicrotask(() => answerAsTv(channel, message));
          }
        },
        disconnect: vi.fn(),
        armStop,
        addListener: (event: string, listener: (event: never) => void) => {
          listeners.set(event, listener);

          return { remove: () => listeners.delete(event) };
        },
      },
    },
  },
});

it("launches the open receiver, loads an opaque route, observes status and arms bounded native STOP", async () => {
  const { connectTv } = await import("../src/cast/sender.ts");
  const link = await connectTv({ id: "stand-in", name: "Stand-in", model: null });

  try {
    const status = vi.fn();

    const load = await link.load(
      {
        address: "http://relay.invalid/opaque/0.mp4",
        contentType: "video/mp4",
        live: false,
        segments: null,
        title: "Test",
        from: 42,
      },
      status,
      new AbortController().signal,
    );

    expect(status).toHaveBeenCalledWith({ state: "playing", time: 42, duration: 600 });
    expect(sent.find((message) => message.payload.type === "LOAD")?.payload["media"]).toMatchObject(
      { contentId: "http://relay.invalid/opaque/0.mp4" },
    );
    expect(armStop).toHaveBeenCalledOnce();
    const stop = readFrames(Buffer.from(armStop.mock.calls[0]![1] as string, "base64"))[0]!;
    expect(stop.to).toBe("receiver-0");
    expect(stop.payload).toMatchObject({ type: "STOP", sessionId: "s1" });
    load.seek(51);
    load.pause();
    expect(
      sent.some(
        (message) => message.payload.type === "SEEK" && message.payload["currentTime"] === 51,
      ),
    ).toBe(true);
    await load.stop();
  } finally {
    await link.close();
  }
});
