// Loopback HLS compatibility fixture, shared by public-service and built-app verification.
import { createServer } from "node:http";
import { fixture } from "./fake-provider.ts";

export async function startFakeHls(
  options: {
    readonly realtime?: boolean;
    /**
     * Its playlists go on without end, a segment every `segmentMs` (3000 unless given), listing
     * the last four, each after a discontinuity.
     */
    readonly live?: { readonly segmentMs?: number };
    /** A playlist's address sends on to the same one under a token, as a panel's session. */
    readonly tokens?: boolean;
  } = {},
) {
  const began = Date.now();
  let origin = "";
  let active = 0;
  let peak = 0;
  let bytes = 0;
  const requests: string[] = [];
  const stalls = new Map<string, number>();
  const failures = new Set<string>();
  const resources: { path: string; range: string | undefined; agent: string | undefined }[] = [];
  const overrides = new Map<
    string,
    {
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Buffer | (() => string | Buffer);
    }
  >();
  const live = (kind: string, segmentMs: number) => {
    // Four segments in from the start, as a stream already running.
    const last = Math.floor((Date.now() - began) / segmentMs) + 3;
    const first = Math.max(0, last - 3);
    return [
      "#EXTM3U",
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentMs / 1000)}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${first}`,
      ...Array.from({ length: last - first + 1 }, (_, index) => [
        ...(index > 0 ? ["#EXT-X-DISCONTINUITY"] : []),
        `#EXTINF:${(segmentMs / 1000).toFixed(3)},`,
        `${kind}-${first + index}.ts`,
      ]).flat(),
      "",
    ].join("\n");
  };
  const media = (kind: string) =>
    options.live
      ? live(kind, options.live.segmentMs ?? 3000)
      : [
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXT-X-MEDIA-SEQUENCE:0",
          ...Array.from({ length: kind === "archive" ? 40 : 4 }, (_, index) => [
            ...(index % 2 ? ["#EXT-X-DISCONTINUITY"] : []),
            "#EXTINF:6,",
            `${kind}-${index}.ts`,
          ]).flat(),
          "#EXT-X-ENDLIST",
          "",
        ].join("\n");
  const names = ["compatible", "ac3", "epochs", "archive", "excluded"];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push(path);
    resources.push({ path, range: request.headers.range, agent: request.headers["user-agent"] });
    if (failures.has(path)) return response.destroy();
    if (path.startsWith("/media/")) {
      active++;
      peak = Math.max(peak, active);
      response.once("close", () => active--);
      if (request.headers["user-agent"] !== "HlsFixture/1.0") return response.writeHead(403).end();
    }
    const override = overrides.get(path);
    if (override)
      return response
        .writeHead(override.status ?? 200, override.headers)
        .end(typeof override.body === "function" ? override.body() : override.body);
    if (path === "/list.m3u")
      return response.end(
        [
          `#EXTM3U x-tvg-url="${origin}/guide.xml"`,
          ...names.flatMap((name) => [
            `#EXTINF:-1 tvg-id="${name}.test" group-title="Test" catchup="append" catchup-days="2" catchup-source="?utc={utc}&lutc={utcend}" http-user-agent="HlsFixture/1.0",TEST | HLS ${name}`,
            `${origin}/media/${name}.m3u8`,
          ]),
          "",
        ].join("\n"),
      );
    if (path === "/guide.xml") {
      const time = (at: number) =>
        new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
      const start = Math.floor(Date.now() / 60000) * 60000 - 120000;
      return response.end(
        `<tv>${names.map((name) => `<programme channel="${name}.test" start="${time(start)}" stop="${time(start + 60000)}"><title>HLS recording</title></programme><programme channel="${name}.test" start="${time(start + 60000)}" stop="${time(start + 3600000)}"><title>Test card</title></programme>`).join("")}</tv>`,
      );
    }
    if (options.tokens && /^\/media\/[\w-]+\.m3u8$/.test(path))
      return response.writeHead(302, { Location: path.replace("/media/", "/media/t1/") }).end();
    const name = /^\/media\/(?:t\d+\/)?([\w-]+)\.m3u8$/.exec(path)?.[1];
    if (name)
      return response
        .writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" })
        .end(
          name === "epochs" || name === "archive"
            ? `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=256x144,CODECS="mp2v.61,ac-3"\n${name}-selected.m3u8\n`
            : name === "excluded"
              ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"\nac3.m3u8\n'
              : media(name.replace("-selected", "")),
        );
    const segment = /^\/media\/(?:t\d+\/)?([\w-]+)-(\d+)\.ts$/.exec(path);
    if (!segment) return response.writeHead(404).end();
    const kind = segment[1];
    const body = fixture(
      kind === "compatible"
        ? "h264-aac.mpegts"
        : kind === "ac3"
          ? "h264-ac3.mpegts"
          : `hls-epoch-${Number(segment[2]) % 2}.mpegts`,
    );
    bytes += body.length;
    if (stalls.has(path)) {
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.write(body.subarray(0, stalls.get(path)));
      return;
    }
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    if (!options.realtime) return response.end(body);
    const step = Math.ceil(body.length / 120 / 188) * 188;
    let offset = 0;
    const timer = setInterval(() => {
      response.write(body.subarray(offset, offset + step));
      offset += step;
      if (offset >= body.length) {
        clearInterval(timer);
        response.end();
      }
    }, 50);
    response.once("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    link: `${origin}/list.m3u`,
    origin,
    requests: () => requests,
    overrides,
    stalls,
    failures,
    resources,
    stats: () => ({ active, peak, bytes }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
