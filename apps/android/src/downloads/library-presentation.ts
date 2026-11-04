import type { DownloadPresentation, MediaIdentity } from "../library/intents.ts";
import type { DownloadRow } from "./state.ts";
import { replaceable, rowStatus } from "./presentation.ts";
import { t } from "./copy.ts";

type Message = Parameters<typeof t>[0];

type LibraryAction = "replace" | "pause" | "resume" | "retry" | "open" | "remove";

const labels = {
  replace: "Replace",
  open: "Play offline",
  remove: "Retry",
  retry: "Retry",
  resume: "Resume",
  pause: "Pause",
} as const satisfies Record<LibraryAction, Message>;

/** A row's line in the library, its one action and that action's icon. */
function presented(row: DownloadRow): [string, LibraryAction, DownloadPresentation["icon"]] {
  switch (row.state) {
    case "complete":
      return [t("Downloaded"), "open", "done"];
    case "failed":
      return [
        rowStatus(row, false).text ?? t("File missing"),
        replaceable(row) ? "replace" : row.reason === "remove" ? "remove" : "retry",
        "retry",
      ];
    case "paused":
      return [t("Paused"), "resume", "empty"];
    case "queued":
      return [t("Queued"), "pause", "empty"];
    case "running":
      return [t("Downloading"), "pause", "stop"];
    case "removing":
      return [t("Removing"), "pause", "stop"];
  }
}

/** Exact provider file identity keeps other episodes and versions independent. */
export function libraryDownload(
  rows: readonly DownloadRow[],
  media: MediaIdentity,
  act: (row: DownloadRow, action: LibraryAction) => void,
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
  const [text, action, icon] = presented(row);

  return {
    text,
    label: t(labels[action]),
    icon,
    progress: row.total > 0 ? Math.min(1, row.bytes / row.total) : 0,
    // A row being removed has nothing left to do.
    activate: () => {
      if (row.state !== "removing") act(row, action);
    },
  };
}
