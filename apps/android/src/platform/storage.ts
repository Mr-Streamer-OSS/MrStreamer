import { File, Paths } from "expo-file-system";

// Whole JSON files in the app's private files folder, which Android deletes with the app and,
// with backups off (app.json), never restores elsewhere. A write goes to a file beside it first,
// then takes its place, so a write cut short by the app being killed leaves the last whole file,
// which a read takes; the file under the temporary name is read only when that one is missing or
// not JSON. Secrets never go here: see credentials.ts.

const fileOf = (name: string) => new File(Paths.document, name);
const pendingOf = (name: string) => new File(Paths.document, `${name}.next`);

/** The file's contents, or null when there is none or it doesn't read as JSON. */
export function readJson(name: string): unknown {
  for (const file of [fileOf(name), pendingOf(name)]) {
    if (!file.exists) continue;

    try {
      return JSON.parse(file.textSync()) as unknown;
    } catch {
      // Unreadable or not JSON: try the other, then start again.
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
