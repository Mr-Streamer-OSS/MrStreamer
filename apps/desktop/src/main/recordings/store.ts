// recordings.json in the app's recordings folder: every recording's record, which only
// services/recordings.ts reads and writes. Each recording's file sits in a folder named by its id,
// beside it or in the folder the viewer chose when it started (`folder`):
//
//   { "version": 1, "recordings": [ { "id": …, "file": "….ts", "status": { "kind": … }, … } ] }
//
// A recording whose time goes on stays `recording` while capture waits to go on, its open gap
// saying since when and why. A build from before gaps reads it as one the app didn't see end. A
// build from before storage.json knows only the folder beside recordings.json: it lists one made
// in a chosen folder as missing, and its Delete takes the record and leaves the file.
//
// storage.json beside them keeps where new recordings go and the room they may take:
//
//   { "version": 1, "folder": "/…", "keepFree": …, "space": … | null }
//
// schedules.json beside it keeps the schedules, in a file of their own, which a build from before
// them leaves alone. Such a build can't read a recordings.json that holds a missed result, and
// so records nothing, as with any file it can't make sense of:
//
//   { "version": 1, "schedules": [ { "id": …, "plan": { "kind": "slot", … }, "through": …, … } ] }
//
// A file this build can't make sense of, or one a later version wrote as newer, is never written
// over: nothing of it is used, and nothing records until it can be read.
import { readFile } from "node:fs/promises";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import {
  DEFAULT_KEEP_FREE,
  RecordingPlanSchema,
  type Recording,
  type RecordingLimits,
  type RecordingPlan,
} from "@mrstreamer/contracts/recordings";
import { writeJsonFile } from "../platform/json-file.ts";

/** The version this build writes, and the newest it reads. */
const VERSION = 1;

/**
 * A recording as kept: what the window sees, but `missing`, `paused` and `unsaved`, with its
 * file's name, the folder its own folder is in when not beside recordings.json, the streams it
 * asked for, to go on with them, and how far it played.
 */
export interface StoredRecording extends Omit<Recording, "status" | "unsaved"> {
  readonly file: string;
  readonly folder?: string;
  readonly variants?: readonly string[];
  readonly progress?: { readonly position: number; readonly duration: number };
  readonly status: Exclude<Recording["status"], { readonly kind: "missing" | "paused" }>;
}

const Channel = lazy(() => type({ subscriptionId: "string > 0", id: "string" }));

const Entry = lazy(() =>
  type({
    id: "string > 0",
    file: "string > 0",
    channel: Channel(),
    channelName: "string",
    title: "string",
    start: "number",
    stop: "number",
    "scheduled?": {
      schedule: "string > 0",
      from: "number",
      "owed?": "number",
      late: "'away' | 'busy' | 'stream' | 'disk' | 'held' | 'unread' | null",
    },
    ended: "number | null",
    bytes: "number >= 0",
    "gaps?": type({
      from: "number",
      to: "number | null",
      why: "'away' | 'busy' | 'stream' | 'disk' | 'space'",
    }).array(),
    "folder?": "string > 0",
    "variants?": "string[]",
    "progress?": { position: "number >= 0", duration: "number > 0" },
    status: type({ kind: "'recording' | 'complete' | 'stopped'" })
      .or({ kind: "'partial'", cut: "'quit' | 'stream' | 'disk'" })
      .or({
        kind: "'missed'",
        why: "'away' | 'busy' | 'stream' | 'disk' | 'held' | 'unread'",
      }),
  }),
);

const File = lazy(() => type({ version: "number.integer", recordings: Entry().array() }));

/** Where new recordings go, and the room they may take, as storage.json keeps it. */
export interface KeptStorage extends RecordingLimits {
  /** Absent for the folder beside recordings.json. */
  readonly folder?: string;
}

const Storage = lazy(() =>
  type({
    version: "number.integer",
    "folder?": "string > 0",
    keepFree: "number.integer >= 0",
    space: "number.integer > 0 | null",
  }),
);

/**
 * storage.json at `path`, or the defaults while it isn't there; null when it is there but can't be
 * read, as one a newer version wrote.
 */
