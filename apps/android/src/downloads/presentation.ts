import { runtime } from "@mrstreamer/core/viewing/continue";
import { formatBytes, formatPercent } from "@mrstreamer/core/i18n";
import type { DownloadRow } from "./state.ts";
import { t } from "./copy.ts";

// What a Downloads row says and offers, from the native snapshot alone. Paper A's downloads page:
// one state line, red only for a failure or a missing or changed file, one trailing action, and the
// rest in the long-press sheet.

/** What a row offers. `delete` and `cancel` ask first; the rest happen at once. */
export type RowChoice =
  | "replace"
  | "pause"
  | "resume"
  | "retry"
  | "play"
  | "delete"
  | "up"
  | "down"
  | "cancel"
  | "remove";

export interface RowStatus {
  /** The one state line, or null for a copy with nothing more to say. */
  readonly text: string | null;
  /** Drawn red: only a failure or a missing file. */
  readonly failed: boolean;
  /** From 0 to 1 while bytes arrive, drawn as a bar over the line. */
  readonly progress: number | null;
}

/** Listed under On this device: a finished copy, or one whose file went missing. */
export function isCopy(row: DownloadRow) {
  if (row.state === "removing") return row.total > 0 && row.bytes === row.total;

  return (
    row.state === "complete" ||
    (row.state === "failed" && (row.reason === "missing" || row.reason === "file-changed"))
  );
}

/** "1.2 GB of 2.8 GB", or null before anything arrived. */
function received(row: DownloadRow) {
  return row.bytes > 0 && row.total > 0
    ? t("{received} of {size}", { received: formatBytes(row.bytes), size: formatBytes(row.total) })
    : null;
}

const line = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");

/**
 * A row's state line. After a restart it says what reconciliation found: it went on (the row
 * simply continues), it restarted after a representation or credential change, it couldn't go on, or
 * its file is missing. Only native's checked completion is a copy; nothing else reads as one.
 */
export function rowStatus(row: DownloadRow, providerRemoved: boolean): RowStatus {
  const again = row.reason === "changed" ? t("started again") : null;
  const plain = (text: string | null) => ({ text, failed: false, progress: null });

  switch (row.state) {
    case "complete":
      return plain(providerRemoved ? t("Provider removed, copy kept") : null);
    case "removing":
      return plain(t("Removing"));
    case "failed":
      return {
        text: t(
          row.reason === "file-changed"
            ? "File changed. Replace it to play."
            : row.reason === "missing"
              ? "File missing"
              : row.reason === "playlist"
                ? "This provider returned a playlist, not a downloadable file."
                : row.reason === "document"
                  ? "This provider returned a document, not a video file."
                  : row.reason === "length"
                    ? "The provider did not report the file size. This file cannot be checked for completion."
                    : row.reason === "remove"
                      ? "The file could not be removed. Try removing it again."
                      : row.reason === "disk"
                        ? "Disk full. Free some space, then retry."
                        : row.reason === "credentials"
                          ? "The provider login changed or is unavailable."
                          : "The download couldn't go on from where it stopped.",
        ),
        failed: true,
        progress: null,
      };
    case "paused":
      return plain(line(t("Paused"), received(row)));
    case "queued":
    case "running":
      if (row.blocked) return plain(t("Waiting while {source} plays", { source: row.sourceLabel }));

      if (row.state === "queued") return plain(line(t("Queued"), received(row), again));

      if (row.total <= 0) return plain(line(t("Starting"), again));

      return {
        text: line(formatPercent(row.bytes / row.total), received(row), again),
        failed: false,
        progress: Math.min(row.bytes / row.total, 1),
      };
  }
}

/** The row's one 48dp action, or null while it is being removed. */
export function trailingChoice(row: DownloadRow): RowChoice | null {
  switch (row.state) {
    case "complete":
      return "play";
    case "failed":
      return row.reason === "missing" || row.reason === "file-changed"
        ? "replace"
        : row.reason === "remove"
          ? "remove"
          : "retry";
    case "paused":
      return "resume";
    case "queued":
    case "running":
      return "pause";
    case "removing":
      return null;
  }
}

/**
 * What the long-press sheet offers. Queue rows: Pause or Resume, Move up and down among those
 * waiting (queued or paused, in queue order), Cancel download. Failed rows: Retry and Remove.
 * Copies: Play offline and Delete download; a missing or changed one Replace and Delete download.
 */
export function sheetChoices(row: DownloadRow, rows: readonly DownloadRow[]): RowChoice[] {
  switch (row.state) {
    case "complete":
      return ["play", "delete"];
    case "failed":
      return row.reason === "missing" || row.reason === "file-changed"
        ? ["replace", "delete"]
        : ["retry", "remove"];
    case "removing":
      return [];
    case "running":
      return ["pause", "cancel"];
    case "queued":
    case "paused": {
      const waiting = rows.filter((r) => r.state === "queued" || r.state === "paused");
      const at = waiting.findIndex((r) => r.id === row.id);

      return [
        row.state === "paused" ? "resume" : "pause",
        ...(at > 0 ? (["up"] as const) : []),
        ...(at >= 0 && at < waiting.length - 1 ? (["down"] as const) : []),
        "cancel",
      ];
    }
  }
}

/** Saved title facts remain useful without the provider; legacy rows still show their size. */
export function rowFacts(row: DownloadRow): string {
  return [
    row.year,
    row.season !== undefined && row.episode !== undefined ? `S${row.season} E${row.episode}` : null,
    row.episodeName,
    row.duration ? runtime(row.duration) : null,
    row.total > 0 ? formatBytes(row.total) : null,
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(" · ");
}
