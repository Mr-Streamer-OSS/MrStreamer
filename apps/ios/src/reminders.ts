import { AppFailure } from "@mrstreamer/contracts/errors";
import type { Programme } from "@mrstreamer/contracts/guide";
import { lazy } from "@mrstreamer/contracts/lazy";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import {
  relisted,
  sameReminder,
  seen,
  type FoundChannel,
  type KeptReminder,
} from "@mrstreamer/core/reminders/rules";
import { type } from "arktype";
import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { currentCatalogue, currentRoster, onCatalogue, onRoster } from "./account.ts";
import { readJsonStrictly, writeJson } from "./files.ts";
import { guide } from "./guide.ts";
import type { Channel, Library } from "./library.ts";
import { store, useStore } from "./store.ts";

// Programme reminders on iPhone and iPad. The viewer sets one on a programme still to come, from
// its details, and iOS notifies at its start through a local notification the app schedules
// ahead (modules/programme-reminders): the app needn't run then, and nothing records or plays.
// Tapping the notification opens the programme's details; only Watch live there plays.
//
// A reminder is one channel's programme at one start, kept as the desktop keeps one
// (@mrstreamer/core/reminders/rules): the channel by every stream id it was seen with, the start
// in epoch milliseconds, so neither a time zone nor daylight saving moves it. Each check, as the
// app opens or comes back, a provider's channels or the guide change, brings every reminder in
// line: another programme at its start makes it changed, nothing there makes it gone, and either
// takes its notification down, so iOS never notifies for a programme other than the one set.
// Nothing runs in the background: a schedule that changes while the app is closed is seen at the
// next check, and until then the notification stands as last scheduled.
//
// One JSON file in Documents, written whole before any screen shows a change. A file there that
// doesn't read now, or that a later build wrote, shows no reminders and is never written over.
// A reminder goes once its programme ends, or once its subscription is no longer saved.

const FILE = "reminders.json";
/** iOS keeps at most 64 of an app's notifications scheduled: the soonest are, the rest later. */
const SCHEDULED = 64;

const Saved = lazy(() =>
  type({
    version: "1",
    reminders: type({
      id: "string",
      subscriptionId: "string",
      channel: "string",
      streams: "string[] > 0",
      channelName: "string",
      adult: "boolean",
      start: "number",
      stop: "number",
      set: "string",
      title: "string",
      state: type({ kind: "'pending' | 'gone'" }),
    }).array(),
  }),
);

/** Whether iOS lets the app notify: `undetermined` until the viewer is asked. */
export type Permission = "undetermined" | "denied" | "granted";

/** A notification as the app schedules it, and as iOS gives it back while it is still to come. */
export interface Notice {
  /** The reminder's id. */
  readonly id: string;
  /** When it notifies, epoch milliseconds: the programme's start. */
  readonly at: number;
  readonly title: string;
  readonly body: string;
  /** The channel's `Channel.key` when set, and the start, for the details it opens. */
  readonly channel: string;
}

/** The native module (modules/programme-reminders). */
export interface RemindersNative {
  permission(): Promise<Permission>;
  /** Asks the viewer with iOS's own prompt, once; later calls answer as `permission` does. */
  ask(): Promise<Permission>;
  /** The app's notifications still to come. */
  scheduled(): Promise<readonly Notice[]>;
  /** Schedules each, in place of one with its id. Answers the ids iOS refused. */
  schedule(notices: readonly Notice[]): Promise<readonly string[]>;
  /** Takes these down, scheduled or shown. */
  cancel(ids: readonly string[]): Promise<void>;
  /** The notification the viewer tapped last, once, or null. */
  takeOpened(): { readonly channel: string; readonly at: number } | null;
  /** Fires when the viewer taps one, whatever the app was doing: `takeOpened` holds it. */
  addListener(event: "opened", listener: () => void): { remove(): void };
}

/** Found where Expo installs every module; null in a build without it, and in Node. */
const native = (): RemindersNative | null => {
  const host: { expo?: { modules?: { ProgrammeReminders?: RemindersNative } } } = globalThis;
  return host.expo?.modules?.ProgrammeReminders ?? null;
};

/** What the file holds: `unreadable` doesn't read now, `foreign` a later build wrote. */
type Kept =
  | { readonly kind: "read"; readonly reminders: readonly KeptReminder[] }
  | { readonly kind: "unreadable" | "foreign" };

