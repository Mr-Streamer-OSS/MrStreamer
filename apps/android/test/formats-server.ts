// Qualification fixture, never imported by the application. Normal Connect/Movies/Watch uses
// the production admission and player owner; this server replaces only the provider boundary.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, extname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeProvider } from "../../desktop/test/fake-provider.ts";
import { dispositions, mediaMaker, silencing } from "../../ios/scripts/native-fixtures/media.ts";

const root = resolve(import.meta.dirname, "../../..");
const desktop = join(root, "apps/desktop/test/fixtures");
const native = join(root, "apps/android/modules/player/android/src/test/resources/media");

const nativeHls = readdirSync(native, { recursive: true, encoding: "utf8" }).filter(
  (name) => typeof name === "string" && /^(hls|hls-ladder)\/.*\.(m3u8|m2ts)$/.test(name),
);

/** Exhaustive named file inventory. HLS/catch-up journeys are listed separately in formats.md. */
export function formatFiles() {
  return [
    ...[desktop, join(desktop, "codecs"), native].flatMap((directory) =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isFile() && /\.(mpegts|mp4|mkv|mov|avi|webm|m2ts|bin)$/.test(entry.name)
          ? [
              {
                name: `${directory === native ? "native" : directory.endsWith("codecs") ? "codecs" : "parity"}/${entry.name}`,
                path: join(directory, entry.name),
              },
            ]
          : [],
      ),
    ),
    ...nativeHls
      .filter((name) => name.endsWith(".m3u8"))
      .map((name) => ({ name: `native/${name}`, path: join(native, name) })),
  ];
}

export interface LinkConditions {
  readonly startupMs: number;
  /** Per response, not an aggregate radio/link simulation. Zero sends without pacing. */
  readonly kbps: number;
  /** Stops current and future media response bodies until cleared. */
  readonly stalled: boolean;
}

