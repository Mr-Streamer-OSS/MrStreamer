import type { Json } from "@mrstreamer/contracts/json";
import { File, Paths } from "expo-file-system";

/** Only confirmed absence starts a new installation. Failed reads must never enable statistics. */
export function readAnalyticsRecord(): Json {
  for (const name of ["analytics.json", "analytics.json.next"]) {
    const file = new File(Paths.document, name);

    if (!file.exists) continue;
    const value: Json = JSON.parse(file.textSync());

    // A literal null in an existing file is corrupt state, not a missing preference.
    if (value === null) throw new Error("Analytics state unavailable.");

    return value;
  }

  return null;
}
