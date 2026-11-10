// Recordings as the window reads them. The main process keeps each one's record and file and says
// when any changes (`recordings.changed`), about once a second while one records, so the list is
// read once and then follows those events, as the schedules do (./schedules.ts). Where each
// viewer got to in a recording is theirs alone (`recordings.resume`), read again when main says it
// changed (`recordings.resumeChanged`), never on the list's own changes. A recording plays like a
// downloaded copy, also while it records.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  Recording,
  RecordingGap,
  RecordingGapReason,
  RecordingLimits,
  RecordingResumeList,
  RecordingRule,
  ScheduledRecording,
  ScheduleMiss,
} from "@mrstreamer/contracts/recordings";
import { create } from "zustand";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { currentLanguage, formatDate, t } from "@mrstreamer/core/i18n";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { useUi } from "../../app/ui-store.ts";
import { call, listen } from "../../lib/ipc.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { rulesQuery, schedulesQuery, useRules, useSchedules } from "./schedules.ts";

const recordingsQuery = () =>
  queryOptions({
    queryKey: ["recordings"],
    queryFn: () => call("recordings.list"),
    staleTime: Infinity,
  });

/**
 * The active profile's places in recordings. `call` refuses an answer for a profile no longer
 * active, and a profile switch clears the cache (profiles.ts).
 */
const resumeQuery = () =>
  queryOptions({
    queryKey: ["recordings", "resume"],
    queryFn: () => call("recordings.resume"),
    staleTime: Infinity,
  });

/** One recording's place for this viewer, as `recordings.resume` gave it. */
export type RecordingPlace = RecordingResumeList["items"][number]["progress"];

/**
 * This viewer's places in recordings, by recording id, and the recordings they name: also one the
 * list no longer has. A read that failed stays a failure, with its places unknown, not empty.
 */
export function useRecordingResume(enabled = true) {
  return useQuery({ ...resumeQuery(), select: placesOf, enabled });
}

function placesOf(list: RecordingResumeList) {
  return {
    places: new Map(list.items.map((item) => [item.recording.id, item.progress] as const)),
    items: list.items,
  };
}

/**
 * Whether `place` was saved against the recording's length as it ended: after it ended, or before
 * places kept their time, which only an ended recording had. One saved while it recorded was
 * saved against what it had so far, which says nothing of what is left.
 */
export function settledPlace(recording: Recording, place: RecordingPlace): boolean {
  return (
    !isLive(recording) &&
    (place.at === null || (recording.ended !== null && place.at >= recording.ended))
  );
}

/**
 * How far this viewer got, in words for the library: "at 31 min", "at 20 s" short of a minute, or
 * "watched" once a place saved after it ended is in its credits.
 */
export function placeText(recording: Recording, place: RecordingPlace | undefined): string | null {
  if (!place || place.position <= 0) return null;

  if (watched(recording, place)) return t("watched");
  const seconds = Math.floor(place.position);

  return seconds < 60
    ? t("at {seconds} s", { seconds })
    : t("at {minutes} min", { minutes: Math.floor(seconds / 60) });
}

const watched = (recording: Recording, place: RecordingPlace) =>
  settledPlace(recording, place) && isFinished(place.position, place.duration);

/** Whether Play goes on from a place: one with a position, not watched to its credits. */
export function resumes(recording: Recording, place: RecordingPlace | undefined): boolean {
  return !!place && place.position > 0 && !watched(recording, place);
}

/**
 * Keeps the recordings and the schedules current from main's events, and the previews of plans
 * being edited, whose conflicts follow the schedules. Returns the unsubscribe function.
 */
