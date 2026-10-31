// Recordings as the window reads them. The main process keeps each one's record and file and says
// when any changes (`recordings.changed`), about once a second while one records, so the list is
// read once and then follows those events, as the schedules do (./schedules.ts). An ended
// recording plays like a downloaded copy.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  Recording,
  RecordingGap,
  RecordingGapReason,
  RecordingLimits,
  ScheduleMiss,
} from "@mrstreamer/contracts/recordings";
import { create } from "zustand";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { call, listen } from "../../lib/ipc.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { schedulesQuery, useSchedules } from "./schedules.ts";

const recordingsQuery = () =>
  queryOptions({
    queryKey: ["recordings"],
    queryFn: () => call("recordings.list"),
    staleTime: Infinity,
  });

/**
 * Keeps the recordings and the schedules current from main's events, and the previews of plans
 * being edited, whose conflicts follow the schedules. Returns the unsubscribe function.
 */
export function syncRecordings(client: QueryClient): () => void {
  const stopRecordings = listen("recordings.changed", (list) => {
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
  });
  return () => {
    stopRecordings();
    stopSchedules();
  };
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

const anyRecording = (list: readonly Recording[]) => list.length > 0;

/**
 * Whether any recording is kept or scheduled, for the window bar's entry: true until both lists
 * are read, so one that failed can be read again from Recordings.
 */
export function useAnyRecording(): boolean {
  const recorded = useQuery({ ...recordingsQuery(), select: anyRecording }).data;
  const scheduled = useSchedules().data;
  return recorded !== false || scheduled === undefined || scheduled.length > 0;
}

/** The recording capturing `channel` now, if one does. */
export function useRecordingOf(channel: OwnedId): Recording | null {
  const { data } = useRecordings();
  return (
    data?.find((each) => each.status.kind === "recording" && sameOwned(each.channel, channel)) ??
    null
  );
}

/**
 * Plays an ended recording over everything, from where it was left, through the title player's
 * copy path: main opens it by id from this computer, and Recordings keeps where it got to. It has
 * no title of the provider's, so it plays as a movie would, with nothing after it.
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
 * Captured and planned whole minutes, what the coverage bar and "3 of 52 min" show, those missed
 * at the start: a late schedule's from when it was owed to when it began, or all of a missed one,
 * and the gaps it missed since, by minutes from where coverage starts, one still going on to now.
 * One on time, or saved after its start, is planned from when it began. All count whole minutes
 * from where coverage starts, and a complete one's add up to what was planned, at least a minute.
 */
export function coverage(
  recording: Recording,
  now: number,
): {
  captured: number;
  planned: number;
  missed: number;
  gaps: readonly { readonly from: number; readonly to: number }[];
} {
  const from = coverageStart(recording);
  const minutesTo = (at: number) => Math.max(0, Math.floor((at - from) / MINUTE_MS));
  const planned = Math.max(1, minutesTo(recording.stop));
  if (recording.status.kind === "missed")
    return { captured: 0, planned, missed: planned, gaps: [] };
  // Whole minutes, as main counts a start within one as on time.
  const missed = Math.min(planned, minutesTo(recording.start));
  const reached =
    recording.status.kind === "complete"
      ? planned
      : minutesTo(recording.ended ?? Math.min(now, recording.stop));
  const gaps = (recording.gaps ?? []).flatMap((gap) => {
    const span = {
      from: Math.min(reached, minutesTo(gap.from)),
      to: Math.min(reached, minutesTo(gap.to ?? now)),
    };
    return span.to > span.from ? [span] : [];
  });
  const lost = gaps.reduce((sum, gap) => sum + gap.to - gap.from, 0);
  const captured = Math.min(planned - missed, Math.max(0, reached - missed - lost));
  return { captured, planned, missed, gaps };
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

/** "20:31 to 20:45 missed. The computer slept." for one gap; for several, how much they missed. */
function gapsText(gaps: readonly RecordingGap[], now: number): string | null {
  const settled = gaps.filter((gap) => gap.to !== null);
  const first = settled[0];
  if (!first) return null;
  if (settled.length === 1)
    return `${t("{from} to {to} missed.", {
      from: formatDate(first.from, "time"),
      to: formatDate(first.to ?? now, "time"),
    })} ${gapText(first.why)}`;
  const minutes = settled.reduce(
    (sum, gap) => sum + Math.max(1, Math.round(((gap.to ?? now) - gap.from) / MINUTE_MS)),
    0,
  );
  return `${t("{minutes} min missed in between.", { minutes })} ${gapText(settled.at(-1)!.why)}`;
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
  const told = ending(recording, now);
  const { word } = told;
  // Gaps in between say what they missed; an end the app couldn't write down yet says so.
  const missedBetween =
    recording.status.kind === "paused" ? null : gapsText(recording.gaps ?? [], now);
  const reason = [
    told.reason,
    missedBetween,
    recording.unsaved ? t("Not saved yet. Trying again.") : null,
  ]
    .filter(Boolean)
    .join(" ");
  const { scheduled } = recording;
  if (!scheduled?.late || recording.status.kind === "missed") return { word, reason };
  // Whole minutes, as the coverage bar hatches them.
  const minutes = Math.max(1, Math.floor((recording.start - coverageStart(recording)) / MINUTE_MS));
  const started = `${t("Started {minutes} min late.", { minutes })} ${missText(scheduled.late)}`;
  return { word, reason: recording.status.kind === "complete" ? started : `${started} ${reason}` };
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