export async function readStorage(path: string): Promise<KeptStorage | null> {
  const read = await readOurs(path, (data) => {
    const parsed = Storage()(data);
    if (parsed instanceof type.errors) return null;
    const { version, ...kept } = parsed;
    return { version, items: [kept] };
  });
  if (read.kind === "refused") return null;
  return read.items[0] ?? { keepFree: DEFAULT_KEEP_FREE, space: null };
}

export function writeStorage(path: string, storage: KeptStorage): Promise<void> {
  return writeJsonFile(path, { version: VERSION, ...storage });
}

/** A schedule as kept. */
export interface KeptSchedule {
  readonly id: string;
  readonly plan: RecordingPlan;
  /** Its channel's name when it was saved: listed under another, it is held as gone. */
  readonly channelName: string;
  /** When it was saved: of two that start together, the one saved first records first. */
  readonly created: number;
  /**
   * Every occurrence that ends by this time is settled: recorded, missed or let go. One that ended
   * later and was never settled was missed while the app was away.
   */
  readonly through: number;
  /**
   * A change that moved it onto a time already under way: that occurrence, by its padded start,
   * is owed from when the change was saved, `at`, not from its start.
   */
  readonly owed?: { readonly from: number; readonly at: number };
}

const Schedule = lazy(() =>
  type({
    id: "string > 0",
    plan: RecordingPlanSchema(),
    channelName: "string",
    created: "number",
    through: "number",
    "owed?": { from: "number", at: "number" },
  }),
);

const Schedules = lazy(() => type({ version: "number.integer", schedules: Schedule().array() }));

/** A file of ours as read: what it holds, or that none of it can be used. */
export type Read<A> =
  { readonly kind: "read"; readonly items: readonly A[] } | { readonly kind: "refused" };

/** Reads one of our files at `path` through `parse`. A file that isn't there holds nothing. */
async function readOurs<A>(
  path: string,
  parse: (data: unknown) => { readonly version: number; readonly items: readonly A[] } | null,
): Promise<Read<A>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { kind: "read", items: [] };
    return { kind: "refused" };
  }
  try {
    const parsed = parse(JSON.parse(text));
    if (!parsed || parsed.version !== VERSION) return { kind: "refused" };
    return { kind: "read", items: parsed.items };
  } catch {
    return { kind: "refused" };
  }
}

/** Reads recordings.json at `path`. */
export function readRecordings(path: string): Promise<Read<StoredRecording>> {
  return readOurs(path, (data) => {
    const parsed = File()(data);
    return parsed instanceof type.errors
      ? null
      : { version: parsed.version, items: parsed.recordings };
  });
}

/** Reads schedules.json at `path`. */
export function readSchedules(path: string): Promise<Read<KeptSchedule>> {
  return readOurs(path, (data) => {
    const parsed = Schedules()(data);
    return parsed instanceof type.errors
      ? null
      : { version: parsed.version, items: parsed.schedules };
  });
}

export function writeSchedules(path: string, schedules: readonly KeptSchedule[]): Promise<void> {
  return writeJsonFile(path, { version: VERSION, schedules });
}

export function writeRecordings(
  path: string,
  recordings: readonly StoredRecording[],
): Promise<void> {
  return writeJsonFile(path, { version: VERSION, recordings });
}

/**
 * A recording's file name, as a viewer finds it in a folder: "Programme - Channel - 2026-10-30
 * 21.52.ts", in local time. Holds nothing a file system on macOS, Windows or Linux refuses: no
 * path separators, control or reserved characters, and, ending in its time, no device name.
 */
export function recordingFileName(title: string, channelName: string, start: number): string {
  const at = new Date(start);
  const two = (value: number) => String(value).padStart(2, "0");
  const when = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}`;
  const clean = (text: string) =>
    text
      // oxlint-disable-next-line no-control-regex -- control characters are what this removes
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const words = [...new Set([clean(title), clean(channelName)].filter(Boolean))].join(" - ");
  // File systems count a name's bytes, at most 255: the words keep 150 of them, in whole characters.
  let kept = "";
  for (const character of words) {
    if (Buffer.byteLength(kept + character) > 150) break;
    kept += character;
  }
  return `${`${kept.trim()} - ${when}`.replace(/^[. -]+/, "")}.ts`;
}
