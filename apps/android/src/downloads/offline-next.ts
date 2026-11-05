import { type } from "arktype";
import { t } from "./copy.ts";
import { rowStatus } from "./presentation.ts";
import { Snapshot, type DownloadRow, type TransferPort } from "./state.ts";

export type OfflineNext =
  | { readonly kind: "ready"; readonly row: DownloadRow; readonly path: string }
  | {
      readonly kind: "downloading" | "missing" | "changed" | "not-saved" | "read";
      readonly row?: DownloadRow;
    }
  | { readonly kind: "last" };

/** Never searches past the immediate next episode and never resolves a provider address. */
export async function offlineNext(
  port: Pick<TransferPort, "snapshot" | "path">,
  current: DownloadRow,
): Promise<OfflineNext> {
  if (!current.seriesId || !current.order) return { kind: "last" };
  const at = current.order.indexOf(current.mediaId);
  const id = at < 0 ? undefined : current.order[at + 1];

  if (!id) return { kind: "last" };

  try {
    const parsed = Snapshot(JSON.parse(await port.snapshot()));

    if (parsed instanceof type.errors) return { kind: "read" };

    const matches = parsed.rows.filter(
      (r) => r.sourceId === current.sourceId && r.seriesId === current.seriesId && r.mediaId === id,
    );

    let unavailable: OfflineNext | undefined;

    for (const row of matches.filter((row) => row.state === "complete")) {
      try {
        return { kind: "ready", row, path: await port.path(row.id) };
      } catch {
        const fresh = Snapshot(JSON.parse(await port.snapshot()));

        if (fresh instanceof type.errors) return { kind: "read" };
        const checked = fresh.rows.find((r) => r.id === row.id);
        unavailable ??= {
          kind:
            checked?.reason === "file-changed"
              ? "changed"
              : checked?.reason === "missing"
                ? "missing"
                : "read",
          row: checked ?? row,
        };
      }
    }

    const active = matches.find(
      (row) => row.state === "queued" || row.state === "running" || row.state === "paused",
    );

    if (active) return { kind: "downloading", row: active };

    if (unavailable) return unavailable;

    const row =
      matches.find((row) => row.reason === "file-changed" || row.reason === "missing") ??
      matches[0];

    if (!row) return { kind: "not-saved" };

    return {
      kind:
        row.reason === "file-changed"
          ? "changed"
          : row.reason === "missing"
            ? "missing"
            : "not-saved",
      row,
    };
  } catch {
    return { kind: "read" };
  }
}

/**
 * What the end of a downloaded episode says when the next one can't play from this device, as
 * Paper A's offline series page draws it beside Play again: "S1 E2 is still downloading" with its
 * progress and Downloads, "S1 E5 isn't on this device" with Downloads, or "S1 E6 · File missing"
 * with Replace. A copy still downloading is never called missing and never offers Replace. Null
 * when the next copy plays (the countdown says so) or there is no next episode.
 */
export interface OfflineNextNotice {
  /** The episode, or the whole sentence when there is no status. */
  readonly lead: string;
  /** Drawn red after the lead: "File missing", "File changed". */
  readonly status: string | null;
  /** The quieter line after them. */
  readonly detail: string | null;
  /** Downloads, or Replace on the next episode's own copy. */
  readonly action:
    { readonly kind: "downloads" } | { readonly kind: "replace"; readonly row: DownloadRow };
}

/** `episode` names the next episode when its copy isn't saved at all ("S1 E5"), if known. */
export function offlineNextNotice(next: OfflineNext, episode?: string): OfflineNextNotice | null {
  if (next.kind === "ready" || next.kind === "last") return null;

  const code =
    next.row?.season !== undefined && next.row.episode !== undefined
      ? `S${next.row.season} E${next.row.episode}`
      : (episode ?? t("The next episode"));

  const downloads = { kind: "downloads" } as const;

  switch (next.kind) {
    case "downloading":
      return {
        lead: t(
          next.row?.state === "paused"
            ? "{episode} download is paused"
            : "{episode} is still downloading",
          { episode: code },
        ),
        status: null,
        detail: next.row ? rowStatus(next.row, false).text : null,
        action: downloads,
      };
    case "missing":
    case "changed":
      return {
        lead: code,
        status: t(next.kind === "missing" ? "File missing" : "File changed"),
        detail: t("Replace it to go on."),
        action: next.row ? { kind: "replace", row: next.row } : downloads,
      };
    case "not-saved":
      return {
        lead: t("{episode} isn't on this device", { episode: code }),
        status: null,
        detail: t("Download it to go on."),
        action: downloads,
      };
    case "read":
      return { lead: t("Couldn't read downloads."), status: null, detail: null, action: downloads };
  }
}
