// The media scripts/fixture-server.ts serves, and where each piece came from. Everything is made
// here with ffmpeg from its own test sources (lavfi), or cut from the synthetic clips in
// apps/desktop/test/fixtures, which apps/desktop/scripts writes; no provider or broadcast media.
// Each piece is made once into `<out>/media/<name>-<hash>`, a hash of its command, its input files
// and the ffmpeg making it, so a change to any of them makes it again instead of serving what was
// made before. It is made in a directory of its own and moved there only once complete.
//
// The provenance the server declares (its control port's /provenance and provenance.json) names
// the commit and whether the fixture sources differ from it, the ffmpeg that made the media, and
// per piece its command, its inputs (a lavfi graph, or a repository file and its SHA-256) and the
// SHA-256 of every file served from it. Repository clips the server sends as they are, the TEST
// titles' files, are declared too. A made piece's files are named from `out`, a served clip's from
// the repository's root, as its input is.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";

/** A looped recording, cut into segments of the durations its playlist gives. */
export interface Media {
  readonly dir: string;
  readonly segments: readonly { readonly file: string; readonly seconds: number }[];
}

/** Segments a live playlist lists, the newest last. */
const WINDOW = 5;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Whether process `pid` is running. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process that may not be signalled is running too.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** One piece of media and how it was made. */
interface Artifact {
  readonly name: string;
  readonly command: readonly string[] | string;
  readonly inputs: readonly (
    { readonly lavfi: string } | { readonly file: string; readonly sha256: string }
  )[];
  readonly files: readonly {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

/**
 * Makes and records media under `out`, for a server whose sources are in the checkout at `root`.
 * `make` cuts what ffmpeg `args` give into HLS segments; `record` adds files written otherwise.
 */
export function mediaMaker(root: string, out: string, declaration: string) {
  const artifacts: Artifact[] = [];
  const provenance = () => ({ source, ffmpeg, artifacts });
  /** Adds `artifact` to what `declaration` in `out` declares. */
  const add = (artifact: Artifact) => {
    artifacts.push(artifact);
    writeFileSync(join(out, declaration), JSON.stringify(provenance(), null, 2));
  };
  const filesOf = (dir: string) =>
    readdirSync(dir)
      .toSorted()
      .map((file) => {
        const bytes = readFileSync(join(dir, file));
        return { file: relative(out, join(dir, file)), bytes: bytes.length, sha256: sha256(bytes) };
      });
  const git = (args: readonly string[]) => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const sources = [
    "apps/ios/scripts",
    "apps/desktop/test/fake-provider.ts",
    "apps/desktop/test/fixtures",
  ];
  const source = {
    commit: git(["rev-parse", "HEAD"]),
    changed:
      git(["status", "--porcelain", "--", ...sources])
        ?.split("\n")
        .filter(Boolean) ?? null,
  };
  const ffmpeg = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "";
  /**
   * Runs ffmpeg with `args` into `output` in a directory of `name`'s and the command's own, unless
   * it already made it, and records it. `local` adds arguments naming paths in that directory.
   */
  function made(
    name: string,
    args: readonly string[],
    output: string,
    local: (dir: string) => readonly string[] = () => [],
  ) {
    const inputs = args.flatMap((arg, index): Artifact["inputs"] =>
      args[index - 1] !== "-i"
        ? []
        : args[index - 2] === "lavfi"
          ? [{ lavfi: arg }]
          : [{ file: relative(root, arg), sha256: sha256(readFileSync(arg)) }],
    );
    const options = ["-v", "error", "-y", ...args];
    const key = sha256(JSON.stringify([ffmpeg, options, local("."), output, inputs]));
    const dir = join(out, "media", `${name}-${key.slice(0, 12)}`);
    if (!existsSync(dir)) {
      // A directory of this server's own, so a second one starting beside it makes its own. What
      // a server stopped while making it left is removed.
      mkdirSync(join(out, "media"), { recursive: true });
      for (const left of readdirSync(join(out, "media"))) {
        const pid = Number(/\.making-(\d+)$/.exec(left)?.[1]);
        if (left.startsWith(`${basename(dir)}.making-`) && (pid === process.pid || !alive(pid))) {
          rmSync(join(out, "media", left), { recursive: true, force: true });
        }
      }
      const making = `${dir}.making-${process.pid}`;
      mkdirSync(making, { recursive: true });
      execFileSync("ffmpeg", [...options, ...local(making), join(making, output)]);
      try {
        renameSync(making, dir);
      } catch (error) {
        // The other one finished first: its media is the same.
        if (!existsSync(dir)) throw error;
        rmSync(making, { recursive: true, force: true });
      }
    }
    const path = join(dir, output);
    const command = [...options, ...local(dir), path];
    const named = command.map((arg) => (arg.startsWith(root) ? relative(root, arg) : arg));
    add({ name, command: ["ffmpeg", ...named], inputs, files: filesOf(dir) });
    return { dir, output: path };
  }

  return {
    /**
     * The HLS segments of what ffmpeg makes from `args`, made into a directory of `name`'s once,
     * each about `seconds` long.
     */
    make(name: string, args: readonly string[], seconds = 2): Media {
      const hls = ["-f", "hls", "-hls_time", String(seconds), "-hls_playlist_type", "vod"];
      const { dir, output } = made(name, [...args, ...hls], "index.m3u8", (dir) => [
        "-hls_segment_filename",
        join(dir, "%03d.ts"),
      ]);
      return { dir, segments: segmentsOf(output) };
    },
    /** The file ffmpeg makes from `args`, named `file` in a directory of `name`'s, made once. */
    file: (name: string, args: readonly string[], file: string) => made(name, args, file).output,
    /** Records `file`, a repository clip served as it is, as `name`. */
    served(name: string, file: string) {
      const bytes = readFileSync(file);
      const hash = sha256(bytes);
      add({
        name,
        command: "served as it is",
        inputs: [{ file: relative(root, file), sha256: hash }],
        files: [{ file: relative(root, file), bytes: bytes.length, sha256: hash }],
      });
    },
    /** Records the files in `dir`, written by `writer` rather than ffmpeg. */
    record(name: string, dir: string, writer: string) {
      add({ name, command: writer, inputs: [], files: filesOf(dir) });
    },
    /** What the server declares about its media. */
    provenance,
  };
}

/** The segments an HLS media playlist lists, with their durations. */
function segmentsOf(playlist: string): Media["segments"] {
  const lines = readFileSync(playlist, "utf8").split("\n");
  return lines.flatMap((line, index) => {
    const seconds = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    const file = lines[index + 1]?.trim();
    return seconds && file ? [{ file, seconds: Number(seconds) }] : [];
  });
}

/**
 * The newest segment of `media`'s loop at `now`, the loop having started at `started`: segment n
 * is the loop's n % length.
 */
function newestSegment({ segments }: Media, started: number, now: number) {
  const loop = segments.reduce((sum, each) => sum + each.seconds, 0);
  const elapsed = Math.max(0, now - started) / 1000;
  const passes = Math.floor(elapsed / loop);
  let within = elapsed - passes * loop;
  let index = 0;
  while (index < segments.length - 1 && within >= (segments[index]?.seconds ?? 0)) {
    within -= segments[index]?.seconds ?? 0;
    index++;
  }
  return passes * segments.length + index;
}

/**
 * The lines listing segments `first` to `last` of `media`'s loop, whose addresses `uri` gives. Each
 * pass of the loop after the first begins with a discontinuity, as its timestamps start again,
 * and with the moment it starts on `clock`, when given, which counts from `first`.
 */
function loopSegments(
  media: Media,
  first: number,
  last: number,
  uri: (n: number) => string,
  clock?: number,
) {
  const { segments } = media;
  const wraps = Math.floor(first / segments.length);
  const lines = [
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((each) => each.seconds)))}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${first % segments.length === 0 && first > 0 ? wraps - 1 : wraps}`,
  ];
  let at = clock;
  for (let n = first; n <= last; n++) {
    const segment = segments[n % segments.length];
    if (n % segments.length === 0 && n > 0) lines.push("#EXT-X-DISCONTINUITY");
    if (at !== undefined && (n === first || n % segments.length === 0)) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(at).toISOString()}`);
    }
    lines.push(`#EXTINF:${segment?.seconds.toFixed(3)},`, uri(n));
    if (at !== undefined) at += (segment?.seconds ?? 0) * 1000;
  }
  return lines;
}

