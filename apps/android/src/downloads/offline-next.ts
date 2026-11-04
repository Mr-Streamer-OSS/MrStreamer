import { type } from "arktype";
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

    const row = parsed.rows.find(
      (r) => r.sourceId === current.sourceId && r.seriesId === current.seriesId && r.mediaId === id,
    );

    if (!row) return { kind: "not-saved" };

    if (row.state === "queued" || row.state === "running" || row.state === "paused")
      return { kind: "downloading", row };

    if (row.reason === "file-changed") return { kind: "changed", row };

    if (row.reason === "missing") return { kind: "missing", row };

    if (row.state !== "complete") return { kind: "not-saved", row };

    try {
      return { kind: "ready", row, path: await port.path(row.id) };
    } catch {
      const fresh = Snapshot(JSON.parse(await port.snapshot()));

      if (fresh instanceof type.errors) return { kind: "read" };
      const checked = fresh.rows.find((r) => r.id === row.id);

      return {
        kind:
          checked?.reason === "file-changed"
            ? "changed"
            : checked?.reason === "missing"
              ? "missing"
              : "read",
        row: checked ?? row,
      };
    }
  } catch {
    return { kind: "read" };
  }
}
