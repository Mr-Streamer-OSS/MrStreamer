// recordings.json in the app's recordings folder: every recording's record, which only
// services/recordings.ts reads and writes. Each recording's file sits beside it, in a folder named
// by its id:
//
//   { "version": 1, "recordings": [ { "id": …, "file": "….ts", "status": { "kind": … }, … } ] }
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
  RecordingPlanSchema,
  type Recording,
  type RecordingPlan,
} from "@mrstreamer/contracts/recordings";
import { writeJsonFile } from "../platform/json-file.ts";

/** The version this build writes, and the newest it reads. */
const VERSION = 1;

/** A recording as kept: what the window sees, but `missing`, and its file's name in its folder. */
export interface StoredRecording extends Omit<Recording, "status"> {
  readonly file: string;
  readonly status: Exclude<Recording["status"], { readonly kind: "missing" }>;
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
      late: "'away' | 'busy' | 'stream' | 'disk' | 'held' | 'unread' | null",
    },
    ended: "number | null",
    bytes: "number >= 0",
    status: type({ kind: "'recording' | 'complete' | 'stopped'" })
      .or({ kind: "'partial'", cut: "'quit' | 'stream' | 'disk'" })
      .or({
        kind: "'missed'",
        why: "'away' | 'busy' | 'stream' | 'disk' | 'held' | 'unread'",
      }),
  }),
);

const File = lazy(() => type({ version: "number.integer", recordings: Entry().array() }));

/** A schedule as kept. */
export interface KeptSchedule {
  readonly id: string;
  readonly plan: RecordingPlan;
  /** Its channel's name when it was saved or last found. */
  readonly channelName: string;
  /** When it was saved: of two that start together, the one saved first records first. */
  readonly created: number;
  /**
   * Every occurrence that ends by this time is settled: recorded, missed or let go. One that ended
   * later and was never settled was missed while the app was away.
   */
  readonly through: number;
}

const Schedule = lazy(() =>
  type({
    id: "string > 0",
    plan: RecordingPlanSchema(),
    channelName: "string",
    created: "number",
    through: "number",
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
