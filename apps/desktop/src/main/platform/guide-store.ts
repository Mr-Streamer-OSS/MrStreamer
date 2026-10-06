// Keeps each subscription's programme guide on disk, in its folder: the XMLTV document as it
// arrived (guide.xml) and which account and time it belongs to (guide.json). A download goes to a
// temporary file first and replaces the saved document only when complete.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Failed } from "@mrstreamer/core/failure";
import { GuideStore } from "@mrstreamer/core/guide/service";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readJsonFile, removeFile, writeJsonFile } from "./json-file.ts";

const GuideMeta = type({ key: "string", fetchedAt: "number" });

/** The guide store: a subscription's `store` is the folder its guide is kept in. */
export const guideStoreLayer: Layer.Layer<GuideStore> = Layer.succeed(GuideStore, {
  read: ({ store, key }) =>
    Effect.promise(async () => {
      const meta = await readJsonFile(join(store, "guide.json"), GuideMeta);
      if (meta?.key !== key) return null;
      const document = createReadStream(join(store, "guide.xml"), { highWaterMark: 64 * 1024 });
      return { fetchedAt: meta.fetchedAt, document };
    }),
  save: ({ store, key }, fetchedAt) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(store, { recursive: true });
        const documentPath = join(store, "guide.xml");
        const partial = `${documentPath}.${randomUUID()}.tmp`;
        const file = await open(partial, "w");
        return {
          write: async (bytes: Uint8Array) => {
            await file.write(bytes);
          },
          commit: async () => {
            await file.close();
            await rename(partial, documentPath);
            await writeJsonFile(join(store, "guide.json"), { key, fetchedAt });
          },
          discard: async () => {
            await file.close().catch(() => {});
            await rm(partial, { force: true });
          },
        };
      },
      catch: (cause) => new Failed({ error: { kind: "unexpected", detail: String(cause) } }),
    }),
  clear: ({ store }) =>
    Effect.promise(async () => {
      await Promise.all([
        removeFile(join(store, "guide.xml")),
        removeFile(join(store, "guide.json")),
      ]);
    }),
});
