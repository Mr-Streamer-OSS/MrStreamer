// A synthetic subscription for the iOS app on the simulator. The desktop tests' fake Xtream panel
// (apps/desktop/test/fake-provider.ts) answers the API, with its messy catalogue of thousands of
// channels, its logins and its failures. In front of it this server adds what the panel lacks and
// real panels have: each live channel as HLS (`/live/<user>/<pass>/<id>.m3u8`), which AVPlayer
// plays where it can't play the panel's MPEG-TS.
//
//   node scripts/fixture-server.ts [port] [control port]
//
// The app connects to http://127.0.0.1:<port> as "fixture" / "fixture-pass", or as the
// FIXTURE_USERNAME / FIXTURE_PASSWORD given, such as the canaries scripts/log-scan.ts looks for.
// FIXTURE_SECOND=1 makes it another provider beside the first, on other ports: the fake panel's
// `second`, numbering channels, movies and series as the first does, some of the first's movies
// under ids of its own. Its requests are logged to requests-<port>.jsonl, and it says where it runs in server-<port>.json.
// Everything it writes goes to .local/ios-fixture, or to FIXTURE_OUT, a directory of a session's
// own, where it also makes its media and declares, in provenance.json (provenance-<port>.json for
// a second provider), where each piece came from (scripts/native-fixtures/media.ts).
//
// Every channel is a live loop: the TEST channels loop their recording from
// apps/desktop/test/fixtures, codecs as they are, so the ones AVPlayer can't decode fail as they
// would; every other channel loops a 720p H.264 + AAC test picture made here with ffmpeg, light
// for even ids and dark for odd ones, apart from "BE | KWALITEIT 1": its HD stream is a heavier
// 720p picture (about 2.6 Mbit/s) and its SD one a light 360p one (about 0.5 Mbit/s), so a paced
// link (`/live-link`) carries one and not the other. Each request is logged without the login, to
// .local/ios-fixture/requests.jsonl. Stream 7999, "TEST | Live sound and subtitles (EN/NL)",
// declares sound and subtitle renditions instead (scripts/native-fixtures/tracks.ts). The
// channels with catch-up answer their timeshift addresses with `.m3u8` as HLS recordings
// (scripts/native-fixtures/catch-up.ts); with `.ts` the panel answers them.
//
// Movies and episodes are the panel's (FIXTURE_TITLES, about 120 by default, sizes the lists),
// with their files served here, byte ranges and all, since the panel's own redirect names a port
// the simulator can't reach, at a pace, breaking off or changing as the control port says
// (scripts/native-fixtures/transfers.ts). The TEST titles stream their clips from apps/desktop/test/fixtures
// as they are (MKV, AVI, MPEG-TS, MOV and MP4), so what AVPlayer can't open fails as it would;
// every other title streams a ten-minute H.264 + AAC feature made here, long enough to resume.
// A fake TMDB (apps/desktop/test/fake-tmdb.ts) answers under /tmdb/3. It answers TMDB's API only:
// the app builds its pictures' addresses on image.tmdb.org whatever API it is given, and the
// panel's posters are on image.example, so neither comes from here.
//
// FIXTURE_PROFILE=measure serves the movies and series for measuring the Movies and Series tabs
// (`measurementTitles` in the fake panel): known titles in 4K and UHD, and known ones added two
// and fifteen days before FIXTURE_ANCHOR, epoch seconds, the fake panel's TITLES_ADDED unless
// given, so New holds them while the app's clock reads up to three days after it. The lists keep
// their ids and sizes. What it declares, with a hash of the titles, is in server.json and at the
// control port's /profile. FIXTURE_PROFILE=browse adds the titles a Search and Watchlist journey
// needs, with controls of its own; see scripts/browse-profile.ts. FIXTURE_LOGOS=png lists channel
// logos as PNG marks (`pngLogo`) at this server's address, which passes them on from the panel and
// logs them, in place of the SVG addresses the panel lists at its own port without serving them.
// With them, FIXTURE_ART_CACHEABLE=1 answers the logos with `Cache-Control: public,
// max-age=86400`, as a panel letting caches keep them would, and FIXTURE_ART_LOGIN=1 lists each
// logo's address with the login in its query, as some panels do; the log leaves the query out.
//
// The control port listens on the workbench only and is never tunnelled to the Mac:
//   POST /fail-catalogue?status=503    channel and category lists answer that; status=none restores
//   POST /fail-live?id=<id>&count=<n>  the next n playlists of that channel, live or catch-up,
//                                      answer 503
//   GET  /requests?since=<epoch ms>    the logged requests
//   GET  /live                         channels asked for in the last six seconds
//   GET  /past                         channels whose catch-up was asked for in the last six seconds
//   GET  /titles                       movie and episode files asked for in the last six seconds
//   POST /fail-titles?status=503       the next title file requests answer that; status=none restores
//   POST /fail-title-lists?status=503  movie and series lists, their categories and details answer
//                                      that; status=login refuses the login for the two lists, as
//                                      panels do; status=none restores
//   GET  /profile                      what FIXTURE_PROFILE=measure or browse declares, when on
//   POST /delay-details?ms=8000        movie and series details answer that much later; ms=0 restores
//   POST /live-lists?unlist=<ids>      channel lists leave out those streams, which answer 404;
//                                      unlist= lists them all again; see scripts/live-lists.ts
//   GET  /live-lists                   the streams left out
//   POST, GET /title-transfers         how title files are sent; see scripts/native-fixtures/transfers.ts
//   GET  /provenance                   where the media served came from, as provenance.json says
//   POST, GET /live-link               the pace live segments are sent at; see
//                                      scripts/native-fixtures/live-link.ts
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { basename, join, resolve } from "node:path";
import {
  measurementTitles,
  pngLogo,
  QUALITY_STREAM_IDS,
  startFakeProvider,
  TITLES_ADDED,
  type FakeChannel,
  type FakeTitles,
} from "../../desktop/test/fake-provider.ts";
import { startFakeTmdb } from "../../desktop/test/fake-tmdb.ts";
import { browseControls, browseTitles } from "./browse-profile.ts";
import { liveLists } from "./live-lists.ts";
import { catchUpPlaylist } from "./native-fixtures/catch-up.ts";
import { liveLink } from "./native-fixtures/live-link.ts";
import { livePlaylist, mediaMaker, type Media } from "./native-fixtures/media.ts";
import { liveTracks, tracksChannel, TRACKS_STREAM_ID } from "./native-fixtures/tracks.ts";
import { titleTransfers } from "./native-fixtures/transfers.ts";

