import { File, Paths } from "expo-file-system";
import { sources } from "../bootstrap/sources.ts";
import { readJson, writeJson } from "../platform/storage.ts";
import { listsOwner } from "./store.ts";

export const lists = listsOwner(
  {
    readJson(name) {
      const value = readJson(name);

      // The storage helper returns null for both absent and unreadable files. Only absence
      // starts an empty list; a damaged existing file must remain retryable, never overwritten.
      if (
        value === null &&
        [name, `${name}.next`].some((path) => new File(Paths.document, path).exists)
      ) {
        throw new Error("read");
      }

      return value;
    },
    writeJson,
  },
  sources.state.get,
);

lists.read();
