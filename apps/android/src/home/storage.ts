import { File, Paths } from "expo-file-system";

/** A pending replacement was never committed. Only the final file can restore viewing state. */
export function readViewing(name: string): unknown {
  const file = new File(Paths.document, name);

  return file.exists ? JSON.parse(file.textSync()) : null;
}
