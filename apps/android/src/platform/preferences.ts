import { lazy } from "@mrstreamer/contracts/lazy";
import { type } from "arktype";
import type { Json } from "@mrstreamer/contracts/json";
import { readJsonStrict, writeJson } from "./storage.ts";

const LanguagePreference = lazy(() => type({ choice: "string" }));

export interface PreferenceFiles {
  read(name: string): Json;
  write(name: string, value: Parameters<typeof writeJson>[1]): void;
}

/** A write only succeeds when an independent read finds exactly what was requested. */
export function preferences(files: PreferenceFiles = { read: readJsonStrict, write: writeJson }) {
  return {
    read: files.read,
    write(name: string, value: Parameters<typeof writeJson>[1]): boolean {
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

      if (!LanguagePreference().allows(value)) throw new Error("Language preference unavailable.");

      return value.choice;
    },
  };
}
