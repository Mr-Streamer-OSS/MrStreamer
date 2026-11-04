// TMDB's metadata for the catalogue, in the catalogue worker, kept in metadata.json.gz. The store
// itself is core's, shared with iOS; this names its file.
import {
  metadataStore as sharedStore,
  MetadataFile,
  type MetadataDeps as SharedDeps,
} from "@mrstreamer/core/metadata/store";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

export type { MetadataStatus, Wanted } from "@mrstreamer/core/metadata/store";

export interface MetadataDeps extends Omit<SharedDeps, "read" | "write"> {
  readonly path: string;
}

export function metadataStore({ path, ...deps }: MetadataDeps) {
  return sharedStore({
    ...deps,
    read: () => readJsonFile(path, MetadataFile()),
    write: (file) => writeJsonFile(path, file),
  });
}
