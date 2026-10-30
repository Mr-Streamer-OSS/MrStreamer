// recordings.json in the app's recordings folder: every recording's record, which only
// services/recordings.ts reads and writes. Each recording's file sits beside it, in a folder named
// by its id:
//
//   { "version": 1, "recordings": [ { "id": …, "file": "….ts", "status": { "kind": … }, … } ] }
//
// A file this build can't make sense of, or one a later version wrote as newer, is never written
// over: nothing of it is used, and nothing records until it can be read.
import { readFile } from "node:fs/promises";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { writeJsonFile } from "../platform/json-file.ts";

/** The version this build writes, and the newest it reads. */
const VERSION = 1;

/** A recording as kept: what the window sees, but `missing`, and its file's name in its folder. */
export interface StoredRecording extends Omit<Recording, "status"> {
  readonly file: string;
  readonly status: Exclude<Recording["status"], { readonly kind: "missing" }>;
}

const Entry = lazy(() =>
  type({
    id: "string > 0",
    file: "string > 0",
    channel: { subscriptionId: "string > 0", id: "string" },
    channelName: "string",
    title: "string",
    start: "number",
    stop: "number",
    ended: "number | null",
    bytes: "number >= 0",
    status: type({ kind: "'recording' | 'complete' | 'stopped'" }).or({
      kind: "'partial'",
      cut: "'quit' | 'stream' | 'disk'",
    }),
  }),
);

const File = lazy(() => type({ version: "number.integer", recordings: Entry().array() }));

/** recordings.json as read: its records, or that none of it can be used. */
export type ReadRecordings =
  | { readonly kind: "read"; readonly recordings: readonly StoredRecording[] }
  | { readonly kind: "refused" };

/** Reads recordings.json at `path`. A file that isn't there holds no recordings. */
export async function readRecordings(path: string): Promise<ReadRecordings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { kind: "read", recordings: [] };
    return { kind: "refused" };
  }
  try {
    const parsed = File()(JSON.parse(text));
    if (parsed instanceof type.errors || parsed.version !== VERSION) return { kind: "refused" };
    return { kind: "read", recordings: parsed.recordings };
  } catch {
    return { kind: "refused" };
  }
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
  return `${`${words.slice(0, 100).trim()} - ${when}`.replace(/^[. -]+/, "")}.ts`;
}