export function syncRecordings(client: QueryClient): () => void {
  const stopRecordings = listen("recordings.changed", (list) => {
    const before = client.getQueryData(recordingsQuery().queryKey)?.filter(isLive);
    const live = list.filter(isLive);

    if (
      !before ||
      before.length !== live.length ||
      live.some((each) => !before.some((old) => old.id === each.id))
    )
      void client.invalidateQueries({ queryKey: ["rules", "preview"] });

    // A read still under way holds an older list than this: it must not land after it.
    void client.cancelQueries({ queryKey: recordingsQuery().queryKey, exact: true });
    client.setQueryData(recordingsQuery().queryKey, list);
    void client.invalidateQueries({ queryKey: storageQuery().queryKey, exact: true });
  });

  const stopSchedules = listen("recordings.schedulesChanged", (list) => {
    const { queryKey } = schedulesQuery();
    void client.cancelQueries({ queryKey, exact: true });
    client.setQueryData(queryKey, list);
    void client.invalidateQueries({ queryKey: [...queryKey, "plan"] });
    void client.invalidateQueries({ queryKey: rulesQuery().queryKey, exact: true });
    void client.invalidateQueries({ queryKey: ["rules", "preview"] });
  });

  // Carries no rows: main says this viewer's places changed, so they are read again.
  const stopResume = listen("recordings.resumeChanged", () => {
    void client.invalidateQueries({ queryKey: resumeQuery().queryKey, exact: true });
  });

  return () => {
    stopRecordings();
    stopSchedules();
    stopResume();
  };
}

/** Recordings of one programme followed by a rule, or of one repeating schedule. */
export interface RecordingGroup {
  readonly key: string;
  readonly name: string;
  /** The rule that records them, while it is kept; null once stopped, or for a schedule's. */
  readonly rule: RecordingRule | null;
  /** Newest first, as the list has them. */
  readonly recordings: readonly Recording[];
}

/**
 * Recordings by what they were saved with: a rule's id, else a schedule's id two or more of them
 * share. The rest, manual ones and those made before recordings kept their rule, are `other`.
 * A group's name is its rule's or schedule's title while kept, else its newest recording's, so a
 * stopped rule or a channel gone keeps its group. Groups go by name.
 */
export function recordingGroups(
  recordings: readonly Recording[],
  rules: readonly RecordingRule[],
  schedules: readonly ScheduledRecording[],
): { readonly groups: readonly RecordingGroup[]; readonly other: readonly Recording[] } {
  const shared = new Map<string, number>();

  for (const { scheduled } of recordings) {
    if (scheduled && scheduled.rule === undefined)
      shared.set(scheduled.schedule, (shared.get(scheduled.schedule) ?? 0) + 1);
  }

  const keyOf = ({ scheduled }: Recording): string | null =>
    scheduled?.rule !== undefined
      ? `rule:${scheduled.rule}`
      : scheduled && (shared.get(scheduled.schedule) ?? 0) > 1
        ? `schedule:${scheduled.schedule}`
        : null;

  const byKey = new Map<string, Recording[]>();
  const other: Recording[] = [];

  for (const recording of recordings) {
    const key = keyOf(recording);

    if (key === null) other.push(recording);
    else byKey.set(key, [...(byKey.get(key) ?? []), recording]);
  }

  const groups = [...byKey].map(([key, members]): RecordingGroup => {
    const { scheduled } = members[0]!;
    const rule = rules.find((each) => each.id === scheduled?.rule) ?? null;

    const schedule = rule
      ? undefined
      : schedules.find((each) => each.id === scheduled?.schedule && scheduled?.rule === undefined);

    return {
      key,
      name: rule?.plan.title ?? schedule?.plan.title ?? members[0]!.title,
      rule,
      recordings: members,
    };
  });

  return {
    groups: groups.toSorted((a, b) =>
      a.name.localeCompare(b.name, currentLanguage().locale, { sensitivity: "base" }),
    ),
    other,
  };
}

/** Whether `query` is in a recording's title or channel name, case and accents aside. */
export function matchesRecording(recording: Recording, query: string): boolean {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase(currentLanguage().locale);

  const wanted = fold(query.trim());

  return (
    wanted === "" ||
    fold(recording.title).includes(wanted) ||
    fold(recording.channelName).includes(wanted)
  );
}