function readKept(): Kept {
  let read: unknown;
  try {
    read = readJsonStrictly(FILE);
  } catch {
    return { kind: "unreadable" };
  }
  if (read === null) return { kind: "read", reminders: [] };
  const parsed = Saved()(read);
  return parsed instanceof type.errors
    ? { kind: "foreign" }
    : { kind: "read", reminders: parsed.reminders };
}

const kept = store<Kept | null>(null);
const permission = store<Permission | null>(null);
/** The file, read at the first look, then as written; read again while it doesn't read. */
function keptNow(): Kept {
  const known = kept.get();
  if (known && known.kind !== "unreadable") return known;
  const read = readKept();
  kept.set(read.kind === known?.kind ? known : read);
  return kept.get()!;
}

/** Writes `reminders` whole; only once the file took them do the screens show them. */
function save(reminders: readonly KeptReminder[]) {
  writeJson(FILE, { version: 1, reminders });
  kept.set({ kind: "read", reminders });
}

/** The reminders, for a change. Throws, changing nothing, while the file can't be used. */
function stored(): readonly KeptReminder[] {
  const now = keptNow();
  if (now.kind === "read") return now.reminders;
  throw new AppFailure({
    kind: "reminder",
    reason: now.kind === "foreign" ? "newer" : "unreadable",
  });
}

/** A channel as a reminder knows it: every stream id, its own first. */
const foundAs = (channel: Channel): FoundChannel => ({
  id: channel.id,
  streams: [...new Set([channel.id, ...channel.variants.map((variant) => variant.id)])],
  name: channel.title,
  adult: channel.adult === true,
});

/**
 * `reminder`'s channel as Live lists it now, by the first of its streams listed: null where its
 * subscription's channels show without it, undefined while they don't show at all.
 */
function channelOf(reminder: KeptReminder, library: Library | null): Channel | null | undefined {
  if (!library) return undefined;
  const { subscriptionId } = reminder;
  for (const id of reminder.streams) {
    const channel = library.byKey.get(ownedKey({ subscriptionId, id }));
    if (channel?.subscriptionId === subscriptionId) return channel;
  }
  return library.labels.has(subscriptionId) ? null : undefined;
}

/** Where a reminder stands, as a screen shows it. */
export type ReminderStatus =
  | { readonly kind: "upcoming" }
  /** Another programme starts then now, `title`; it doesn't notify. `was` is the one set. */
  | { readonly kind: "changed"; readonly was: string }
  /** Nothing starts then on its channel now, or Live doesn't list the channel. */
  | { readonly kind: "gone" }
  /** Its programme is on. */
  | { readonly kind: "on" };

export interface Reminder {
  readonly id: string;
  /** Its channel's `Channel.key`, as Live lists it now, else as it was set. */
  readonly key: string;
  readonly channelName: string;
  readonly start: number;
  readonly stop: number;
  /** What the guide lists at `start`, as last read. */
  readonly title: string;
  readonly status: ReminderStatus;
}

const shownAs = (reminder: KeptReminder, library: Library | null, now: number): Reminder => ({
  id: reminder.id,
  key:
    channelOf(reminder, library)?.key ??
    ownedKey({ subscriptionId: reminder.subscriptionId, id: reminder.channel }),
  channelName: reminder.channelName,
  start: reminder.start,
  stop: reminder.stop,
  title: reminder.title,
  status:
    reminder.state.kind === "gone"
      ? { kind: "gone" }
      : reminder.title !== reminder.set
        ? { kind: "changed", was: reminder.set }
        : now >= reminder.start
          ? { kind: "on" }
          : { kind: "upcoming" },
});

/** Whether `reminder` notifies at its start: still to come, for the programme set, not adult. */
const notifies = (reminder: KeptReminder, now: number) =>
  reminder.state.kind === "pending" &&
  reminder.title === reminder.set &&
  !reminder.adult &&
  reminder.start > now;

const noticeOf = (reminder: KeptReminder): Notice => ({
  id: reminder.id,
  at: reminder.start,
  title: reminder.title,
  body: t("Starting now on {channel}", { channel: reminder.channelName }),
  channel: ownedKey({ subscriptionId: reminder.subscriptionId, id: reminder.channel }),
});

