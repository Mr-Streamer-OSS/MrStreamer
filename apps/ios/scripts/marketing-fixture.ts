// The made-up marketing subscription for the iOS app on the simulator, for the iPhone captures the
// website shows (docs/contributing/marketing-artwork.md). It starts the desktop captures' demo
// (apps/desktop/scripts/marketing-demo.ts), unchanged, and puts in front of it what the iOS app
// needs and the desktop capture gets elsewhere:
//
// - Every channel as live HLS (`/live/<user>/<pass>/<id>.m3u8`), segments cut without re-encoding
//   from the same Earth loop, since AVPlayer can't play the panel's MPEG-TS.
// - A login of the app's own, translated to the demo's "demo" / "demo" on the way in. The iOS guide
//   reader refuses a guide that holds the login, a guard against panels echoing it, and the demo's
//   guide ids all end in ".demo".
// - The demo's own invented pictures at this server's address. The desktop capture answers
//   `image.example` from its DevTools session; the simulator has none, so the lists name `/art/`
//   here instead. React Native's Image draws no SVG, so the drawn logos come as PNG, rendered from
//   the demo's SVG with rsvg-convert.
// - The demo's TMDB stand-in under `/tmdb/3`, without picture paths (see `tmdb`).
//
// Everything else, the API, the guide and the episode file, is the demo's adapter's answer.
//
//   node apps/ios/scripts/marketing-fixture.ts --cache-dir .local/marketing-media [--port 8795]
//   onmac tunnel 8795
//
// Build the app with EXPO_PUBLIC_TMDB_KEY=fixture EXPO_PUBLIC_TMDB_API=http://127.0.0.1:8795/tmdb/3
// for the series' story and cast.
//
// Log in at http://127.0.0.1:8795 as viewer7 / Lantern-Q4m-Harbour. Needs ffmpeg and rsvg-convert
// on PATH.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  cacheDirectory,
  prepareMedia,
  startMarketingDemo,
} from "../../desktop/scripts/marketing-demo.ts";
import { livePlaylist, type Media } from "./native-fixtures/media.ts";

/** The login the app signs in with, and the fake provider's default, which the demo keeps. */
const LOGIN = { user: "viewer7", pass: "Lantern-Q4m-Harbour" };
const DEMO = { user: "demo", pass: "demo" };