export function useRecordings() {
  return useQuery(recordingsQuery());
}

const storageQuery = () =>
  queryOptions({ queryKey: ["recordings", "storage"], queryFn: () => call("recordings.storage") });

/**
 * Where new recordings go, the room they may take and how much they take, read again as the
 * recordings change.
 */
export function useRecordingStorage() {
  return useQuery(storageQuery());
}

/** Keeps Keep free on disk and Space for recordings, or asks for another folder. */
export async function changeStorage(
  client: QueryClient,
  change: RecordingLimits | "folder",
): Promise<void> {
  const storage =
    change === "folder"
      ? await call("recordings.chooseFolder")
      : await call("recordings.setLimits", change);

  client.setQueryData(storageQuery().queryKey, storage);
}

/**
 * Whether the viewer asked to quit while a recording's time goes on, so the window asks first
 * (`window.leaveAsked`); Quit there answers with `confirmQuit`.
 */
export const useQuitAsked = create<{ asked: boolean }>(() => ({ asked: false }));

listen("window.leaveAsked", () => useQuitAsked.setState({ asked: true }));

/** Quits, ending what records and keeping what it captured. */
export function confirmQuit(): Promise<null> {
  useQuitAsked.setState({ asked: false });

  return call("window.quit");
}

/** Whether `recording`'s time goes on: it records, or waits paused to record the rest. */
export const isLive = (recording: Recording) =>
  recording.status.kind === "recording" || recording.status.kind === "paused";

/** The recordings whose time goes on, the one that stops last first. */
export function useLiveRecordings(): readonly Recording[] {
  const list = useRecordings().data ?? [];

  return list.filter(isLive).toSorted((a, b) => b.stop - a.stop);
}

const GIB = 1024 ** 3;

/**
 * A storage limit as Settings offers it, "5 GB" or "1 TB": the limits count in binary units, so
 * the default of 5 GiB reads as the 5 GB it was chosen as.
 */
export function formatLimit(bytes: number): string {
  const tb = bytes >= 1024 * GIB;

  return new Intl.NumberFormat(currentLanguage().locale, {
    style: "unit",
    unit: tb ? "terabyte" : "gigabyte",
    maximumFractionDigits: 1,
  }).format(bytes / (tb ? 1024 * GIB : GIB));
}

const anyRecording = (list: readonly Recording[]) => list.length > 0;

/** Keeps Recordings reachable for retained or unread inventories, including following rules. */
export function useAnyRecording(): boolean {
  const recorded = useQuery({ ...recordingsQuery(), select: anyRecording }).data;
  const scheduled = useSchedules().data;
  const rules = useRules();

  return (
    recorded !== false ||
    scheduled === undefined ||
    scheduled.length > 0 ||
    rules.isError ||
    rules.data === undefined ||
    rules.data.length > 0
  );
}

/** The recording capturing `channel` now, if one does. */
export function useRecordingOf(channel: OwnedId): Recording | null {
  const { data } = useRecordings();

  return (
    data?.find(
      (each) =>
        (each.status.kind === "recording" || each.status.kind === "paused") &&
        sameOwned(each.channel, channel),
    ) ?? null
  );
}

/**
 * Plays a recording over everything, from where this viewer left it, through the title player's
 * copy path: main opens it by id from this computer, also while it records, and Recordings keeps
 * where it got to. It has no title of the provider's, so it plays as a movie would, with nothing
 * after it.
 */