const sameNotice = (a: Notice, b: Notice) =>
  a.id === b.id &&
  a.at === b.at &&
  a.title === b.title &&
  a.body === b.body &&
  a.channel === b.channel;

/**
 * Makes iOS's scheduled notifications those of `reminders` that notify, the soonest 64: takes
 * down every other the app scheduled, and schedules what is missing. Nothing while iOS doesn't
 * let the app notify, which it then schedules none of either.
 */
async function sync(reminders: readonly KeptReminder[]) {
  const module = native();
  if (!module) return;
  const allowed = await module.permission();
  permission.set(allowed);
  if (allowed !== "granted") return;
  const now = Date.now();
  const wanted = reminders
    .filter((each) => notifies(each, now))
    .toSorted((a, b) => a.start - b.start)
    .slice(0, SCHEDULED)
    .map(noticeOf);
  const scheduled = await module.scheduled();
  const stale = scheduled.filter((each) => !wanted.some((want) => sameNotice(want, each)));
  if (stale.length) await module.cancel(stale.map((each) => each.id));
  const missing = wanted.filter((want) => !scheduled.some((each) => sameNotice(want, each)));
  if (missing.length) await module.schedule(missing);
}

/**
 * One check: every reminder against the saved subscriptions, the channels Live lists and the
 * guide at the time now, written when that changed it, then iOS's notifications made to match.
 * A reminder set or cancelled while the guide is read stays as that left it.
 */
async function checkOnce() {
  const before = keptNow();
  if (before.kind !== "read") return;
  const roster = currentRoster();
  const saved = roster.kind === "ready" ? new Set(roster.members.map((m) => m.entry.id)) : null;
  const catalogue = currentCatalogue();
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const now = Date.now();
  // By reminder as read, what it comes to: null for one that goes.
  const checked = new Map<KeptReminder, KeptReminder | null>();
  for (const reminder of before.reminders) {
    if (now >= reminder.stop || (saved && !saved.has(reminder.subscriptionId))) {
      checked.set(reminder, null);
      continue;
    }
    const channel = channelOf(reminder, library);
    const found = channel ? foundAs(channel) : channel;
    if (now >= reminder.start) {
      checked.set(reminder, found ? relisted(reminder, found) : reminder);
      continue;
    }
    let programme: Pick<Programme, "title" | "stop"> | null | undefined;
    if (channel) {
      try {
        const answer = await guide.programmeAt(channel.key, reminder.start);
        programme = answer === null ? undefined : answer.kind === "none" ? null : answer.programme;
      } catch {
        // As a guide that didn't answer: nothing is known.
      }
    }
    checked.set(reminder, seen(reminder, found, programme));
  }
  const current = keptNow();
  if (current.kind !== "read") return;
  const next = current.reminders.flatMap((each) => {
    const after = checked.get(each);
    return after === undefined ? [each] : after ? [after] : [];
  });
  if (
    next.length !== current.reminders.length ||
    next.some((each, at) => JSON.stringify(each) !== JSON.stringify(current.reminders[at]))
  ) {
    try {
      save(next);
    } catch {
      // The disk keeps what it had; notifications follow what the screens show, and the next
      // check writes again.
    }
  }
  const shown = keptNow();
  await sync(shown.kind === "read" ? shown.reminders : current.reminders);
}