const USERNAME = process.env.FIXTURE_USERNAME ?? "fixture";
const PASSWORD = process.env.FIXTURE_PASSWORD ?? "fixture-pass";
const CHANNELS = 6000;
/** A channel counts as playing while it was asked for this recently. */
const PLAYING_MS = 6_000;

const port = Number(process.argv[2] ?? 8791);
const controlPort = Number(process.argv[3] ?? 8792);
const root = join(import.meta.dirname, "../../..");
const out = resolve(process.env.FIXTURE_OUT ?? join(root, ".local/ios-fixture"));
const fixtures = join(root, "apps/desktop/test/fixtures");
mkdirSync(out, { recursive: true });
const second = process.env.FIXTURE_SECOND === "1";
const pngLogos = process.env.FIXTURE_LOGOS === "png";
const cacheableArt = pngLogos && process.env.FIXTURE_ART_CACHEABLE === "1";
const artLogin =
  pngLogos && process.env.FIXTURE_ART_LOGIN === "1"
    ? `?username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`
    : "";
const log = join(out, second ? `requests-${port}.jsonl` : "requests.jsonl");

const maker = mediaMaker(root, out, second ? `provenance-${port}.json` : "provenance.json");

/**
 * A minute of test picture with its clock, inset on a light or a dark field, and a tone: 720p at
 * about 1.5 Mbit/s, or with `capped`, that size at that constant video rate.
 */