export function playRecording(recording: Recording): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(
    {
      kind: "copy",
      copy: recording.id,
      title: { kind: "movie", id: recording.id },
      recording: true,
      name: recording.title,
      detail: recording.channelName,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
}

const MINUTE_MS = 60_000;

/**
 * Where a recording's coverage starts: for a late schedule, when capture was owed, its padded
 * start or when it was saved, if later; else when capture began.
 */
export function coverageStart(recording: Recording): number {
  const { scheduled } = recording;

  return scheduled?.late ? (scheduled.owed ?? scheduled.from) : recording.start;
}

/**
 * Captured and planned whole minutes, what "3 of 52 min" shows, and the coverage bar. Planned
 * minutes and the bar count from where coverage starts, captured from when capture began. Planned
 * minutes are whole ones to the stop, at least one. Captured is what it reached less its gaps,
 * one still going on to now, added up before it is rounded down to whole minutes, so it never
 * claims more than it has; a complete one shorter than a minute counts one, so its meter reads
 * full.
 * The bar shows the same spans as they were, as fractions of the planned time: hatched at the
 * start up to `late`, a late schedule's from when it was owed to when it began, or all of a missed
 * one, and over each of the `gaps` since, white up to where it `reached`.
 */
export function coverage(
  recording: Recording,
  now: number,
): {
  captured: number;
  planned: number;
  bar: {
    late: number;
    reached: number;
    gaps: readonly { readonly from: number; readonly to: number }[];
  };
} {
  const from = coverageStart(recording);
  const minutes = (ms: number) => Math.max(0, Math.floor(ms / MINUTE_MS));
  const planned = Math.max(1, minutes(recording.stop - from));

  const share = (at: number) =>
    Math.min(1, Math.max(0, (at - from) / Math.max(1, recording.stop - from)));

  if (recording.status.kind === "missed")
    return { captured: 0, planned, bar: { late: 1, reached: 1, gaps: [] } };
  const late = Math.min(planned, minutes(recording.start - from));
  const complete = recording.status.kind === "complete";
  const reached = complete ? recording.stop : Math.min(recording.ended ?? now, recording.stop);

  const gaps = (recording.gaps ?? []).flatMap((gap) => {
    const to = Math.min(reached, gap.to ?? now);

    return to > gap.from ? [{ from: gap.from, to }] : [];
  });

  const lost = gaps.reduce((sum, gap) => sum + gap.to - gap.from, 0);

  const captured = Math.min(
    planned - late,
    Math.max(complete ? 1 : 0, minutes(reached - recording.start - lost)),
  );

  return {
    captured,
    planned,
    bar: {
      late: share(recording.start),
      reached: share(reached),
      gaps: gaps.map((gap) => ({ from: share(gap.from), to: share(gap.to) })),
    },
  };
}

/** Why a recording missed time, as a sentence. */
function gapText(why: RecordingGapReason): string {
  switch (why) {
    case "away":
    case "busy":
    case "disk":
      return missText(why);
    case "stream":
      return t("The stream stopped.");
    case "space":
      return t("There wasn't enough free space.");
  }
}

/**
 * "20:31 to 20:45 missed. The computer slept." for one gap; for several, how much they missed
 * together, rounded once so short ones aren't each counted as a minute. Under a minute says so.
 */
function gapsText(gaps: readonly RecordingGap[]): string | null {
  // Those that missed any time, as coverage counts them.
  const settled = gaps.flatMap((gap) =>
    gap.to !== null && gap.to > gap.from ? [{ ...gap, to: gap.to }] : [],
  );

  const last = settled.at(-1);

  if (!last) return null;
  const lost = settled.reduce((sum, gap) => sum + gap.to - gap.from, 0);
  const one = settled.length === 1;

  const missed =
    lost < MINUTE_MS
      ? one
        ? t("Less than a minute missed at {time}.", { time: formatDate(last.from, "time") })
        : t("Less than a minute missed in between.")
      : one
        ? t("{from} to {to} missed.", {
            from: formatDate(last.from, "time"),
            to: formatDate(last.to, "time"),
          })
        : t("{minutes} min missed in between.", { minutes: Math.round(lost / MINUTE_MS) });

  return `${missed} ${gapText(last.why)}`;
}

/** Why a recording pauses, and that the rest is recorded once that passes. */
function pausedText(why: RecordingGapReason, since: string): string {
  switch (why) {
    case "away":
      return t("Paused at {time} while Mr. Streamer was closed or the computer slept.", {
        time: since,
      });
    case "busy":
      return t("Paused at {time}. Every connection is in use.", { time: since });
    case "stream":
      return t("Paused at {time}. The stream stopped. Trying again.", { time: since });
    case "disk":
      return t("Paused at {time}. It couldn't be written. Trying again.", { time: since });
    case "space":
      return t("Paused at {time}. Not enough free space; it goes on once there is room.", {
        time: since,
      });
  }
}

/** Why a schedule recorded late, or not at all. */
function missText(why: ScheduleMiss): string {
  switch (why) {
    case "away":
      return t("Mr. Streamer wasn't open, or the computer slept.");
    case "busy":
      return t("Every connection was in use.");
    case "stream":
      return t("The stream couldn't be opened.");
    case "disk":
      return t("It couldn't be written to this computer.");
    case "held":
      return t("The guide listed another programme then, or the channel was gone.");
    case "unread":
      return t("The channel list or guide wasn't read yet.");
  }
}

/**
 * How a recording ended or stands, in one word, and why, in a short sentence; one a schedule
 * started late says so first.
 */
export function outcome(recording: Recording, now: number): { word: string; reason: string } {
  const { word, reason: why } = ending(recording, now);
  const { scheduled } = recording;

  // Whole minutes, rounded down; main calls a start late only after a minute.
  const late =
    scheduled?.late && recording.status.kind !== "missed"
      ? `${t("Started {minutes} min late.", {
          minutes: Math.max(
            1,
            Math.floor((recording.start - coverageStart(recording)) / MINUTE_MS),
          ),
        })} ${missText(scheduled.late)}`
      : null;

  // A complete one that started late says that in place of how it ended. Gaps in between say
  // what they missed; an end the app couldn't write down yet says so.
  const reason = [
    late,
    late && recording.status.kind === "complete" ? null : why,
    recording.status.kind === "paused" ? null : gapsText(recording.gaps ?? []),
    recording.unsaved ? t("Not saved yet. Trying again.") : null,
  ]
    .filter(Boolean)
    .join(" ");

  return { word, reason };
}

function ending(recording: Recording, now: number): { word: string; reason: string } {
  const ended = formatDate(recording.ended ?? now, "time");
  const { status } = recording;

  switch (status.kind) {
    case "recording":
      return {
        word: t("Recording"),
        reason: t("{minutes} min left", {
          minutes: Math.max(1, Math.ceil((recording.stop - now) / MINUTE_MS)),
        }),
      };
    case "paused": {
      const since = recording.gaps?.findLast((gap) => gap.to === null)?.from ?? now;

      return { word: t("Paused"), reason: pausedText(status.why, formatDate(since, "time")) };
    }

    case "complete":
      return {
        word: t("Complete"),
        reason: recording.scheduled ? t("As scheduled.") : t("From when you pressed Record."),
      };
    case "stopped":
      return { word: t("Stopped"), reason: t("You stopped it at {time}.", { time: ended }) };
    case "partial":
      return {
        word: t("Partial"),
        // Recorded to its stop time, what it missed in between says why.
        reason:
          recording.ended !== null && recording.ended >= recording.stop && recording.gaps?.length
            ? ""
            : status.cut === "quit"
              ? t("Mr. Streamer closed at {time}.", { time: ended })
              : status.cut === "stream"
                ? t("The stream stopped at {time}.", { time: ended })
                : t("It couldn't be written from {time}.", { time: ended }),
      };
    case "missing":
      return { word: t("Missing"), reason: t("Its file is no longer on this computer.") };
    case "missed":
      return { word: t("Missed"), reason: `${missText(status.why)} ${t("No file.")}` };
  }
}
