import type { Store } from "../platform/store.ts";
import type { DownloadRow } from "./state.ts";

// Replace on a copy whose file is missing or changed, from its Downloads row or its Library
// episode. A missing file is replaced at once, since there is nothing to delete; a changed one asks
// first, because replacing deletes it. A copy that is playing is never replaced.

/** What the prompt over the screen says, if anything. */
export type ReplacePrompt =
  | { readonly kind: "confirm"; readonly row: DownloadRow }
  | { readonly kind: "refused"; readonly row: DownloadRow; readonly reason: "playing" | "closing" }
  | { readonly kind: "failed"; readonly row: DownloadRow };

export interface ReplaceOwner {
  readonly prompt: Store<ReplacePrompt | null>;
  /** Native's answer, or why it didn't ask: the copy is playing or still closing. */
  replace(row: DownloadRow): Promise<string>;
}

/** Replace from a row: at once for a missing file, after the prompt for a changed one. */
export function askReplace(owner: ReplaceOwner, row: DownloadRow) {
  if (row.reason === "file-changed") owner.prompt.set({ kind: "confirm", row });
  else replaceNow(owner, row);
}

export function replaceNow(owner: ReplaceOwner, row: DownloadRow) {
  owner
    .replace(row)
    .then((reason) => {
      if (reason === "playing" || reason === "closing")
        owner.prompt.set({ kind: "refused", row, reason });
    })
    .catch(() => owner.prompt.set({ kind: "failed", row }));
}

/** "Estuary Line S1 E2" and "S1 E2"; a movie is its title for both. */
export function named(row: DownloadRow) {
  const code =
    row.season !== undefined && row.episode !== undefined ? `S${row.season} E${row.episode}` : null;

  return { name: code ? `${row.title} ${code}` : row.title, episode: code ?? row.title };
}
