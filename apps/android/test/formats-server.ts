import { type } from "arktype";
// Qualification fixture, never imported by the application. Normal Connect/Movies/Watch uses
// the production admission and player owner; this server replaces only the provider boundary.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { resolve, extname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeProvider } from "../../desktop/test/fake-provider.ts";
import { dispositions, mediaMaker, silencing } from "../../ios/scripts/native-fixtures/media.ts";

const root = resolve(import.meta.dirname, "../../..");
const desktop = join(root, "apps/desktop/test/fixtures");
const native = join(root, "apps/android/modules/player/android/src/test/resources/media");

const nativeHls = readdirSync(native, { recursive: true, encoding: "utf8" }).filter((name) =>
  /^(hls|hls-ladder)\/.*\.(m3u8|m2ts)$/.test(name),
);

/**
 * Exhaustive named file inventory, each with its panel movie id. HLS/catch-up journeys are listed
 * separately in formats.md.
 */
function formatFiles() {
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
  ].map((file, index) => ({ ...file, id: 9000 + index }));
}

/** `text` without provider addresses, logins or credentials, for diagnostics. */
function redacted(text: string) {
  return text
    .replace(/https?:\/\/[^/\s]+/g, "")
    .replace(/\/(movie|series|live|timeshift)\/[^/\s]+\/[^/\s]+\//g, "/$1/*/*/")
    .replace(/(username|password)=[^&\s]*/g, "$1=*");
}

/** An error and its causes as plain data, messages redacted. */
interface DescribedError {
  readonly name?: string | undefined;
  readonly message: string;
  readonly code?: string | undefined;
  readonly syscall?: string | undefined;
  readonly cause?: DescribedError | undefined;
}

function described(cause: unknown): DescribedError | undefined {
  if (cause === undefined) return undefined;

  if (!(cause instanceof Error)) return { message: redacted(String(cause)) };

  return {
    name: cause.name,
    message: redacted(cause.message),
    code: "code" in cause ? String(cause.code) : undefined,
    syscall: "syscall" in cause ? String(cause.syscall) : undefined,
    cause: described(cause.cause),
  };
}

/**
 * One transport observation on the formats provider port. `by` says who ended a response or
 * connection: it finished, the fixture's teardown, the proxy handler, a socket timeout, or
 * otherwise the peer (or something unknown).
 */
interface Diagnostic {
  readonly event:
    | "connection"
    | "socket timeout"
    | "socket error"
    | "socket closed"
    | "request"
    | "response closed"
    | "handler failed";
  readonly at: number;
  readonly epochMs: number;
  readonly connection?: number | undefined;
  readonly peerPort?: number | undefined;
  /** Time since the connection's previous response closed, or since it opened. */
  readonly idleMs?: number | undefined;
  readonly requestId?: number | undefined;
  readonly requestOnConnection?: number | undefined;
  /** Path only, logins replaced by `*`. */
  readonly route?: string | undefined;
  /** Awaiting the upstream answer, or relaying its body. */
  readonly phase?: "upstream" | "body" | undefined;
  readonly expected?: number | null | undefined;
  /** Body bytes accepted by res.write, including a write still waiting for drain. */
  readonly accepted?: number | undefined;
  /** Body bytes whose write callback succeeded; this does not prove peer receipt. */
  readonly flushed?: number | undefined;
  /** Node's writable buffer at observation time, which may be empty after destruction. */
  readonly unflushed?: number | undefined;
  readonly by?:
    "finished" | "teardown" | "handler" | "socket timeout" | "peer or unknown" | undefined;
  readonly hadError?: boolean | undefined;
  readonly requests?: number | undefined;
  readonly bytesRead?: number | undefined;
  /** Socket total accepted for writing, including HTTP framing, not peer receipt. */
  readonly bytesWritten?: number | undefined;
  readonly error?: DescribedError | undefined;
}

export interface LinkConditions {
  readonly startupMs: number;
  /** Per response, not an aggregate radio/link simulation. Zero removes link pacing; the measurement title retains its 1500 kbps ceiling. */
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

  // One continuous encoder timeline, never a raw byte loop with reset PCR/PTS counters.
  const networkPath = maker.file(
    "network-continuing",
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "300",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      "-b:v",
      "1000k",
      "-minrate",
      "1000k",
      "-maxrate",
      "1000k",
      "-bufsize",
      "1000k",
      "-x264-params",
      "nal-hrd=cbr:force-cfr=1",
      "-g",
      "10",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-muxrate",
      "1200k",
      "-f",
      "mpegts",
    ],
    "continuing.ts",
  );

  const networkBody = readFileSync(networkPath);

  const facts = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration,bit_rate", "-of", "json", networkPath],
      { encoding: "utf8" },
    ),
  ) as { format: { duration: string; bit_rate: string } };

  const network = {
    file: networkPath,
    durationSeconds: Number(facts.format.duration),
    bitrateKbps: Number(facts.format.bit_rate) / 1000,
    bytes: networkBody.length,
  };

  const files = [
    ...formatFiles(),
    { name: "network/continuing.mpegts", path: networkPath, id: 9900 },
  ];

  const silent = new Map<string, Buffer>();

  function bytes(path: string) {
    if (path === networkPath) return networkBody;
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
  nativeHls.forEach((name) => bytes(join(native, name)));

  let networkChannelAssigned = false;

  const panel = await startFakeProvider({
    channels: 1,
    maxConnections: 64,
    channelOf: (channel) =>
      channel.streamId >= 2000 && !networkChannelAssigned
        ? ((networkChannelAssigned = true),
          {
            ...channel,
            streamId: 7998,
            name: "TEST | Network continuing silent TS",
            categoryId: "1",
            offline: false,
          })
        : channel,
    slotReleaseMs: 0,
    username: "fixture",
    password: "fixture-pass",
    titles: 0,
    wholeFiles: !!options.noRanges,
    titlesOf(all) {
      const template = all.movies[0]!;

      return {
        ...all,
        movies: files.map((file) => ({
          ...template,
          id: file.id,
          name: file.name,
          container: extname(file.path).slice(1).replace("mpegts", "ts").replace("m2ts", "ts"),
          fixture: "title-h264-aac.mp4",
        })),
      };
    },
    streams(channel, output, signal) {
      const body =
        channel.streamId === 7998
          ? networkBody
          : channel.fixture
            ? bytes(join(desktop, channel.fixture))
            : null;

      if (!body) return void output.end();
      const duration = channel.streamId === 7998 ? network.durationSeconds : 3;
      const size = Math.ceil(body.length / duration / 10 / 188) * 188;
      void (async () => {
        try {
          for (let sent = 0; sent < body.length; sent += size) {
            await delay(100, undefined, { signal });

            if (!output.write(body.subarray(sent, sent + size)))
              await once(output, "drain", { signal });
          }

          output.end();
        } catch {
          output.destroy();
        }
      })();
    },
  });

  files.forEach((file) => panel.replaceMovieFile(file.id, bytes(file.path)));

  for (const series of panel.titles.series)
    for (const episode of series.seasons.flat())
      if (episode.fixture)
        panel.replaceEpisodeFile(episode.id, bytes(join(desktop, episode.fixture)));
  let link: LinkConditions = { startupMs: 0, kbps: 0, stalled: false };
  let active = 0;
  let held = 0;

  const events: {
    event: string;
    at: number;
    epochMs: number;
    link: LinkConditions;
    requestId?: number;
    fixture?: string;
    range?: string | null;
    status?: number;
    bytes?: number;
    exhausted?: boolean;
    completed?: boolean;
  }[] = [];

  const record = (event: string, details: Partial<(typeof events)[number]> = {}) =>
    events.push({
      event,
      at: performance.now(),
      epochMs: Date.now(),
      link: { ...link },
      ...details,
    });

  /**
   * Transport diagnosis for every provider-port request, held in memory for the process that
   * started the fixture and never served by /state: connection reuse and idle time, the
   * proxy's phase, original errors and who closed what. Routes and messages are redacted.
   */
  const diagnostics: Diagnostic[] = [];

  const note = (
    event: Diagnostic["event"],
    details: Omit<Diagnostic, "event" | "at" | "epochMs">,
  ) => {
    diagnostics.push({ event, at: performance.now(), epochMs: Date.now(), ...details });

    if (diagnostics.length > 500) diagnostics.shift();
  };

  let closing = false;
  let connectionCount = 0;

  /** A provider-port connection: its requests, when it last went idle and who ended it. */
  interface Connection {
    readonly id: number;
    requests: number;
    idleSince: number;
    endedBy?: "handler" | "socket timeout";
  }

  const connections = new WeakMap<Socket, Connection>();

  const pending = new Set<Promise<void>>();
  let sequence = 0;

  const server = createServer((req, res) => {
    const task = handle(req, res);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });

  server.on("connection", (socket: Socket) => {
    const connection: Connection = {
      id: ++connectionCount,
      requests: 0,
      idleSince: performance.now(),
    };

    connections.set(socket, connection);
    note("connection", { connection: connection.id, peerPort: socket.remotePort });

    socket.on("timeout", () => {
      connection.endedBy ??= "socket timeout";
      note("socket timeout", {
        connection: connection.id,
        idleMs: Math.round(performance.now() - connection.idleSince),
      });
    });

    socket.on("error", (error) =>
      note("socket error", { connection: connection.id, error: described(error) }),
    );

    socket.on("close", (hadError) =>
      note("socket closed", {
        connection: connection.id,
        by: closing ? "teardown" : (connection.endedBy ?? "peer or unknown"),
        hadError,
        requests: connection.requests,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten,
      }),
    );
  });

  async function handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const media = /^\/(files|live|timeshift|native)\//.test(req.url ?? "");

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const fileMatch = /^\/files\/\d+\/(movie|series)\/(\d+)/.exec(path);
    const channelMatch = /^\/(live|timeshift)\/.*\/(\d+)\.ts$/.exec(path);

    const file =
      fileMatch?.[1] === "movie" ? files.find((row) => row.id === Number(fileMatch[2])) : undefined;

    const channel = panel.catalogue.channels.find(
      (row) => row.streamId === Number(channelMatch?.[2]),
    );

    const details = {
      requestId: ++sequence,
      fixture:
        file?.name ??
        (fileMatch?.[1] === "series"
          ? `episode/${fileMatch[2]}`
          : channelMatch
            ? `${channelMatch[1]}/${channel?.streamId === 7998 ? "network/continuing.ts" : (channel?.fixture ?? "unknown")}`
            : nativeHls.includes(path.slice(8))
              ? `native/${path.slice(8)}`
              : "unknown"),
      range: /^bytes=\d+-\d*$/.test(req.headers.range ?? "") ? req.headers.range! : null,
      status: 0,
      bytes: 0,
      exhausted: false,
      completed: false,
    };

    const connection = connections.get(req.socket);

    if (connection) connection.requests++;

    const trace = {
      requestId: details.requestId,
      connection: connection?.id,
      phase: "upstream" as "upstream" | "body",
      expected: null as number | null,
      accepted: 0,
      flushed: 0,
    };

    note("request", {
      ...trace,
      route: redacted(path),
      requestOnConnection: connection?.requests,
      idleMs: connection && Math.round(performance.now() - connection.idleSince),
    });

    res.on("close", () => {
      if (connection) connection.idleSince = performance.now();
      note("response closed", {
        ...trace,
        by: res.writableFinished
          ? "finished"
          : closing
            ? "teardown"
            : (connection?.endedBy ?? "peer or unknown"),
        unflushed: res.writableLength,
      });
    });

    if (media) {
      active++;
      record("request", details);
    }

    try {
      if (media && link.startupMs) await delay(link.startupMs, undefined, { signal: abort.signal });

      const staticName = (req.url ?? "").replace(/^\/native\//, "");

      let upstream = nativeHls.includes(staticName)
        ? new Response(new Uint8Array(bytes(join(native, staticName))), {
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
        const body = channel?.fixture ? bytes(join(desktop, channel.fixture)) : null;
        trace.expected = body?.length ?? null;
        upstream = body
          ? new Response(new Uint8Array(body), {
              headers: { "Content-Type": "video/mp2t" },
            })
          : new Response(null, { status: 404 });
      }

      upstream.headers.forEach((value, key) => {
        if (!["connection", "transfer-encoding", "content-encoding"].includes(key))
          res.setHeader(key, key === "location" ? value.replace(panel.url, "") : value);
      });
      details.status = upstream.status;

      if (media) record("response", details);
      res.writeHead(upstream.status);
      trace.phase = "body";
      const length = upstream.headers.get("content-length");

      if (length !== null) trace.expected = Number(length);

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
            media && (link.kbps || file?.id === 9900)
              ? Math.max(1, Math.floor(((link.kbps || 1500) * 1000) / 8 / 10))
              : chunk.length;

          const part = chunk.subarray(offset, offset + size);

          if (media && (link.kbps || file?.id === 9900))
            await delay((part.length * 8) / (link.kbps || 1500), undefined, {
              signal: abort.signal,
            });

          const flowing = res.write(part, (error) => {
            if (!error) trace.flushed += part.length;
          });

          // A false return still accepted this chunk, even if close arrives before drain.
          trace.accepted += part.length;

          if (!flowing) await once(res, "drain", { signal: abort.signal });
          offset += part.length;
          details.bytes += part.length;
        }
      }

      details.completed = true;
      const range = /^bytes \d+-(\d+)\/(\d+)$/.exec(upstream.headers.get("content-range") ?? "");
      details.exhausted = upstream.ok && (!range || Number(range[1]) + 1 === Number(range[2]));
      res.end();
    } catch (error) {
      note("handler failed", { ...trace, error: described(error) });

      if (connection) connection.endedBy = "handler";
      res.destroy();
    } finally {
      if (media) {
        active--;
        record("closed", details);
      }
    }
  }

  const control = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/link") {
      const startupMs = Number(url.searchParams.get("startupMs"));
      const kbps = Number(url.searchParams.get("kbps"));
      const stalled = url.searchParams.get("stalled");

      if (
        [...url.searchParams.keys()].some(
          (key) => !["startupMs", "kbps", "stalled"].includes(key),
        ) ||
        ["startupMs", "kbps", "stalled"].some(
          (key) => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim(),
        ) ||
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

    if (!value || type.keywords.string.root.allows(value))
      throw new Error("Fixture has no TCP address");

    return `http://127.0.0.1:${value.port}`;
  }

  const identity = {
    url: address(server),
    control: address(control),
    network,
    noRanges: !!options.noRanges,
    sound: process.env.FIXTURE_SOUND === "1",
    files: files.map(({ name, id }) => ({ name, id, qualification: "unqualified" })),
  };

  writeFileSync(join(options.out, "session.json"), JSON.stringify(identity, null, 2));

  return {
    ...identity,
    /** Recent transport diagnosis, oldest first; read in process, never over the network. */
    diagnostics: diagnostics as readonly Diagnostic[],
    async close() {
      closing = true;
      server.closeAllConnections();
      control.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => server.close(() => done())),
        new Promise<void>((done) => control.close(() => done())),
        panel.close(),
      ]);
      await Promise.all([...pending]);
      writeFileSync(
        join(options.out, "network.json"),
        JSON.stringify({ active, held, events }, null, 2),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);

  if (args.some((arg) => arg.startsWith("--") && arg !== "--no-ranges"))
    throw new Error("Unknown flag");
  const ports = args.filter((arg) => arg !== "--no-ranges");

  if (ports.length > 2 || ports.some((port) => !/^\d+$/.test(port) || Number(port) > 65535))
    throw new Error("Expected provider/control TCP ports");

  const fixture = await startFormats({
    out: resolve(process.env.FIXTURE_OUT ?? ".local/699/formats"),
    port: Number(ports[0] ?? 8891),
    controlPort: Number(ports[1] ?? 8892),
    noRanges: process.argv.includes("--no-ranges"),
  });

  console.log(`Formats ${fixture.url}; control ${fixture.control}; fixture / fixture-pass`);

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void fixture.close();
    });
}
