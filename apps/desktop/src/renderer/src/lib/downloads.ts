// Downloads as the window reads and changes them. The main process keeps the queue and the
// copies and says when they change (`downloads.changed`), so the list is never asked for again
// while the window is open. A download names the exact version it was made of: details find
// theirs by the subscription that lists it now and the provider's ids.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Download, DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { useUi } from "../app/ui-store.ts";
import { titlePlayer, type CopyNow } from "../player/title-player.ts";
import { describeError } from "./errors.ts";
import { call, listen } from "./ipc.ts";
import { runtime } from "./titles.ts";

export const downloadsQuery = () =>
  queryOptions({
    queryKey: ["downloads"],
    queryFn: () => call("downloads.list"),
    staleTime: Infinity,
  });

/** Keeps the list current: every change, and a transfer's progress, arrives as an event. */
export function syncDownloads(client: QueryClient): () => void {
  return listen("downloads.changed", (list) => {
    client.setQueryData(downloadsQuery().queryKey, list);
  });
}

export function useDownloads() {
  return useQuery(downloadsQuery());
}

/**
 * The download of an exact movie or episode version of `subscriptionId`, or null: one made of it
 * while another subscription of that account was saved counts too, as the list names it by the
 * subscription it is of now.
 */
export function useDownloadOf(
  subscriptionId: string,
  title: Pick<RawTitleRef, "kind" | "id">,
): Download | null {
  const list = useDownloads().data;
  return (
    list?.items.find(
      (each) =>
        each.subscription?.id === subscriptionId &&
        each.title.kind === title.kind &&
        each.title.id === title.id,
    ) ?? null
  );
}

/** "S2 E3 · Its name", or null for a movie. */
export function episodeLine(download: Download): string | null {
  const { title } = download;
  if (title.kind !== "episode") return null;
  const label = episodeLabel(title.season, title.episode);
  return download.episodeName ? `${label} · ${download.episodeName}` : label;
}

/** What the player shows for a copy: like its title online, with "Offline" for its subscription. */
function copyNow(download: Download): CopyNow {
  const episode = episodeLine(download);
  return {
    kind: "copy",
    copy: download.id,
    name: download.name,
    detail: [episode ?? download.year, "Offline"].filter(Boolean).join(" · "),
    artworkUrl: download.wideUrl ?? download.posterUrl,
    originalLanguage: download.originalLanguage,
  };
}

/** Plays a copy over everything, from where it was left, or from its start once it was watched. */
export function watchOffline(download: Download): void {
  const { progress } = download;
  const from =
    progress && !isFinished(progress.position, progress.duration)
      ? Math.max(0, progress.position - 5)
      : 0;
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(copyNow(download), from);
}

/** "1.4 GB", "820 MB". */
export function bytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}

/** Why a download stopped, in one sentence, with what to do about it. */
export function describeFailure(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "disk-full":
      return failure.needed === null
        ? "Disk full. Free some space, then retry."
        : `Disk full. Free ${bytes(failure.needed)}, then retry.`;
    case "folder":
      return "The downloads folder can't be written. Retry, or check the disk.";
    case "stream":
      return describeError({ kind: "stream", failure: failure.failure });
    case "app":
      return describeError(failure.error);
  }
}

/** How a download stands, as its row says it under the title. */
export function statusLine(download: Download): string {
  const { status } = download;
  switch (status.kind) {
    case "queued":
      return "Queued";
    case "waiting":
      return download.subscription
        ? `Waiting while ${download.subscription.name} plays`
        : "Waiting for playback";
    case "transferring": {
      if (status.size === null || status.size === 0) {
        return status.received > 0 ? `${bytes(status.received)}` : "Starting";
      }
      const left =
        status.rate && status.rate > 0 ? (status.size - status.received) / status.rate : null;
      return [
        `${Math.floor((status.received / status.size) * 100)}%`,
        `${bytes(status.received)} of ${bytes(status.size)}`,
        left !== null ? `${runtime(left)} left` : null,
        status.restarted ? "started again, the file changed" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "failed":
      return describeFailure(status.failure);
    case "complete":
      return "";
    case "missing":
      return "The file is no longer on this computer.";
  }
}

/** How far a transfer is, from 0 to 1, when its size is known. */
export function transferred(download: Download): number | null {
  const { status } = download;
  return status.kind === "transferring" && status.size ? status.received / status.size : null;
}