export async function startFormats(options: {
  readonly out: string;
  readonly port?: number;
  readonly controlPort?: number;
  readonly noRanges?: boolean;
}) {
  mkdirSync(options.out, { recursive: true });
  const maker = mediaMaker(root, options.out, "provenance.json");
  const files = formatFiles();
  const silent = new Map<string, Buffer>();

  function bytes(path: string) {
    const cached = silent.get(path);

    if (cached) return cached;

    if (path.endsWith(".m3u8")) {
      const relative = path.slice(native.length + 1);

      const text = readFileSync(path, "utf8")
        .split("\n")
        .map((line) =>
          line && !line.startsWith("#")
            ? `/native/${posix.join(posix.dirname(relative), line)}`
            : line,
        )
        .join("\n");

      const output = join(options.out, relative);
      mkdirSync(resolve(output, ".."), { recursive: true });
      writeFileSync(output, text);
      maker.served(`playlist-${silent.size}`, output);
      const body = Buffer.from(text);
      silent.set(path, body);

      return body;
    }

    const args = path.endsWith(".bin") ? [] : silencing(path);

    const output = args.length
      ? maker.file(
          `silent-${silent.size}`,
          [
            "-i",
            path,
            "-map",
            "0",
            "-c",
            "copy",
            ...args,
            ...dispositions(path),
            ...(path.endsWith(".mpegts") ? ["-f", "mpegts"] : []),
          ],
          `clip${extname(path)}`,
        )
      : path;

    if (!args.length) maker.served(`original-${silent.size}`, path);
    const body = readFileSync(output);
    silent.set(path, body);

    return body;
  }

  // Prepare before listening: missing encoders or unsupported remuxes fail explicitly.
  files.forEach((file) => bytes(file.path));

  const panel = await startFakeProvider({
    channels: 1,
    slotReleaseMs: 0,
    username: "fixture",
    password: "fixture-pass",
    titles: 0,
    wholeFiles: !!options.noRanges,
    titlesOf(all) {
      const template = all.movies[0]!;

      return {
        ...all,
        movies: files.map((file, index) => ({
          ...template,
          id: 9000 + index,
          name: file.name,
          container: extname(file.path).slice(1).replace("mpegts", "ts").replace("m2ts", "ts"),
          fixture: "title-h264-aac.mp4",
        })),
      };
    },
    streams(channel, output, signal) {
      if (!channel.fixture) return void output.end();
      const body = bytes(join(desktop, channel.fixture));
      // Paces the short TS recording, then holds it open like the existing live fixture.
      let sent = 0;

      const timer = setInterval(() => {
        if (sent >= body.length) return void clearInterval(timer);
        const end = sent + Math.ceil(body.length / 30);
        output.write(body.subarray(sent, end));
        sent = end;
      }, 100);

      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    },
  });

  files.forEach((file, index) => panel.replaceMovieFile(9000 + index, bytes(file.path)));
  let link: LinkConditions = { startupMs: 0, kbps: 0, stalled: false };
  let active = 0;
  let held = 0;
  const events: { event: string; at: number; link: LinkConditions }[] = [];

  const record = (event: string) =>
    events.push({ event, at: performance.now(), link: { ...link } });

  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const media = /^\/(files|live|timeshift|native)\//.test(req.url ?? "");

    if (media) {
      active++;
      record("request");
    }

    try {
      if (media && link.startupMs) await delay(link.startupMs, undefined, { signal: abort.signal });

      const staticName = (req.url ?? "").replace(/^\/native\//, "");

      let upstream = nativeHls.includes(staticName)
        ? new Response(bytes(join(native, staticName)), {
            headers: {
              "Content-Type": staticName.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : "video/mp2t",
            },
          })
        : await fetch(new URL(req.url ?? "/", panel.url), {
            redirect: "manual",
            signal: abort.signal,
            headers: req.headers.range ? { Range: req.headers.range } : {},
          });

      // The panel's archive handler reads original desktop clips directly. Keep its auth/status,
      // but replace a successful archive body with the same silent copy used by live playback.
      const archive = /^\/timeshift\/.*\/(\d+)\.ts$/.exec(req.url ?? "");

      if (archive && upstream.ok) {
        const channel = panel.catalogue.channels.find((row) => row.streamId === Number(archive[1]));
        await upstream.body?.cancel();
        upstream = channel?.fixture
          ? new Response(bytes(join(desktop, channel.fixture)), {
              headers: { "Content-Type": "video/mp2t" },
            })
          : new Response(null, { status: 404 });
      }

      upstream.headers.forEach((value, key) => {
        if (!["connection", "transfer-encoding", "content-encoding"].includes(key))
          res.setHeader(key, key === "location" ? value.replace(panel.url, "") : value);
      });
      res.writeHead(upstream.status);

      if (!upstream.body) return void res.end();

      for await (const chunk of upstream.body) {
        for (let offset = 0; offset < chunk.length;) {
          if (media && link.stalled) {
            held++;

            try {
              while (link.stalled) await delay(50, undefined, { signal: abort.signal });
            } finally {
              held--;
            }
          }

          const size =
            media && link.kbps
              ? Math.max(1, Math.floor((link.kbps * 1000) / 8 / 10))
              : chunk.length;

          const part = chunk.subarray(offset, offset + size);

          if (media && link.kbps) await delay(100, undefined, { signal: abort.signal });

          if (!res.write(part)) await once(res, "drain", { signal: abort.signal });
          offset += part.length;
        }
      }

      res.end();
    } catch {
      res.destroy();
    } finally {
      if (media) {
        active--;
        record("closed");
      }
    }
  });

  const control = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/link") {
      const startupMs = Number(url.searchParams.get("startupMs"));
      const kbps = Number(url.searchParams.get("kbps"));
      const stalled = url.searchParams.get("stalled");

      if (
        ![startupMs, kbps].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 60000) ||
        !["true", "false"].includes(stalled ?? "")
      )
        return void res.writeHead(400).end();
      link = { startupMs, kbps, stalled: stalled === "true" };
      record("conditions");
    } else if (req.method !== "GET" || url.pathname !== "/state")
      return void res.writeHead(404).end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ link, active, held, events }));
  });

  server.listen(options.port ?? 0, "127.0.0.1");
  control.listen(options.controlPort ?? 0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(control, "listening")]);

  function address(serving: typeof server) {
    const value = serving.address();

    if (!value || typeof value === "string") throw new Error("Fixture has no TCP address");

    return `http://127.0.0.1:${value.port}`;
  }

  const identity = {
    url: address(server),
    control: address(control),
    noRanges: !!options.noRanges,
    sound: process.env.FIXTURE_SOUND === "1",
    files: files.map(({ name }, index) => ({
      name,
      id: 9000 + index,
      qualification: "unqualified",
    })),
  };

  writeFileSync(join(options.out, "session.json"), JSON.stringify(identity, null, 2));

  return {
    ...identity,
    async close() {
      server.closeAllConnections();
      control.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => server.close(() => done())),
        new Promise<void>((done) => control.close(() => done())),
        panel.close(),
      ]);
      writeFileSync(join(options.out, "network.json"), JSON.stringify({ active, events }, null, 2));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startFormats({
    out: resolve(process.env.FIXTURE_OUT ?? ".local/699/formats"),
    port: Number(process.argv[2] ?? 8891),
    controlPort: Number(process.argv[3] ?? 8892),
    noRanges: process.argv.includes("--no-ranges"),
  });

  console.log(`Formats ${fixture.url}; control ${fixture.control}; fixture / fixture-pass`);

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void fixture.close();
    });
}
