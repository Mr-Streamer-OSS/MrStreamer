import type { PlayIntent } from "../player/intent.ts";
import { t } from "./copy.ts";

/** Labels an explicitly chosen local copy without starting the downloads runtime. */
export function fileSourceLabel(intent: PlayIntent): string | null {
  return intent.kind === "file" ? t("Downloaded") : null;
}
