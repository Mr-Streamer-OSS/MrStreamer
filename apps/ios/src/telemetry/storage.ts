import type { Json } from "@mrstreamer/contracts/json";
import { File, Paths } from "expo-file-system";

/** Only confirmed absence starts a new installation. Failed reads must never enable statistics. */
export function readAnalyticsRecord(): Json {
  // Listing throws when the directory cannot be read; File.exists can silently report false
  // when a file is inaccessible, which is not evidence of a new installation.
  const names = new Set(Paths.document.list().map((entry) => entry.name));

  for (const name of ["analytics.json", "analytics.json.next"]) {
    if (!names.has(name)) continue;
    const file = new File(Paths.document, name);
    const value: Json = JSON.parse(file.textSync());

    // A literal null in an existing file is corrupt state, not a missing preference.
    if (value === null) throw new Error("Analytics state unavailable.");

    return value;
  }

  return null;
}
