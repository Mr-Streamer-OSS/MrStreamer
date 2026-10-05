// A fake Cast receiver for tests: a TLS server on 127.0.0.1 that answers a sender as a TV with
// Google's Default Media Receiver does. It frames and reads with protobufjs from Chromium's
// current cast_channel.proto (fixtures/cast), so it shares no code with the adapter's own codec,
// and its certificate is self-signed and made anew each time, as a real receiver's is self-signed.
//
// It answers CONNECT, PING, LAUNCH, GET_STATUS, SET_VOLUME, STOP and the media requests by
// itself. Every message a sender sent is in `received` (`requests(type)` picks one kind), and
// every frame protobufjs doesn't read back byte for byte in `violations`. A test makes it refuse
// or ignore requests through `answers`, or everything with `silent`; plays the part of the TV
// with `status`, `idle`, `setVolume` and `stopApp`; breaks the connection with `drop` and
// `refusing`; and sends anything at all with `send` (any CastMessage fields), `frame` (any bytes
// as one frame) and `write` (any bytes).
//
//   const receiver = await startFakeCastReceiver();
//   const adapter = castAdapter({ discovery: receiver.discovery });
//   const connection = await adapter.connect({ kind: "receiver", id: receiver.receiver.id }, signal);
//   await connection.load(media, signal);
//   receiver.status({ playerState: "PLAYING", currentTime: 12 });
import { generateKeyPairSync, randomUUID, sign, X509Certificate } from "node:crypto";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import type { Receiver } from "@mrstreamer/contracts/output";
import type { CastDiscovery } from "../src/main/receivers/cast/discovery.ts";

const CastMessage = protobuf
  .loadSync(fileURLToPath(new URL("./fixtures/cast/cast_channel.proto", import.meta.url)))
  .lookupType("openscreen.cast.proto.CastMessage");

const CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const RECEIVER = "urn:x-cast:com.google.cast.receiver";
const MEDIA = "urn:x-cast:com.google.cast.media";

/** A CastMessage's fields, as protobufjs names them. */
export interface CastFields {
  protocolVersion?: number;
  sourceId?: string;
  destinationId?: string;
  namespace?: string;
  payloadType?: number;
  payloadUtf8?: string;
  payloadBinary?: Uint8Array;
  continued?: boolean;
  remainingLength?: number;
}

/** A message a sender sent: its fields as protobufjs read them, and its payload's JSON. */
export interface Received extends CastFields {
  readonly payload: Record<string, unknown>;
}

/** The media the receiver holds, as its MEDIA_STATUS lists it. */
export interface FakeMedia {
  mediaSessionId: number;
  playerState: "IDLE" | "BUFFERING" | "PLAYING" | "PAUSED";
  idleReason?: "FINISHED" | "CANCELLED" | "INTERRUPTED" | "ERROR";
  currentTime: number;
  activeTrackIds: number[];
  /** The LOAD's media, with the duration and tracks the receiver read from it. */
  media: Record<string, unknown>;
}

/** DER: a tag, the length, the contents. */
function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? [body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/** A key and a certificate it signed itself, good for twenty years and for nobody's trust. */
function selfSigned(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaWithSha256 = der(0x30, der(0x06, Buffer.from("2a8648ce3d040302", "hex")));
  const commonName = der(0x06, Buffer.from("550403", "hex"));
  const name = der(0x30, der(0x31, der(0x30, commonName, der(0x0c, Buffer.from("Fake Cast")))));
  const validity = der(
    0x30,
    der(0x17, Buffer.from("260101000000Z")),
    der(0x17, Buffer.from("460101000000Z")),
  );
  const spki = publicKey.export({ type: "spki", format: "der" });
  const body = der(0x30, der(0x02, Buffer.from([1])), ecdsaWithSha256, name, validity, name, spki);
  const signature = der(0x03, Buffer.from([0]), sign("sha256", body, privateKey));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: new X509Certificate(der(0x30, body, ecdsaWithSha256, signature)).toString(),
  };
}

