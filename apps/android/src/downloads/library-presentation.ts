import type { DownloadPresentation, MediaIdentity } from "../library/intents.ts";
import type { DownloadRow } from "./state.ts";
import { t } from "./copy.ts";

/** Exact provider file identity keeps other episodes and versions independent. */
export function libraryDownload(
  rows: readonly DownloadRow[],
  media: MediaIdentity,
  act: (row: DownloadRow, action: "pause" | "resume" | "retry" | "open") => void,
): DownloadPresentation | undefined {
  const id = media.kind === "movie" ? media.titleId : media.episodeId;

  const row = rows.find(
    (entry) =>
      entry.sourceId === media.sourceId &&
      entry.kind === media.kind &&
      entry.mediaId === id &&
      (!media.version.container || entry.container === media.version.container),
  );

  if (!row) return undefined;
  const state = row.state;

  const action =
    state === "complete"
      ? "open"
      : state === "failed"
        ? "retry"
        : state === "paused"
          ? "resume"
          : "pause";

  return {
    text: t(
      state === "complete"
        ? "Downloaded"
        : state === "failed"
          ? row.reason === "missing"
            ? "File missing"
            : "The download couldn't go on from where it stopped."
          : state === "paused"
            ? "Paused"
            : state === "removing"
              ? "Removing"
              : state === "running"
                ? "Downloading"
                : "Queued",
    ),
    label: t(
      action === "open"
        ? "Downloads"
        : action === "retry"
          ? "Retry"
          : action === "resume"
            ? "Resume"
            : "Pause",
    ),
    icon:
      state === "complete"
        ? "done"
        : state === "failed"
          ? "retry"
          : state === "paused" || state === "queued"
            ? "empty"
            : "stop",
    progress: row.total > 0 ? Math.min(1, row.bytes / row.total) : 0,
    activate: () => {
      if (state !== "removing") act(row, action);
    },
  };
}
