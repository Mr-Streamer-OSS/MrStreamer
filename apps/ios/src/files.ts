import { File, Paths } from "expo-file-system";

// Whole JSON files in the app's Documents folder, which iOS deletes with the app. A write goes to
// a file beside it first, then takes its place, so a write cut short by the app being killed
// leaves the last whole file; one cut short before the move finishes leaves the new file there
// under the temporary name, which a read takes instead.

const fileOf = (name: string) => new File(Paths.document, name);
const pendingOf = (name: string) => new File(Paths.document, `${name}.next`);

/** The file's contents, or null when there is none or it doesn't read as JSON. */
export function readJson(name: string): unknown {
  return read(name, false);
}

/**
 * As `readJson`, but throws when a file there can't be read now, rather than answering none: for
 * a caller that mustn't write over what it couldn't read. Text that isn't JSON still reads as none.
 */
export function readJsonStrictly(name: string): unknown {
  return read(name, true);
}

function read(name: string, strict: boolean): unknown {
  for (const file of [fileOf(name), pendingOf(name)]) {
    if (!file.exists) continue;
    let text: string;
    try {
      text = file.textSync();
    } catch (cause) {
      if (strict) throw cause;
      continue;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not JSON: try the other, then start again.
    }
  }
  return null;
}

/** Replaces the file with `value`, whole. Throws when the folder won't take it. */
export function writeJson(name: string, value: unknown): void {
  const pending = pendingOf(name);
  if (!pending.exists) pending.create();
  pending.writeSync(JSON.stringify(value));
  pending.moveSync(fileOf(name), { overwrite: true });
}

/** Removes the file, and any write of it left halfway. */
export function removeJson(name: string): void {
  for (const file of [fileOf(name), pendingOf(name)]) {
    if (file.exists) file.delete();
  }
}
