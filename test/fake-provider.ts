// A fake Xtream Codes provider for tests. Its catalogue has the messiness of real panels:
// prefixed names, separator entries, numbers sent as strings and missing logos. It allows one
// connection at a time by default, like most subscriptions. The category "TEST | Formats and
// failures" streams the recordings in test/fixtures, one codec combination each, plus an offline
// channel; every other channel streams an empty MPEG-TS program.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Writable } from "node:stream";

export interface FakeChannel {
  readonly streamId: number;
  readonly num: number;
  readonly name: string;
  readonly categoryId: string;
  readonly hasLogo: boolean;
  /** Answers 404 instead of a stream. */
  readonly offline: boolean;
  /** File in test/fixtures that the channel streams. */
  readonly fixture: string | null;
}

export interface FakeCatalogue {
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly channels: readonly FakeChannel[];
}

/** Writes a channel's stream to `out` until `signal` aborts or the stream ends. */
export type StreamSource = (channel: FakeChannel, out: Writable, signal: AbortSignal) => void;

export interface FakeProviderOptions {
  readonly channels?: number;
  readonly username?: string;
  readonly password?: string;
  readonly maxConnections?: number;
  readonly accountStatus?: "Active" | "Expired" | "Banned" | "Disabled";
  /** How long a closed stream keeps its connection slot. Real panels often lag behind. */
  readonly slotReleaseMs?: number;
  /** Replaces the default streams. */
  readonly streams?: StreamSource;
  /**
   * Sends recordings at their real-time rate and then keeps the connection open, like a live
   * channel, instead of sending them at once and closing.
   */
  readonly live?: boolean;
}

export interface FakeProvider {
  readonly url: string;
  readonly catalogue: FakeCatalogue;
  /** Streams currently holding a connection slot. */
  activeStreams(): number;
  /** Picks the channel list each later request returns, as panel updates would. */
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  /** Makes catalogue requests answer with this HTTP status, or restores them with null. */
  failCatalogue(status: number | null): void;
  close(): Promise<void>;
}

/** The fixture channels, in the order the test category lists them. */
export const FIXTURE_CHANNELS: readonly { name: string; fixture: string | null }[] = [
  { name: "TEST | H.264 + AAC", fixture: "h264-aac.mpegts" },
  { name: "TEST | H.264 + MP2", fixture: "h264-mp2.mpegts" },
  { name: "TEST | H.264 + MP3", fixture: "h264-mp3.mpegts" },
  { name: "TEST | H.264 + AC-3", fixture: "h264-ac3.mpegts" },
  { name: "TEST | H.264 + AC-3 DVB", fixture: "h264-ac3-dvb.mpegts" },
  { name: "TEST | H.264 + E-AC-3", fixture: "h264-eac3.mpegts" },
  { name: "TEST | HEVC + AAC", fixture: "hevc-aac.mpegts" },
  { name: "TEST | HEVC 10-bit + AAC", fixture: "hevc10-aac.mpegts" },
  { name: "TEST | MPEG-2 + MP2", fixture: "mpeg2-mp2.mpegts" },
  /** An open-GOP broadcast joined mid-sequence: it starts with frames that cannot be decoded. */
  { name: "TEST | H.264 joined mid-stream", fixture: "h264-open-gop-joined.mpegts" },
  /** Lost packets mid-stream, which a decoder has to conceal. */
  { name: "TEST | H.264 damaged", fixture: "h264-damaged.mpegts" },
  { name: "TEST | Offline", fixture: null },
];