export class FakeCastReceiver {
  readonly receiver: Receiver = { id: randomUUID().replaceAll("-", ""), kind: "cast", name: "TV" };
  /** Lists this receiver alone: `castAdapter({ discovery: receiver.discovery })`. */
  readonly discovery: CastDiscovery;
  /** Every message senders sent, oldest first. */
  readonly received: Received[] = [];
  /** Frames senders sent that protobufjs doesn't read, or doesn't write back byte for byte. */
  readonly violations: string[] = [];
  /** Connections senders made so far, refused ones too, and those open now. */
  connections = 0;
  readonly sockets = new Set<TLSSocket>();
  /** How it answers: "refuse" as a receiver that can't, "ignore" with nothing at all. */
  readonly answers: {
    launch: "start" | "refuse" | "ignore";
    load: "take" | "refuse" | "ignore";
    /** Media requests but LOAD: "refuse" answers INVALID_PLAYER_STATE. */
    command: "take" | "refuse" | "ignore";
  } = { launch: "start", load: "take", command: "take" };
  /** Answers nothing while set, pings included, and still records what arrives. */
  silent = false;
  /** Drops every new connection while set. */
  refusing = false;
  /** What a load it takes reports: its length and tracks. */
  duration: number | null = 600;
  tracks: { trackId: number; type: "TEXT" | "AUDIO" | "VIDEO" }[] = [];
  volume = { level: 0.5, muted: false };
  /** The running media app and what it plays. */
  app: { readonly sessionId: string; readonly transportId: string } | null = null;
  media: FakeMedia | null = null;
  readonly port: number;
  private readonly server: Server;
  private mediaSessions = 0;

  constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
    let listener: Parameters<CastDiscovery["listen"]>[0] = () => {};
    this.discovery = {
      listen: (next) => {
        listener = next;
      },
      scan: (on) => {
        if (on) listener([this.receiver]);
      },
      locate: (id) =>
        id === this.receiver.id ? { receiver: this.receiver, host: "127.0.0.1", port } : null,
    };
    server.on("connection", (socket) => {
      this.connections++;
      if (this.refusing) socket.destroy();
    });
    server.on("secureConnection", (socket) => this.accept(socket));
  }

  /** The payloads of the `type` messages senders sent. */
  requests(type: string): Record<string, unknown>[] {
    return this.received.map((message) => message.payload).filter((body) => body.type === type);
  }

  /** `payload` as a CastMessage's bytes, from the media app to every sender unless `fields` say. */
  encode(payload: object, fields: CastFields = {}): Uint8Array {
    return CastMessage.encode({
      protocolVersion: 0,
      sourceId: this.app?.transportId ?? "receiver-0",
      destinationId: "*",
      namespace: MEDIA,
      payloadType: 0,
      payloadUtf8: JSON.stringify(payload),
      ...fields,
    }).finish();
  }

  /** Sends `payload` to every sender, with any CastMessage fields a test wants on it. */
  send(payload: object, fields: CastFields = {}): void {
    this.frame(this.encode(payload, fields));
  }

  /** Sends `body` as one frame, behind its length or the `length` a test claims for it. */
  frame(body: Uint8Array, length = body.length): void {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    this.write(Buffer.concat([header, body]));
  }

  /** Sends bytes as they are. */
  write(bytes: Uint8Array): void {
    for (const socket of this.sockets) socket.write(bytes);
  }

  /** Changes the media it plays and tells every sender, as a TV does when its state changes. */
  status(change: Partial<FakeMedia> = {}): void {
    if (this.media) Object.assign(this.media, change);
    this.send(this.mediaStatus());
  }

  /** Ends the media: played out, stopped on the TV, replaced, or failed. It holds none after. */
  idle(idleReason: NonNullable<FakeMedia["idleReason"]>): void {
    this.status({ playerState: "IDLE", idleReason });
    this.media = null;
  }

  /** Changes the volume as its own remote does. */
  setVolume(level: number, muted: boolean): void {
    this.volume = { level, muted };
    this.send(this.receiverStatus(), { sourceId: "receiver-0", namespace: RECEIVER });
  }

  /** Stops the media app as someone at the TV does. */
  stopApp(): void {
    const transportId = this.app?.transportId;
    this.app = null;
    this.media = null;
    this.send(this.receiverStatus(), { sourceId: "receiver-0", namespace: RECEIVER });
    if (transportId) this.send({ type: "CLOSE" }, { sourceId: transportId, namespace: CONNECTION });
  }

  /** Cuts every connection. */
  drop(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private receiverStatus() {
    const app = { appId: "CC1AD845", displayName: "Default Media Receiver", ...this.app };
    return {
      type: "RECEIVER_STATUS",
      requestId: 0,
      status: {
        // As a TV with nothing running: no list at all.
        ...(this.app ? { applications: [{ ...app, namespaces: [{ name: MEDIA }] }] } : {}),
        volume: { controlType: "attenuation", stepInterval: 0.05, ...this.volume },
      },
    };
  }

  private mediaStatus() {
    const playing = { playbackRate: 1, supportedMediaCommands: 12303, ...this.media };
    return { type: "MEDIA_STATUS", requestId: 0, status: this.media ? [playing] : [] };
  }

  private accept(socket: TLSSocket): void {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const body = buffered.subarray(4, 4 + buffered.readUInt32BE(0));
        buffered = buffered.subarray(4 + body.length);
        this.read(socket, body);
      }
    });
  }

  /** Reads one frame as protobufjs does, and holds the sender to the schema, byte for byte. */
  private read(socket: TLSSocket, body: Buffer): void {
    let fields: CastFields;
    let payload: Record<string, unknown>;
    try {
      const message = CastMessage.decode(body);
      if (!body.equals(CastMessage.encode(message).finish())) throw new Error("not canonical");
      fields = CastMessage.toObject(message);
      payload = JSON.parse(fields.payloadUtf8 ?? "");
    } catch (error) {
      this.violations.push(`${String(error)}: ${body.toString("hex")}`);
      return;
    }
    this.received.push({ ...fields, payload });
    if (this.silent) return;
    const answer = (reply: object) =>
      socket.write(
        this.framed({ ...reply, requestId: payload.requestId }, fields.destinationId, fields),
      );

    if (fields.namespace === HEARTBEAT && payload.type === "PING") answer({ type: "PONG" });
    if (fields.namespace === RECEIVER) this.onReceiver(payload, answer);
    if (fields.namespace === MEDIA && fields.destinationId === this.app?.transportId) {
      this.onMedia(payload, answer);
    }
  }

  private framed(payload: object, sourceId: string | undefined, to: CastFields): Buffer {
    const body = this.encode(payload, {
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(to.sourceId === undefined ? {} : { destinationId: to.sourceId }),
      ...(to.namespace === undefined ? {} : { namespace: to.namespace }),
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  }

  private onReceiver(payload: Record<string, unknown>, answer: (body: object) => void): void {
    switch (payload.type) {
      case "LAUNCH":
        if (this.answers.launch === "ignore") return;
        if (this.answers.launch === "refuse" || payload.appId !== "CC1AD845") {
          return answer({ type: "LAUNCH_ERROR", reason: "NOT_FOUND" });
        }
        this.app = { sessionId: randomUUID(), transportId: `transport-${randomUUID()}` };
        return answer(this.receiverStatus());
      case "GET_STATUS":
        return answer(this.receiverStatus());
      case "SET_VOLUME":
        Object.assign(this.volume, payload.volume);
        return answer(this.receiverStatus());
      case "STOP": {
        const app = this.app;
        if (!app || payload.sessionId !== app.sessionId) {
          return answer({ type: "INVALID_REQUEST", reason: "INVALID_SESSION_ID" });
        }
        this.app = null;
        this.media = null;
        answer(this.receiverStatus());
        return this.send({ type: "CLOSE" }, { sourceId: app.transportId, namespace: CONNECTION });
      }
    }
  }

  private onMedia(payload: Record<string, unknown>, answer: (body: object) => void): void {
    if (payload.type === "GET_STATUS") return answer(this.mediaStatus());
    if (payload.type === "LOAD") {
      if (this.answers.load === "ignore") return;
      if (this.answers.load === "refuse") {
        return answer({ type: "LOAD_FAILED", detailedErrorCode: 104 });
      }
      // What played makes way first, and every sender hears it.
      if (this.media) this.idle("INTERRUPTED");
      this.media = {
        mediaSessionId: ++this.mediaSessions,
        playerState: payload.autoplay === false ? "PAUSED" : "BUFFERING",
        currentTime: typeof payload.currentTime === "number" ? payload.currentTime : 0,
        activeTrackIds: [],
        media: { ...(payload.media as object), duration: this.duration, tracks: this.tracks },
      };
      return answer(this.mediaStatus());
    }
    if (this.answers.command === "ignore") return;
    if (this.answers.command === "refuse") return answer({ type: "INVALID_PLAYER_STATE" });
    const media = this.media;
    if (!media || payload.mediaSessionId !== media.mediaSessionId) {
      return answer({ type: "INVALID_REQUEST", reason: "INVALID_MEDIA_SESSION_ID" });
    }
    switch (payload.type) {
      case "PLAY":
        media.playerState = "PLAYING";
        break;
      case "PAUSE":
        media.playerState = "PAUSED";
        break;
      case "SEEK":
        media.currentTime = Number(payload.currentTime);
        break;
      case "EDIT_TRACKS_INFO":
        media.activeTrackIds = payload.activeTrackIds as number[];
        break;
      case "STOP":
        Object.assign(media, { playerState: "IDLE", idleReason: "CANCELLED" });
        answer(this.mediaStatus());
        this.media = null;
        return;
      default:
        return answer({ type: "INVALID_REQUEST", reason: "INVALID_COMMAND" });
    }
    answer(this.mediaStatus());
  }
}

/** Starts a fake receiver on a free port of 127.0.0.1. Close it when the test ends. */
export async function startFakeCastReceiver(): Promise<FakeCastReceiver> {
  const server = createServer(selfSigned());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return new FakeCastReceiver(server, address.port);
}
