import { File, Paths } from "expo-file-system";

export { writeJson } from "../platform/storage.ts";

/** An unreadable or damaged file must not be replaced with an empty guide registry. */
export function readJsonStrictly(name: string): unknown {
  const file = new File(Paths.document, name);

  if (!file.exists) return null;

  return JSON.parse(file.textSync()) as unknown;
}
