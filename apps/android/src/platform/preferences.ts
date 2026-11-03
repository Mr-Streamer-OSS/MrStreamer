import { readJsonStrict, writeJson } from "./storage.ts";

export interface PreferenceFiles {
  read(name: string): unknown;
  write(name: string, value: unknown): void;
}

/** A write only succeeds when an independent read finds exactly what was requested. */
export function preferences(files: PreferenceFiles = { read: readJsonStrict, write: writeJson }) {
  return {
    read: files.read,
    write(name: string, value: unknown): boolean {
      try {
        files.write(name, value);
      } catch {
        /* A completed replacement may still have held. */
      }

      try {
        return JSON.stringify(files.read(name)) === JSON.stringify(value);
      } catch {
        return false;
      }
    },
    language(): string | undefined {
      const value = files.read("language.json");

      if (value === null) return undefined;

      if (typeof value !== "object" || !("choice" in value) || typeof value.choice !== "string")
        throw new Error("Language preference unavailable.");

      return value.choice;
    },
  };
}
