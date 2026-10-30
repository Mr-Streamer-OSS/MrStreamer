// The media scripts/fixture-server.ts serves, and where each piece came from. Everything is made
// here with ffmpeg from its own test sources (lavfi), or cut from the synthetic clips in
// apps/desktop/test/fixtures, which apps/desktop/scripts writes; no provider or broadcast media.
// Each piece is made once into `<out>/media/<name>-<hash of its command>`, so a changed command
// makes it again instead of serving what an older one made.
//
// The provenance the server declares (its control port's /provenance and provenance.json) names
// the commit and whether the fixture sources differ from it, the ffmpeg that made the media, and
// per piece its command, its inputs (a lavfi graph, or a repository file and its SHA-256) and the
// SHA-256 of every file served from it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** A looped recording, cut into segments of the durations its playlist gives. */
export interface Media {
  readonly dir: string;
  readonly segments: readonly { readonly file: string; readonly seconds: number }[];
}

/** Segments a live playlist lists, the newest last. */
const WINDOW = 5;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

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
export function mediaMaker(root: string, out: string) {
  const artifacts: Artifact[] = [];
  /** Adds `artifact` to what provenance.json in `out` declares. */
  const add = (artifact: Artifact) => {
    artifacts.push(artifact);
    writeFileSync(
      join(out, "provenance.json"),
      JSON.stringify({ source, ffmpeg, artifacts }, null, 2),
    );
  };
  const hashes = new Map<string, string>();
  const hashOf = (file: string) => {
    let found = hashes.get(file);
    if (!found) {
      found = sha256(readFileSync(file));
      hashes.set(file, found);
    }
    return found;
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
    const options = ["-v", "error", "-y", ...args];
    const dir = join(out, "media", `${name}-${sha256(options.join("\0")).slice(0, 12)}`);
    const path = join(dir, output);
    const command = [...options, ...local(dir), path];
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      execFileSync("ffmpeg", command);
    }
    const inputs = args.flatMap((arg, index): Artifact["inputs"] =>
      args[index - 1] !== "-i"
        ? []
        : args[index - 2] === "lavfi"
          ? [{ lavfi: arg }]
          : [{ file: relative(root, arg), sha256: hashOf(arg) }],
    );
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
    /** Records the files in `dir`, written by `writer` rather than ffmpeg. */
    record(name: string, dir: string, writer: string) {
      add({ name, command: writer, inputs: [], files: filesOf(dir) });
    },
    /** What the server declares about its media. */
    provenance: () => ({ source, ffmpeg, artifacts }),
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

const loopSeconds = ({ segments }: Media) => segments.reduce((sum, each) => sum + each.seconds, 0);

/**
 * The newest segment of `media`'s loop at `now`, the loop having started at `started`: segment n
 * is the loop's n % length.
 */
function newestSegment({ segments }: Media, started: number, now: number) {
  const loop = loopSeconds({ dir: "", segments });
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
 * A recording of `media`'s loop from `start`, epoch ms, for `seconds`: every segment, when it
 * `ended` before now, or, while it is still going, those it has had time for, as an event playlist
 * that grows until it ends. Its segments are on the clock from `start` (#EXT-X-PROGRAM-DATE-TIME).
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
    `#EXT-X-PLAYLIST-TYPE:${ended ? "VOD" : "EVENT"}`,
    ...(last >= 0
      ? loopSegments(media, 0, last, uri, start)
      : ["#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"]),
    ...(ended ? ["#EXT-X-ENDLIST"] : []),
    "",
  ].join("\n");
}
