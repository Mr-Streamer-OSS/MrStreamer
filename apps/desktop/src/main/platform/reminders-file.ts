import type { Json } from "@mrstreamer/contracts/json";
// reminders.json in the data folder: the programme reminders, which only services/reminders.ts
// reads and writes. Version 1 keeps each saved subscription's reminders under its id:
//
//   { "version": 1, "subscriptions": { "<subscription id>": [ { "id": …, "start": …, … } ] } }
//
// Releases before 0.0.20 never look for it. A file this build can't make sense of is never
// written over: one that isn't JSON or names no version counts as unreadable, and one a later
// version wrote as newer, and nothing of either is used. Within version 1, keys this build
// doesn't know stay with their reminder through every write, and an entry it can't read stays as
// it is, under its subscription, until that subscription goes.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Decode, FileRead, FileWrite } from "@mrstreamer/contracts/persisted-file";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { KeptReminder } from "@mrstreamer/core/reminders/rules";
import { readJsonResult, writeJsonResult, writeJsonFile } from "./json-file.ts";

/** The version this build writes, and the newest it reads. */
const VERSION = 1;

/** What reminders.json holds, as this build reads it. */
export interface RemindersFile {
  readonly reminders: readonly KeptReminder[];
  /** Entries this build can't read, as the file holds them, by their subscription's id. */
  readonly unread: ReadonlyMap<string, readonly Json[]>;
}

/** reminders.json as read: what it holds, or why none of it can be used. */
export type ReadReminders =
  | { readonly kind: "read"; readonly file: RemindersFile }
  | { readonly kind: "refused"; readonly reason: "unreadable" | "newer" };

const Version = lazy(() => type({ version: "number.integer" }));

const Head = lazy(() =>
  type({ version: type.enumerated(VERSION), "subscriptions?": { "[string]": "unknown[]" } }),
);

type ReadError = Extract<AppError, { kind: "reminder" }> & {
  readonly reason: "unreadable" | "newer";
};

const UNREADABLE: ReadError = { kind: "reminder", reason: "unreadable" };

/** One reminder as stored, without the subscription it is kept under. */
const Entry = lazy(() =>
  type({
    id: "string > 0",
    channel: "string",
    streams: "string[] > 0",
    channelName: "string",
    adult: "boolean",
    start: "number",
    stop: "number",
    set: "string",
    title: "string",
    state: type({ kind: "'pending' | 'gone' | 'missed'" }).or({ kind: "'told'", at: "number" }),
  }),
);

/** Reads the file without interpreting absence as permission to initialize. */
export function loadReminders(path: string): Promise<FileRead<RemindersFile, ReadError>> {
  return readJsonResult(path, decodeReminders, () => UNREADABLE);
}

/** Legacy reader: a confirmed missing file holds no reminders. */
export async function readReminders(path: string): Promise<ReadReminders> {
  const read = await loadReminders(path);

  if (read.kind === "missing") return { kind: "read", file: { reminders: [], unread: new Map() } };

  if (read.kind === "read") return { kind: "read", file: read.value };

  return { kind: "refused", reason: read.error.reason };
}

const decodeReminders: Decode<RemindersFile, ReadError> = (data) => {
  // A later envelope need not retain version one's subscriptions shape.
  const version = Version()(data);

  if (!(version instanceof type.errors) && version.version > VERSION)
    return { kind: "newer", error: { kind: "reminder", reason: "newer" } };

  const head = Head()(data);

  if (head instanceof type.errors) return { kind: "unreadable", error: UNREADABLE };
  const reminders: KeptReminder[] = [];
  const unread = new Map<string, Json[]>();

  const subscriptions =
    data &&
    type.keywords.object.root.allows(data) &&
    !Array.isArray(data) &&
    "subscriptions" in data
      ? data.subscriptions
      : null;

  for (const [subscriptionId, entries] of Object.entries(
    subscriptions &&
      type.keywords.object.root.allows(subscriptions) &&
      !Array.isArray(subscriptions)
      ? subscriptions
      : {},
  )) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const parsed = Entry()(entry);

      if (parsed instanceof type.errors)
        unread.set(subscriptionId, [...(unread.get(subscriptionId) ?? []), entry]);
      else reminders.push({ ...parsed, subscriptionId });
    }
  }

  return { kind: "read", value: { reminders, unread } };
};

/** Writes `file` to `path` whole, or leaves the file before it as it was. */
export async function writeReminders(path: string, file: RemindersFile): Promise<void> {
  await writeJsonFile(path, remindersJson(file));
}

/** Refused writes retain the existing public save detail, without exposing filesystem causes. */
export function saveReminders(path: string, file: RemindersFile): Promise<FileWrite<AppError>> {
  return writeJsonResult(path, remindersJson(file), () => ({
    kind: "unexpected",
    detail: "Couldn't save the reminders.",
  }));
}

function remindersJson(file: RemindersFile): Json {
  const subscriptions = new Map<string, Json[]>();

  for (const { subscriptionId, ...entry } of file.reminders)
    subscriptions.set(subscriptionId, [...(subscriptions.get(subscriptionId) ?? []), entry]);

  for (const [subscriptionId, entries] of file.unread)
    subscriptions.set(subscriptionId, [...(subscriptions.get(subscriptionId) ?? []), ...entries]);

  return { version: VERSION, subscriptions: Object.fromEntries(subscriptions) };
}