function picture(name: string, field: string, capped?: { size: string; rate: string }): Media {
  const { size, rate } = capped ?? { size: "1280x720", rate: "1500k" };
  return maker.make(name, [
    ...["-f", "lavfi", "-i", `color=c=${field}:s=${size}:r=30:d=60`],
    ...["-f", "lavfi", "-i", "testsrc=s=480x270:r=30:d=60"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=60"],
    ...["-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]"],
    ...["-map", "[v]", "-map", "2"],
    ...["-c:v", "libx264", "-profile:v", "high", "-g", "60", "-sc_threshold", "0", "-b:v", rate],
    // Constant rate, padded, since a test picture alone compresses to a fraction of it.
    ...(capped
      ? ["-minrate", rate, "-maxrate", rate, "-bufsize", rate, "-x264-params", "nal-hrd=cbr"]
      : []),
    ...["-c:a", "aac", "-b:a", "128k"],
  ]);
}

const light = picture("light", "0xF2F2F2");
/** "BE | KWALITEIT 1"'s HD and SD streams, by stream id: Full HD is off air. */
const qualities = new Map([
  [QUALITY_STREAM_IDS + 1, picture("quality-hd", "0x203040", { size: "1280x720", rate: "2500k" })],
  [QUALITY_STREAM_IDS + 2, picture("quality-sd", "0x402030", { size: "640x360", rate: "400k" })],
]);
/**
 * What catch-up channels recorded: ten minutes of test picture whose counter shows the seconds
 * since the programme's start, and a 550 Hz tone, apart from any channel's live picture.
 */
const past = maker.make("past", [
  ...["-f", "lavfi", "-i", "testsrc=s=640x360:r=25:d=600"],
  ...["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:d=600"],
  ...["-c:v", "libx264", "-profile:v", "main", "-g", "50", "-sc_threshold", "0", "-b:v", "400k"],
  ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"],
]);
const dark = picture("dark", "0x050505");
const recordings = new Map<string, Media>();
/** A TEST channel's recording, its streams copied as they are. */
function recording(file: string): Media {
  let found = recordings.get(file);
  if (!found) {
    found = maker.make(file.replace(/\W/g, "-"), ["-i", join(fixtures, file), "-c", "copy"]);
    recordings.set(file, found);
  }
  return found;
}

const browsing = process.env.FIXTURE_PROFILE === "browse";
const provider = await startFakeProvider({
  channels: CHANNELS,
  titles: Number(process.env.FIXTURE_TITLES ?? 120),
  username: USERNAME,
  password: PASSWORD,
  second,
  channelOf: tracksChannel,
  ...(pngLogos ? { logoPng: pngLogo } : {}),
  ...(browsing ? { titlesOf: (built: FakeTitles) => browseTitles(built, second) } : {}),
});
const browse = browsing ? browseControls(provider, second) : null;
const lists = liveLists(provider);
// Lists the browse profile holds are answered as the server stops, which the signal then does.
if (browse) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      browse.stop();
      setTimeout(() => process.kill(process.pid, signal), 250);
    });
  }
}
/** What the measurement profile declares about the titles it serves, when it is on. */
const profile =
  process.env.FIXTURE_PROFILE === "measure"
    ? (() => {
        const anchor = Number(process.env.FIXTURE_ANCHOR ?? TITLES_ADDED);
        // Epoch seconds: an anchor in milliseconds would date every title far in the future.
        if (!Number.isInteger(anchor) || anchor <= 0 || anchor >= 1e11) {
          throw new Error("FIXTURE_ANCHOR is a moment in epoch seconds");
        }
        const { titles, ...declared } = measurementTitles(provider.titles, anchor);
        provider.serveTitles(() => titles);
        const sha256 = createHash("sha256").update(JSON.stringify(titles)).digest("hex");
        return { name: "measure", ...declared, sha256 };
      })()
    : (browse?.declared ?? null);
const tmdb = await startFakeTmdb();
// One service streams the first movies and series it is told about.
tmdb.stream(
  "movie",
  provider.titles.movies.slice(12, 40).map((movie) => String(movie.id + 10_000)),
);
tmdb.stream(
  "tv",
  provider.titles.series.slice(0, 6).map((series) => series.tmdb ?? String(series.id + 10_000)),
);

