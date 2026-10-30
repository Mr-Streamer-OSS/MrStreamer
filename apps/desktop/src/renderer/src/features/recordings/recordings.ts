// Recordings as the window reads them. The main process keeps each one's record and file and says
// when any changes (`recordings.changed`), a few times a second while one records, so the list is
// read once and then follows those events. An ended recording plays like a downloaded copy.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { call, listen } from "../../lib/ipc.ts";
import { titlePlayer } from "../../player/title-player.ts";

const recordingsQuery = () =>
  queryOptions({
    queryKey: ["recordings"],
    queryFn: () => call("recordings.list"),
    staleTime: Infinity,
  });

/** Keeps the list current from main's events. Returns the unsubscribe function. */
export function syncRecordings(client: QueryClient): () => void {
  return listen("recordings.changed", (list) => {
    // A read still under way holds an older list than this: it must not land after it.
    void client.cancelQueries({ queryKey: recordingsQuery().queryKey, exact: true });
    client.setQueryData(recordingsQuery().queryKey, list);
  });
}

export function useRecordings() {
  return useQuery(recordingsQuery());
}

const anyRecording = (list: readonly Recording[]) => list.length > 0;

/** Whether any recording is kept, for the window bar's entry; true until the list is read. */
export function useAnyRecording(): boolean {
  return useQuery({ ...recordingsQuery(), select: anyRecording }).data ?? true;
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

/** Captured and planned whole minutes: what the coverage bar and "3 of 52 min" show. */
export function coverage(recording: Recording, now: number): { captured: number; planned: number } {
  const planned = Math.max(1, Math.round((recording.stop - recording.start) / MINUTE_MS));
  const until =
    recording.status.kind === "complete"
      ? recording.stop
      : (recording.ended ?? Math.min(now, recording.stop));
  const captured = Math.min(
    planned,
    Math.max(0, Math.floor((until - recording.start) / MINUTE_MS)),
  );
  return { captured, planned };
}

/** How a recording ended or stands, in one word, and why, in a short sentence. */
export function outcome(recording: Recording, now: number): { word: string; reason: string } {
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
      return { word: t("Complete"), reason: t("From when you pressed Record.") };
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
  }
}
