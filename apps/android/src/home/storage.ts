import { File, Paths } from "expo-file-system";

/** A pending replacement was never committed. Only the final file can restore viewing state. */
export function readViewing(name: string): unknown {
  const file = new File(Paths.document, name);

  if (file.exists) return JSON.parse(file.textSync());
  const pending = new File(Paths.document, `${name}.next`);

  if (pending.exists) {
    const text = pending.textSync();

    try {
      JSON.parse(text);
    } catch {
      return null;
    }

    throw new Error("viewing-read");
  }

  return null;
}
