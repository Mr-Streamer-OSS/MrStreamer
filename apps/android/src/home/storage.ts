import type { Json } from "@mrstreamer/contracts/json";
import { File, Paths } from "expo-file-system";

/** Prefer the committed file; recover a pending first replacement without silently resetting bad data. */
export function readViewing(name: string): Json {
  const file = new File(Paths.document, name);

  if (file.exists) return JSON.parse(file.textSync());
  const pending = new File(Paths.document, `${name}.next`);

  return pending.exists ? JSON.parse(pending.textSync()) : null;
}