/**
 * The live playlist of `media` at `now`: the newest `WINDOW` segments of its loop, which started at
 * `started`. `timing` sets which segments those are, for renditions that play in step with it.
 */
export function livePlaylist(
  media: Media,
  started: number,
  uri: (n: number) => string,
  { now = Date.now(), timing = media }: { now?: number; timing?: Media } = {},
): string {
  const newest = newestSegment(timing, started, now);
  const first = Math.max(0, newest - WINDOW + 1);
  return ["#EXTM3U", "#EXT-X-VERSION:3", ...loopSegments(media, first, newest, uri), ""].join("\n");
}

/**
 * A recording of `media`'s loop from `start`, epoch ms, for `seconds`, as an event playlist: every
 * segment, ending the playlist, when it `ended` before now, or, while it is still going, those it
 * has had time for, growing until it ends. A player that started it while it was going reads the
 * same playlist type throughout, as HLS requires. Its segments are on the clock from `start`
 * (#EXT-X-PROGRAM-DATE-TIME).
 */
export function recordingPlaylist(
  media: Media,
  start: number,
  seconds: number,
  uri: (n: number) => string,
  ended: boolean,
): string {
  let last = -1;
  for (let total = 0; ;) {
    const next = total + (media.segments[(last + 1) % media.segments.length]?.seconds ?? 0);
    if (ended ? total >= seconds : next > seconds) break;
    total = next;
    last++;
  }
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    ...(last >= 0
      ? loopSegments(media, 0, last, uri, start)
      : ["#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"]),
    ...(ended ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}