export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const username = options.username ?? "demo";
  const password = options.password ?? "demo";
  const maxConnections = options.maxConnections ?? 1;
  const slotReleaseMs = options.slotReleaseMs ?? 300;
  const streams = options.streams ?? (options.live ? liveStreams : defaultStreams);
  const catalogue = buildCatalogue(options.channels ?? 300);
  let select = (all: readonly FakeChannel[]): readonly FakeChannel[] => all;
  let catalogueFailure: number | null = null;
  const channels = new Map(
    catalogue.channels.map((channel) => [String(channel.streamId), channel]),
  );
  let slots = 0;
  let origin = "";

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/player_api.php") return api(url, response);
    const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.ts$/.exec(url.pathname);
    if (live) return stream(live[1] ?? "", live[2] ?? "", live[3] ?? "", request, response);
    response.writeHead(404).end();
  });

  function api(url: URL, response: ServerResponse): void {
    if (
      url.searchParams.get("username") !== username ||
      url.searchParams.get("password") !== password
    ) {
      return json(response, { user_info: { auth: 0 } });
    }
    const action = url.searchParams.get("action");
    if (action === null) {
      const now = Math.floor(Date.now() / 1000);
      return json(response, {
        user_info: {
          username,
          auth: 1,
          status: options.accountStatus ?? "Active",
          exp_date: String(now + 180 * 24 * 60 * 60),
          active_cons: String(slots),
          max_connections: String(maxConnections),
        },
        server_info: { timestamp_now: now },
      });
    }
    if (catalogueFailure !== null && action?.startsWith("get_live")) {
      return void response.writeHead(catalogueFailure).end();
    }
    if (action === "get_live_categories") {
      return json(
        response,
        catalogue.categories.map((category) => ({
          category_id: category.id,
          category_name: category.name,
          parent_id: 0,
        })),
      );
    }
    if (action === "get_live_streams") {
      return json(
        response,
        select(catalogue.channels).map((channel) => ({
          // Real panels mix numbers and numeric strings.
          num: channel.num % 3 === 0 ? String(channel.num) : channel.num,
          name: channel.name,
          stream_type: "live",
          stream_id: channel.streamId,
          stream_icon: channel.hasLogo ? `${origin}/logos/${channel.streamId}.svg` : "",
          category_id: channel.categoryId,
          category_ids: [Number(channel.categoryId)],
        })),
      );
    }
    json(response, []);
  }

  function stream(
    user: string,
    pass: string,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const channel = channels.get(id);
    if (decodeURIComponent(user) !== username || decodeURIComponent(pass) !== password) {
      return void response.writeHead(401).end();
    }
    if (!channel || channel.offline) return void response.writeHead(404).end();
    if (slots >= maxConnections) return void response.writeHead(403).end();

    slots++;
    const closed = new AbortController();
    request.on("close", () => {
      if (closed.signal.aborted) return;
      closed.abort();
      setTimeout(() => slots--, slotReleaseMs);
    });
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    streams(channel, response, closed.signal);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake provider has no address.");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: origin,
    catalogue,
    activeStreams: () => slots,
    serveChannels(next) {
      select = next;
    },
    failCatalogue(status) {
      catalogueFailure = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Reads a recording from test/fixtures. */
export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Fixture channels send their recording once; the rest send an empty program without end. */
const defaultStreams: StreamSource = (channel, out, signal) => {
  if (channel.fixture) {
    out.end(fixture(channel.fixture));
    return;
  }
  out.write(EMPTY_PROGRAM);
  const timer = setInterval(() => out.write(NULL_PACKETS), 20);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
};

/** Recordings play out over their three seconds, then the connection stays open without data. */
const liveStreams: StreamSource = (channel, out, signal) => {
  if (!channel.fixture) return defaultStreams(channel, out, signal);
  const recording = fixture(channel.fixture);
  const step = Math.ceil(recording.length / 30);
  let offset = 0;
  const timer = setInterval(() => {
    out.write(recording.subarray(offset, offset + step));
    offset += step;
    if (offset >= recording.length) clearInterval(timer);
  }, 100);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
};

/** Builds a catalogue of roughly `size` channels. The same size always gives the same catalogue. */
export function buildCatalogue(size: number): FakeCatalogue {
  const random = mulberry32(size);
  const pick = (items: readonly string[]): string =>
    items[Math.floor(random() * items.length)] ?? items[0] ?? "";

  const categories = [{ id: "1", name: "TEST | Formats and failures" }];
  const channels: FakeChannel[] = FIXTURE_CHANNELS.map((test, index) => ({
    streamId: 1000 + index,
    num: index + 1,
    name: test.name,
    categoryId: "1",
    hasLogo: false,
    offline: test.fixture === null,
    fixture: test.fixture,
  }));

  const groups = REGIONS.flatMap((region) => GENRES.map((genre) => `${region} | ${genre}`));
  const perGroup = Math.max(1, Math.ceil((size - channels.length) / groups.length));
  for (const [groupIndex, group] of groups.entries()) {
    const categoryId = String(groupIndex + 2);
    categories.push({ id: categoryId, name: group });
    const region = group.split(" | ")[0] ?? "UK";
    // Many panels open each group with a separator "channel".
    channels.push({
      streamId: 2000 + channels.length,
      num: channels.length + 1,
      name: `##### ${group.toUpperCase()} #####`,
      categoryId,
      hasLogo: false,
      offline: true,
      fixture: null,
    });
    for (let i = 0; i < perGroup && channels.length < size; i++) {
      const style = random();
      const base = `${pick(WORDS)}${pick(SUFFIXES)}${pick(QUALITY)}`.toUpperCase();
      const name = style < 0.4 ? `${region}: ${base}` : style < 0.6 ? `${region} | ${base}` : base;
      channels.push({
        streamId: 2000 + channels.length,
        num: channels.length + 1,
        name,
        categoryId,
        hasLogo: random() < 0.7,
        offline: false,
        fixture: null,
      });
    }
  }
  return { categories, channels };
}

const REGIONS = ["UK", "NL", "BE", "DE", "FR", "US", "ES", "IT", "PL", "PT"];
const GENRES = ["Entertainment", "Sports", "News", "Kids", "Documentary", "Movies", "Music"];
const WORDS = [
  "Earth",
  "Arena",
  "Culture",
  "North",
  "City",
  "Atlas",
  "Harbour",
  "Cinema",
  "Melody",
  "Summit",
  "River",
  "Coast",
  "Valley",
  "Metro",
  "Studio",
  "Planet",
  "Forum",
  "Local",
  "Open",
  "Prime",
  "Nova",
  "Delta",
  "Orbit",
  "Pulse",
  "Zenith",
  "Lumen",
  "Vista",
  "Echo",
  "Signal",
  "Horizon",
];
const SUFFIXES = ["", " 1", " 2", " 3", " Plus", " Max", " Xtra", " Live", " 24"];
const QUALITY = ["", " HD", " FHD", " HD", " 4K", " SD"];

/** Small seeded PRNG so catalogues are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Seven MPEG-TS null packets, sent every 20 ms to keep an empty program flowing. */
const NULL_PACKETS = (() => {
  const packets = Buffer.alloc(188 * 7, 0xff);
  for (let offset = 0; offset < packets.length; offset += 188) {
    packets.set([0x47, 0x1f, 0xff, 0x10], offset);
  }
  return packets;
})();

/** A program table naming one program without tracks. */
const EMPTY_PROGRAM = Buffer.concat([
  psiPacket(0x0000, [0x00, ...u16(0xb00d), ...u16(1), 0xc1, 0x00, 0x00, ...u16(1), ...u16(0xe100)]),
  psiPacket(0x0100, [
    0x02,
    ...u16(0xb00d),
    ...u16(1),
    0xc1,
    0x00,
    0x00,
    ...u16(0xffff),
    ...u16(0xf000),
  ]),
]);

/** One transport packet carrying a PSI section, with its CRC. */
function psiPacket(pid: number, section: number[]): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section, ...u32(crc32(section))]);
  return packet;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** CRC-32/MPEG-2, the checksum of every PSI section. */
function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}
