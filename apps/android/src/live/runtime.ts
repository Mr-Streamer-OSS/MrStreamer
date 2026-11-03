import { File, Paths } from "expo-file-system";
import { sources } from "../bootstrap/sources.ts";
import { readJson, writeJson } from "../platform/storage.ts";
import { listsOwner } from "./store.ts";

export const lists = listsOwner(
  {
    readJson(name) {
      const value = readJson(name);

      // A damaged main file must remain retryable. An unfinished first write has no
      // main file and only empty or malformed pending JSON, so it can start again.
      if (value !== null) return value;

      if (new File(Paths.document, name).exists) throw new Error("read");
      const pending = new File(Paths.document, `${name}.next`);

      if (pending.exists) {
        const text = pending.textSync(); // A failed filesystem read remains a failure.

        try {
          JSON.parse(text);
        } catch {
          return null;
        }

        throw new Error("read");
      }

      return value;
    },
    writeJson,
  },
  sources.state.get,
);

lists.read();