/** Ten minutes of test picture with its clock and a tone, for titles to resume partway. */
const feature = maker.file(
  "feature",
  [
    ...["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=600"],
    ...["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:d=600"],
    ...["-c:v", "libx264", "-profile:v", "main", "-g", "50", "-b:v", "300k", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"],
  ],
  "feature.mp4",
);
/** What each movie's and episode's address streams: a file, or null for a missing one. */
const titleFiles = new Map<string, string | null>();
const fileOf = (name: string, fixture: string | null) =>
  fixture === null ? null : name.startsWith("TEST") ? join(fixtures, fixture) : feature;
for (const movie of provider.titles.movies) {
  titleFiles.set(`movie/${movie.id}`, fileOf(movie.name, movie.fixture));
}
for (const series of provider.titles.series) {
  for (const episode of series.seasons.flat()) {
    titleFiles.set(`series/${episode.id}`, fileOf(series.name, episode.fixture));
  }
}
for (const file of new Set(titleFiles.values())) {
  if (file && file !== feature) maker.served(basename(file), file);
}
const transfers = titleTransfers((title) => titleFiles.has(title));
const link = liveLink();
/** Title file requests left to answer with a failure, and its status. */
let titleFailure: number | null = null;
/** How long movie and series details wait before the panel is asked. */
let detailsDelay = 0;
const channels = new Map(provider.catalogue.channels.map((each) => [String(each.streamId), each]));
if (!channels.get(String(TRACKS_STREAM_ID))?.name.startsWith("TEST")) {
  throw new Error(`The panel lists no stream ${TRACKS_STREAM_ID} to give sound and subtitles`);
}
const mediaOf = (channel: FakeChannel): Media | null =>
  channel.offline
    ? null
    : channel.fixture
      ? recording(channel.fixture)
      : (qualities.get(channel.streamId) ?? (channel.streamId % 2 === 0 ? light : dark));

const started = Date.now();
const tracks = liveTracks(maker, started);
/** Playlists of a channel left to answer with 503, by its id. */
const failing = new Map<string, number>();

interface Logged {
  readonly at: number;
  readonly kind: "api" | "playlist" | "segment" | "archive" | "title" | "tmdb" | "other";
  readonly channel?: string;
  readonly status: number;
  readonly path: string;
  /** The byte range a title request asked for. */
  readonly range?: string;
}
const requests: Logged[] = [];
function record(entry: Logged) {
  requests.push(entry);
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}
/** A live path with whatever login it carries, and any query, left out. */
const redacted = (path: string) =>
  path
    .replace(/\?.*$/, "")
    .replace(/^\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\//, "/$1/<login>/");

function answer(response: ServerResponse, status: number, type: string, body: string | Buffer) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

const panel = new URL(provider.url);
/**
 * Sends the panel's answer with its addresses moved here, so the logos it lists are asked for
 * through this server, where they are logged, at the port the simulator reaches.
 */
function sendHere(reply: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  reply.on("data", (chunk: Buffer) => chunks.push(chunk));
  reply.on("end", () => {
    const body = Buffer.concat(chunks)
      .toString("utf8")
      .replaceAll(panel.origin, `http://127.0.0.1:${port}`)
      .replace(/(\/logos\/\d+\.png)/g, `$1${artLogin}`);
    const { "content-length": _length, "transfer-encoding": _encoding, ...headers } = reply.headers;
    response.writeHead(reply.statusCode ?? 502, headers).end(body);
  });
}
const loggedIn = (user = "", pass = "") =>
  decodeURIComponent(user) === USERNAME && decodeURIComponent(pass) === PASSWORD;
/**
 * The status of a playlist of channel `id` asked for with `user` and `pass`, which the channel can
 * answer when `found`: a refused login, 404, one of the failures `/fail-live` left, or 200.
 */
function playlistStatus(
  id: string,
  user: string | undefined,
  pass: string | undefined,
  found: boolean,
) {
  const left = failing.get(id) ?? 0;
  const status = !loggedIn(user, pass) ? 401 : !found ? 404 : left > 0 ? 503 : 200;
  if (status === 503) failing.set(id, left - 1);
  return status;
}
const listed = (id: string) => (lists.unlisted(id) ? undefined : channels.get(id));
const playlistType = "application/vnd.apple.mpegurl";

createServer((request, response) => {
  const path = request.url ?? "/";
  const url = new URL(path, "http://fixture.test");
  const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.m3u8$/.exec(url.pathname);
  if (live) {
    const [, user, pass, id = ""] = live;
    const channel = listed(id);
    const found = channel ? mediaOf(channel) : null;
    const playlist =
      channel?.streamId === TRACKS_STREAM_ID
        ? tracks.playlist()
        : found && livePlaylist(found, started, (n) => `/hls/${id}/${n}.ts`);
    const status = playlistStatus(id, user, pass, !!playlist);
    record({ at: Date.now(), kind: "playlist", channel: id, status, path: redacted(path) });
    if (status !== 200 || !playlist) return answer(response, status, "text/plain", "");
    return answer(response, 200, playlistType, playlist);
  }
  const shifted = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([\d:-]+)\/(\d+)\.m3u8$/.exec(
    url.pathname,
  );
  if (shifted) {
    const [, user, pass, minutes = "", start = "", id = ""] = shifted;
    const channel = listed(id);
    const days = channel?.archiveDays;
    const recorded = catchUpPlaylist({ id, days, media: past }, Number(minutes), start);
    const status = playlistStatus(id, user, pass, recorded !== null);
    record({ at: Date.now(), kind: "archive", channel: id, status, path: redacted(path) });
    if (status !== 200 || recorded === null) return answer(response, status, "text/plain", "");
    return answer(response, 200, playlistType, recorded);
  }
  const hls = /^\/hls\/(\d+)\/(.+)$/.exec(url.pathname);
  if (hls) {
    const [, id = "", rest = ""] = hls;
    const channel = listed(id);
    const n = /^(past\/)?(\d+)\.ts$/.exec(rest);
    if (n) {
      const found = !channel ? null : n[1] ? (channel.archiveDays ? past : null) : mediaOf(channel);
      const file = found?.segments[Number(n[2]) % found.segments.length]?.file;
      const kind = n[1] ? "archive" : "segment";
      record({ at: Date.now(), kind, channel: id, status: found && file ? 200 : 404, path });
      if (!found || !file) return answer(response, 404, "text/plain", "");
      const body = readFileSync(join(found.dir, file));
      return n[1] ? answer(response, 200, "video/mp2t", body) : link.send(response, body);
    }
    const served = channel?.streamId === TRACKS_STREAM_ID ? tracks.serve(rest) : undefined;
    const kind = rest.endsWith(".m3u8") ? "playlist" : "segment";
    record({ at: Date.now(), kind, channel: id, status: served ? 200 : 404, path });
    if (!served) return answer(response, 404, "text/plain", "");
    return answer(response, 200, served.type, served.body);
  }
  const title = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/.exec(url.pathname);
  if (title) {
    const [, folder = "", user, pass, id = ""] = title;
    const file = titleFiles.get(`${folder}/${id}`);
    const status = !loggedIn(user, pass)
      ? 401
      : titleFailure !== null
        ? titleFailure
        : !file
          ? 404
          : transfers.send(`${folder}/${id}`, file, request, response);
    const range = request.headers.range;
    record({
      at: Date.now(),
      kind: "title",
      channel: id,
      status,
      path: redacted(path),
      ...(range ? { range } : {}),
    });
    if (status !== 200 && status !== 206 && status !== 416)
      answer(response, status, "text/plain", "");
    return;
  }
  const tmdbPath = /^\/tmdb(\/3\/.*)$/.exec(path);
  if (tmdbPath) {
    const target = new URL(tmdb.url);
    const upstream = forward(
      { host: target.hostname, port: target.port, method: request.method, path: tmdbPath[1] },
      (reply) => {
        record({ at: Date.now(), kind: "tmdb", status: reply.statusCode ?? 0, path: url.pathname });
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => answer(response, 502, "text/plain", ""));
    request.pipe(upstream);
    return;
  }
  // Everything else is the panel's own: its API, logos and guide. Details can be held back.
  const action = url.searchParams.get("action");
  const wait = action === "get_vod_info" || action === "get_series_info" ? detailsDelay : 0;
  setTimeout(() => {
    const upstream = forward(
      {
        host: panel.hostname,
        port: panel.port,
        method: request.method,
        path,
        headers: { ...request.headers, host: panel.host },
      },
      (reply) => {
        record({
          at: Date.now(),
          kind: url.pathname === "/player_api.php" ? "api" : "other",
          status: reply.statusCode ?? 0,
          path: `${redacted(url.pathname)}${action ? `?action=${action}` : ""}`,
        });
        if (pngLogos && action === "get_live_streams") return sendHere(reply, response);
        const cacheable = cacheableArt && url.pathname.startsWith("/logos/");
        response.writeHead(
          reply.statusCode ?? 502,
          cacheable
            ? { ...reply.headers, "cache-control": "public, max-age=86400" }
            : reply.headers,
        );
        reply.pipe(response);
      },
    );
    upstream.on("error", () => answer(response, 502, "text/plain", ""));
    request.pipe(upstream);
  }, wait);
}).listen(port, "127.0.0.1");

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://control.test");
  const json = (body: unknown) => answer(response, 200, "application/json", JSON.stringify(body));
  const method = request.method ?? "GET";
  const browsed =
    browse?.control(method, url) ??
    lists.control(method, url) ??
    transfers.control(method, url) ??
    link.control(method, url);
  if (browsed)
    return answer(response, browsed.status, "application/json", JSON.stringify(browsed.body));
  if (request.method === "POST" && url.pathname === "/fail-catalogue") {
    const status = url.searchParams.get("status");
    provider.failCatalogue(status && status !== "none" ? Number(status) : null);
    return json({ catalogue: status });
  }
  if (request.method === "POST" && url.pathname === "/fail-live") {
    failing.set(url.searchParams.get("id") ?? "", Number(url.searchParams.get("count") ?? 1));
    return json(Object.fromEntries(failing));
  }
  if (url.pathname === "/requests") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return json(requests.filter((each) => each.at >= since));
  }
  if (request.method === "POST" && url.pathname === "/fail-titles") {
    const status = url.searchParams.get("status");
    titleFailure = status && status !== "none" ? Number(status) : null;
    return json({ titles: titleFailure });
  }
  if (request.method === "POST" && url.pathname === "/fail-title-lists") {
    const status = url.searchParams.get("status");
    const failure =
      status === "login" ? "login" : status && status !== "none" ? Number(status) : null;
    if (
      typeof failure === "number" &&
      !(Number.isInteger(failure) && failure >= 400 && failure < 600)
    )
      return answer(response, 400, "text/plain", "");
    provider.failTitles(failure);
    return json({ titleLists: failure });
  }
  if (url.pathname === "/profile" && profile) return json(profile);
  if (url.pathname === "/provenance") return json(maker.provenance());
  if (request.method === "POST" && url.pathname === "/delay-details") {
    detailsDelay = Number(url.searchParams.get("ms") ?? 0);
    return json({ detailsDelay });
  }
  if (url.pathname === "/titles") {
    const recent = requests.filter(
      (each) => each.kind === "title" && each.at >= Date.now() - PLAYING_MS,
    );
    return json([...new Set(recent.map((each) => each.channel))]);
  }
  if (url.pathname === "/live" || url.pathname === "/past") {
    const kinds = url.pathname === "/live" ? ["playlist", "segment"] : ["archive"];
    const recent = requests.filter(
      (each) => kinds.includes(each.kind) && each.at >= Date.now() - PLAYING_MS,
    );
    return json([...new Set(recent.map((each) => each.channel))]);
  }
  answer(response, 404, "text/plain", "");
}).listen(controlPort, "127.0.0.1");

writeFileSync(
  join(out, second ? `server-${port}.json` : "server.json"),
  JSON.stringify({ port, controlPort, started, ...(profile ? { profile } : {}) }),
);
console.log(`fake TMDB at http://127.0.0.1:${port}/tmdb/3`);
if (profile) console.log(`${profile.name} profile ${JSON.stringify(profile)}`);
console.log(
  `fixture panel http://127.0.0.1:${port} as ${USERNAME}, ${provider.catalogue.channels.length} channels; control http://127.0.0.1:${controlPort}`,
);