const { values } = parseArgs({
  options: { "cache-dir": { type: "string" }, port: { type: "string", default: "8795" } },
});
const port = Number(values.port);
const cache = cacheDirectory(values["cache-dir"]);
const media = await prepareMedia(cache);
const earth = earthSegments(media.earth, join(cache, "earth-hls"));
const demo = await startMarketingDemo(media);
const adapter = new URL(demo.provider.url);
const started = Date.now();
const here = `http://127.0.0.1:${port}`;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", here);
  response.on("finish", () =>
    console.log(
      `${request.method} ${url.pathname} ${url.searchParams.get("action") ?? ""} ${response.statusCode}`,
    ),
  );
  const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.m3u8$/.exec(url.pathname);
  if (live) {
    const [, user = "", pass = "", id] = live;
    if (decodeURIComponent(user) !== LOGIN.user || decodeURIComponent(pass) !== LOGIN.pass) {
      return void response.writeHead(401).end();
    }
    const playlist = livePlaylist(earth, started, (n) => `/hls/${id}/${n}.ts`);
    return void response
      .writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" })
      .end(playlist);
  }
  const segment = /^\/hls\/\d+\/(\d+)\.ts$/.exec(url.pathname);
  if (segment) {
    const file = earth.segments[Number(segment[1]) % earth.segments.length]?.file;
    if (!file) return void response.writeHead(404).end();
    return void response
      .writeHead(200, { "Content-Type": "video/mp2t" })
      .end(readFileSync(join(earth.dir, file)));
  }
  const art = /^\/art\/([\w.-]+)$/.exec(url.pathname);
  if (art) return artwork(art[1] ?? "", response);
  if (url.pathname.startsWith("/tmdb/3/")) return void tmdb(url, response);
  // The app's login, as the demo knows it.
  if (url.searchParams.get("username") === LOGIN.user) url.searchParams.set("username", DEMO.user);
  if (url.searchParams.get("password") === LOGIN.pass) url.searchParams.set("password", DEMO.pass);
  const login = `/${LOGIN.user}/${encodeURIComponent(LOGIN.pass)}/`;
  const path = url.pathname.replace(login, `/${DEMO.user}/${DEMO.pass}/`);
  // The adapter's answer, the lists' picture addresses pointed here.
  const upstream = httpRequest(
    {
      host: adapter.hostname,
      port: adapter.port,
      method: request.method,
      path: path + url.search,
      headers: { ...request.headers, host: adapter.host },
    },
    (answer) => {
      if (url.pathname !== "/player_api.php") {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        return void answer.pipe(response);
      }
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        const body = Buffer.concat(chunks)
          .toString("utf8")
          .replaceAll("https://image.example/", `${here}/art/`)
          .replace(/(\/art\/logo-\d+)\.svg/g, "$1.png")
          .replaceAll(`"username":"${DEMO.user}"`, `"username":"${LOGIN.user}"`);
        response
          .writeHead(answer.statusCode ?? 502, { "Content-Type": "application/json" })
          .end(body);
      });
    },
  );
  upstream.on("error", () => response.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}).listen(port, "127.0.0.1", () => {
  console.log(`Marketing demo for iOS at ${here}, login ${LOGIN.user} / ${LOGIN.pass}.`);
});

/**
 * The demo's TMDB stand-in, without its picture paths: the app builds those on image.tmdb.org, which
 * the simulator would ask the real TMDB for. Without them it shows the provider's pictures, which
 * are the demo's and come from here, and a person without a picture.
 */
async function tmdb(url: URL, response: ServerResponse): Promise<void> {
  const answer = await fetch(`${demo.tmdbApi}${url.pathname.slice("/tmdb/3".length)}${url.search}`);
  const body = JSON.stringify(await answer.json(), (key, value: unknown) =>
    key.endsWith("_path") ? null : value,
  );
  response.writeHead(answer.status, { "Content-Type": "application/json" }).end(body);
}

/** One of the demo's pictures by its name in the lists; a drawn SVG comes as PNG. */
function artwork(name: string, response: ServerResponse): void {
  const logo = /^(logo-\d+)\.png$/.exec(name);
  const found = demo.artwork(`https://image.example/${logo ? `${logo[1]}.svg` : name}`);
  if (!found) return void response.writeHead(404).end();
  if (found.contentType !== "image/svg+xml") {
    return void response.writeHead(200, { "Content-Type": found.contentType }).end(found.body);
  }
  const png = execFileSync("rsvg-convert", ["--zoom", "3", "--format", "png"], {
    input: found.body,
  });
  response.writeHead(200, { "Content-Type": "image/png" }).end(png);
}

/** The Earth loop cut into HLS segments, once, as `Media` for `livePlaylist`. */
function earthSegments(source: string, dir: string): Media {
  const index = join(dir, "index.m3u8");
  if (!existsSync(index)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-c", "copy"],
      ...["-f", "hls", "-hls_time", "4", "-hls_list_size", "0"],
      ...["-hls_segment_filename", join(dir, "%03d.ts"), index],
    ]);
  }
  const lines = readFileSync(index, "utf8").split("\n");
  const segments = lines.flatMap((line, at) => {
    const seconds = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    const file = lines[at + 1];
    return seconds && file ? [{ file, seconds: Number(seconds) }] : [];
  });
  if (segments.length !== readdirSync(dir).filter((file) => file.endsWith(".ts")).length) {
    throw new Error(`${index} doesn't list every segment in ${dir}.`);
  }
  return { dir, segments };
}
