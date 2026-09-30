// Keeps the programme guide on disk: the XMLTV document as it arrived (guide.xml) and which
// subscription and time it belongs to (guide.json). A download goes to a temporary file first and
// replaces the saved document only when complete.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { GuideFailed, GuideStore } from "@mrstreamer/core/guide/service";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readJsonFile, removeFile, writeJsonFile } from "./json-file.ts";

const GuideMeta = type({ key: "string", fetchedAt: "number" });

/** The guide store in `dataDir`. */
export function guideStoreLayer(dataDir: string): Layer.Layer<GuideStore> {
  const documentPath = join(dataDir, "guide.xml");
  const metaPath = join(dataDir, "guide.json");
  return Layer.succeed(GuideStore, {
    read: (key) =>
      Effect.promise(async () => {
        const meta = await readJsonFile(metaPath, GuideMeta);
        if (meta?.key !== key) return null;
        const document = createReadStream(documentPath, { highWaterMark: 64 * 1024 });
        return { fetchedAt: meta.fetchedAt, document };
      }),
    save: (key, fetchedAt) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dataDir, { recursive: true });
          const partial = `${documentPath}.${randomUUID()}.tmp`;
          const file = await open(partial, "w");
          return {
            write: async (bytes: Uint8Array) => {
              await file.write(bytes);
            },
            commit: async () => {
              await file.close();
              await rename(partial, documentPath);
              await writeJsonFile(metaPath, { key, fetchedAt });
            },
            discard: async () => {
              await file.close().catch(() => {});
              await rm(partial, { force: true });
            },
          };
        },
        catch: (cause) => new GuideFailed({ error: { kind: "unexpected", detail: String(cause) } }),
      }),
    clear: Effect.promise(async () => {
      await Promise.all([removeFile(documentPath), removeFile(metaPath)]);
    }),
  });
}
