// Keeps each subscription's programme guide on disk, in its folder.
//
// Its own guide, the provider's or the one its playlist names, is kept as every release keeps
// it: the XMLTV document as it arrived (guide.xml) and which account and time it belongs to
// (guide.json). A download goes to a temporary file first and replaces the saved document only
// when complete.
//
// What the viewer set for the guide is kept beside them in guide-source.json: an XMLTV address
// of the viewer's own, sealed, with the document it was last downloaded as, and the channels
// mapped by hand. Each download of such an address is a file of its own,
// guide-external.<id>.xml, and counts only once guide-source.json names it. So one write, of
// that small file, switches the guide, a download or its address: cut short, it leaves the one
// before whole, and a document nothing names is swept away. Releases from before these files
// read neither: they show the own guide from guide.xml, which never holds another guide's
// programmes.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { GuideStore, type GuideConfig } from "@mrstreamer/core/guide/service";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readJsonFile, removeFile, writeJsonFile } from "./json-file.ts";

const GuideMeta = type({ key: "string", fetchedAt: "number" });

/** What an external guide's documents are named: nothing else is read or removed as one. */
const DOCUMENT =
  /^guide-external\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xml$/;

/** Why a guide's download failed, of the kinds a download ends with. */
const DownloadError = type({ kind: "'unreachable'", server: "string", detail: "string" })
  .or({ kind: "'provider-error'", status: "number" })
  .or({ kind: "'unexpected'", detail: "string" })
  .or({
    kind: "'guide'",
    failure: type({ kind: "'not-xmltv' | 'incomplete' | 'empty' | 'ended'" })
      .or({ kind: "'redirect'", reason: "'unencrypted' | 'too-many'" })
      .or({ kind: "'too-large'", limit: "'bytes' | 'element' | 'channels' | 'programmes'" }),
  });
const DownloadFailure = type({ at: "number", error: DownloadError });

// guide-source.json. A later release adds fields rather than another version, as for the other
// files: this one keeps a sealed address, which a file it can't read would lose.
const GuideSourceFile = type({
  version: "1",
  /** Which account this was set for. */
  key: "string",
  external: type({
    origin: "string",
    identity: "string",
    sealedAddress: "string",
    since: "number",
    document: { file: DOCUMENT, fetchedAt: "number" },
    /** Read on its own: one this release can't read costs the address nothing. */
    "failure?": "unknown",
  }).or("null"),
  mappings: { "[string]": { guideId: "string", name: "string" } },
});

const sourcePath = (store: string) => join(store, "guide-source.json");

/**
 * Writes `text` to `path` whole or not at all, in a folder that is there: unlike `writeJsonFile`
 * it makes none, so nothing is written for a subscription whose folder went with it.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}

/** The external guides' documents in a folder, by name. */
async function documentsIn(store: string): Promise<string[]> {
  const names = await readdir(store).catch(() => []);
  return names.filter((name) => DOCUMENT.test(name));
}

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
  config: ({ store, key }) =>
    Effect.promise(async (): Promise<GuideConfig | null> => {
      const file = await readJsonFile(sourcePath(store), GuideSourceFile);
      // Another account's, as after an older release connected one in this folder.
      if (file?.key !== key) return null;
      const { external, mappings } = file;
      if (!external) return { external: null, mappings };
      const failure = DownloadFailure(external.failure);
      return {
        external: { ...external, failure: failure instanceof type.errors ? null : failure },
        mappings,
      };
    }),
  setConfig: ({ store, key }, config) =>
    Effect.tryPromise({
      try: async () => {
        const nothing = config.external === null && Object.keys(config.mappings).length === 0;
        if (nothing) return removeFile(sourcePath(store));
        const file: typeof GuideSourceFile.infer = { version: 1, key, ...config };
        await replaceFile(sourcePath(store), JSON.stringify(file));
      },
      catch: failedWith,
    }),
  draft: ({ store }) =>
    Effect.tryPromise({
      try: async () => {
        const name = `guide-external.${randomUUID()}.xml`;
        const path = join(store, name);
        // Fails where the folder went: nothing is kept for a subscription that did.
        const file = await open(path, "wx");
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          await file.close();
        };
        return {
          file: name,
          write: async (bytes: Uint8Array) => {
            await file.write(bytes);
          },
          close,
          discard: async () => {
            await close().catch(() => {});
            await rm(path, { force: true });
          },
        };
      },
      catch: failedWith,
    }),
  document: ({ store }, file) => createReadStream(join(store, file), { highWaterMark: 64 * 1024 }),
  discard: ({ store }, file) => Effect.promise(() => removeFile(join(store, file))),
  sweep: ({ store }, keep) =>
    Effect.promise(async () => {
      const others = (await documentsIn(store)).filter((name) => name !== keep);
      await Promise.all(others.map((name) => removeFile(join(store, name))));
    }),
  erase: ({ store }) =>
    Effect.promise(async () => {
      await Promise.all(
        ["guide.xml", "guide.json", "guide-source.json", ...(await documentsIn(store))].map(
          (name) => removeFile(join(store, name)),
        ),
      );
    }),
});
