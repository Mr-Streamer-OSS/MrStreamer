// Recordings as the window reads them. The main process keeps each one's record and file and says
// when any changes (`recordings.changed`), about once a second while one records, so the list is
// read once and then follows those events, as the schedules do (./schedules.ts). An ended
// recording plays like a downloaded copy.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Recording, ScheduleMiss } from "@mrstreamer/contracts/recordings";
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
 * Plays an ended recording over everything, from its start, through the title player's copy path:
 * main opens it by id from this computer. It has no title of the provider's, so it plays as a
 * movie would, with nothing after it.
 */
export function playRecording(recording: Recording): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(
    {
      kind: "copy",
      copy: recording.id,
      title: { kind: "movie", id: recording.id },
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
 * Captured and planned whole minutes, what the coverage bar and "3 of 52 min" show, and those
 * missed at the start: a late schedule's from its padded start to when it began, or all of a
 * missed one. One on time, or saved after its start, is planned from when it began.
 */
export function coverage(
  recording: Recording,
  now: number,
): { captured: number; planned: number; missed: number } {
  const from = recording.scheduled?.late ? recording.scheduled.from : recording.start;
  const planned = Math.max(1, Math.round((recording.stop - from) / MINUTE_MS));
  if (recording.status.kind === "missed") return { captured: 0, planned, missed: planned };
  // Whole minutes, as main counts a start within one as on time.
  const missed = Math.min(planned, Math.max(0, Math.floor((recording.start - from) / MINUTE_MS)));
  const until =
    recording.status.kind === "complete"
      ? recording.stop
      : (recording.ended ?? Math.min(now, recording.stop));
  const captured = Math.min(
    planned - missed,
    Math.max(0, Math.floor((until - recording.start) / MINUTE_MS)),
  );
  return { captured, planned, missed };
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
  const { word, reason } = ending(recording, now);
  const { scheduled } = recording;
  if (!scheduled?.late || recording.status.kind === "missed") return { word, reason };
  // Whole minutes, as the coverage bar hatches them.
  const minutes = Math.max(1, Math.floor((recording.start - scheduled.from) / MINUTE_MS));
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
        reason:
          status.cut === "quit"
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
