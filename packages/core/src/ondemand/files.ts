import { createHash } from "node:crypto";

/** The listed file's identity, without its address. A changed row makes old track facts stale. */
export function listedFileKey(
  kind: "movie" | "episode",
  file: { readonly id: string; readonly name: string; readonly container: string | null },
): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, file.id, file.name, file.container]))
    .digest("hex");
}