let checking: Promise<void> | null = null;
let again = false;
/** Checks every reminder now; one asked while a check runs runs once it ends. */
export function checkReminders(): Promise<void> {
  if (checking) {
    again = true;
    return checking;
  }
  checking = (async () => {
    do {
      again = false;
      try {
        await checkOnce();
      } catch {
        // A native call that failed: the next check tries again.
      }
    } while (again);
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/**
 * Sets a reminder for `programme` of `channel`, still to come, once iOS lets the app notify,
 * asking the viewer the first time: `denied`, saving nothing, where it doesn't. One already set for
 * that channel at that start stays as it is. Throws, changing nothing, while the programme has
 * started or the file can't be used or written.
 */
export async function setReminder(
  channel: Channel,
  programme: Pick<Programme, "start" | "stop" | "title">,
): Promise<"set" | "denied"> {
  const started = () => programme.start <= Date.now();
  if (started()) throw new AppFailure({ kind: "reminder", reason: "started" });
  if (channel.adult) throw new AppFailure({ kind: "reminder", reason: "not-in-guide" });
  // Before iOS asks anything: a file that can't be used refuses at once.
  stored();
  const module = native();
  if (module) {
    let allowed = await module.permission();
    if (allowed === "undetermined") allowed = await module.ask();
    permission.set(allowed);
    if (allowed === "denied") return "denied";
  }
  // The viewer may have taken a while with iOS's prompt.
  if (started()) throw new AppFailure({ kind: "reminder", reason: "started" });
  const reminders = stored();
  const found = foundAs(channel);
  const wanted = { subscriptionId: channel.subscriptionId, streams: found.streams };
  if (!reminders.some((each) => sameReminder(each, { ...wanted, start: programme.start }))) {
    save([
      ...reminders,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        subscriptionId: channel.subscriptionId,
        channel: found.id,
        streams: found.streams,
        channelName: found.name,
        adult: found.adult,
        start: programme.start,
        stop: programme.stop,
        set: programme.title,
        title: programme.title,
        state: { kind: "pending" },
      },
    ]);
  }
  await checkReminders();
  return "set";
}

/** Takes reminder `id` out, with its notification. One that is gone changes nothing. */
export async function cancelReminder(id: string): Promise<void> {
  const reminders = stored();
  if (!reminders.some((each) => each.id === id)) return;
  save(reminders.filter((each) => each.id !== id));
  try {
    await native()?.cancel([id]);
  } catch {
    // The next check takes down what no reminder wants.
    void checkReminders();
  }
}

/** The reminders, in start order, or why they can't show. */
export type ReminderList =
  | { readonly kind: "read"; readonly reminders: readonly Reminder[] }
  | { readonly kind: "unreadable" | "foreign" };

const subscribeAll = (listener: () => void) => {
  const stops = [kept.subscribe(listener), onCatalogue(listener)];
  return () => {
    for (const stop of stops) stop();
  };
};

let listed: { readonly from: readonly unknown[]; readonly list: ReminderList } | null = null;
/** The reminders as they stand: drawn again as they, or the channels Live lists, change. */
function currentList(): ReminderList {
  const from = keptNow();
  const catalogue = currentCatalogue();
  const minute = Math.floor(Date.now() / 60_000);
  if (
    listed &&
    listed.from[0] === from &&
    listed.from[1] === catalogue &&
    listed.from[2] === minute
  )
    return listed.list;
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const now = Date.now();
  const list: ReminderList =
    from.kind === "read"
      ? {
          kind: "read",
          reminders: from.reminders
            .filter((each) => now < each.stop && !each.adult)
            .toSorted((a, b) => a.start - b.start || a.channelName.localeCompare(b.channelName))
            .map((each) => shownAs(each, library, now)),
        }
      : from;
  listed = { from: [from, catalogue, minute], list };
  return list;
}

export const useReminders = (): ReminderList => useSyncExternalStore(subscribeAll, currentList);

/** Whether iOS lets the app notify, as last asked; null before. */
export const usePermission = () => useStore(permission);

/** The reminder set on channel `key` at `start`, as it stands, or null. */
export function useReminder(key: string, start: number | undefined): Reminder | null {
  const list = useReminders();
  if (list.kind !== "read" || start === undefined) return null;
  return list.reminders.find((each) => each.key === key && each.start === start) ?? null;
}

/** Opens a tapped notification's programme: its details on Live's stack, which play nothing. */
function openTapped() {
  const opened = native()?.takeOpened();
  if (!opened) return;
  router.push({
    pathname: "/live/programme",
    params: { channel: opened.channel, start: String(opened.at) },
  });
}

let started = false;
/**
 * Once, as the app's screens mount: checks the reminders now, again as the app comes back,
 * providers or their channels change, or the guide does, and opens a tapped notification's
 * programme, also the one that launched the app.
 */
export function startReminders() {
  if (started) return;
  started = true;
  const check = () => void checkReminders();
  onRoster(check);
  onCatalogue(check);
  guide.listingRevision.subscribe(check);
  AppState.addEventListener("change", (state) => {
    if (state === "active") check();
  });
  native()?.addListener("opened", openTapped);
  openTapped();
  check();
}
