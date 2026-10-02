// Measures the programme guide against the slice 03 budgets: download and index under 3 s, no
// main-process stall over 50 ms, now and next for a screen of channels under 5 ms, and under 80 MB
// of memory. Uses a generated guide the size of a large subscription, or a real XMLTV file.
//
//   node --expose-gc scripts/measure-guide.ts [--file guide.xml]
//
// The file stays local: provider guides are not committed.
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { GuideChannels } from "@mrstreamer/core/guide/programmes";
import { Guide, GuideCatalogue, GuideSource } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";

const CHANNELS = 13_000;
const GUIDE_CHANNELS = 1_300;
const PROGRAMMES_PER_CHANNEL = 70;
const CHUNK_BYTES = 64 * 1024;

const { values } = parseArgs({ options: { file: { type: "string" } } });
const now = Date.now();
const dataDir = await mkdtemp(join(tmpdir(), "mr-streamer-guide-"));
// The document streams from a file, as it would from the network, so it never sits in the heap.
const documentPath = values.file ?? join(dataDir, "generated.xml");
if (!values.file) await writeFile(documentPath, generated());
const guideIds = await guideChannelIds(documentPath);

// Catalogue channels: some share a guide channel, most have none, as on real subscriptions.
const channels: LiveChannel[] = Array.from({ length: CHANNELS }, (_, index) => ({
  id: String(index),
  name: `Channel ${index}`,
  title: `Channel ${index}`,
  tags: [],
  number: index + 1,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id: String(index), name: `Channel ${index}`, tags: [], quality: null }],
}));
const guideIdOf = new Map<string, string>();
const byGuideId = new Map<string, LiveChannel[]>();
for (const [index, channel] of channels.entries()) {
  const guideId = index % 6 === 0 ? guideIds[(index / 6) % guideIds.length] : undefined;
  if (!guideId) continue;
  guideIdOf.set(channel.id, guideId);
  byGuideId.set(guideId, [...(byGuideId.get(guideId) ?? []), channel]);
}
const guideChannels: GuideChannels = {
  guideIdOf: (id) => guideIdOf.get(id) ?? null,
  channelsOf: (id) => byGuideId.get(id) ?? [],
};

/** The guide service as the app runs it, with a subscription that downloads the document. */
async function create() {
  const runtime = ManagedRuntime.make(
    Guide.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(GuideSource, {
            current: Effect.succeed({
              key: "measure",
              download: async () =>
                Readable.toWeb(
                  createReadStream(documentPath, { highWaterMark: CHUNK_BYTES }),
                ) as ReadableStream<Uint8Array>,
            }),
          }),
          Layer.succeed(GuideCatalogue, { channels: Effect.succeed(guideChannels) }),
          guideStoreLayer(dataDir),
        ),
      ),
    ),
  );
  const guide = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Guide;
    }),
  );
  return {
    refresh: () => runtime.runPromise(guide.refresh),
    listings: (ids: readonly string[]) => runtime.runPromise(guide.listings(ids)),
    search: (query: string) => runtime.runPromise(guide.search(query)),
    dispose: () => runtime.dispose(),
  };
}

const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const stalls = monitorEventLoopDelay({ resolution: 5 });

stalls.enable();
let started = performance.now();
const guide = await create();
await guide.refresh();
const downloadMs = performance.now() - started;
stalls.disable();
const downloadStall = stalls.max / 1e6;

gc?.();
const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;

stalls.reset();
stalls.enable();
started = performance.now();
const restarted = await create();
await restarted.listings(["0"]);
const diskMs = performance.now() - started;
stalls.disable();
const diskStall = stalls.max / 1e6;

const screen = channels.slice(0, 60).map((channel) => channel.id);
started = performance.now();
for (let round = 0; round < 100; round++) await restarted.listings(screen);
const listingsMs = (performance.now() - started) / 100;

started = performance.now();
const matches = await restarted.search("news");
const searchMs = performance.now() - started;

const size = ((await stat(documentPath)).size / 1e6).toFixed(1);
const row = (label: string, value: string, budget: string) =>
  console.log(`${label.padEnd(34)} ${value.padStart(10)}   ${budget}`);
console.log(`${values.file ?? "generated"}: ${size} MB, ${guideIds.length} guide channels`);
row("download and index", `${downloadMs.toFixed(0)} ms`, "under 3000 ms");
row("longest stall while downloading", `${downloadStall.toFixed(1)} ms`, "under 50 ms");
row("read from disk after a restart", `${diskMs.toFixed(0)} ms`, "");
row("longest stall while reading", `${diskStall.toFixed(1)} ms`, "under 50 ms");
row("now and next for 60 channels", `${listingsMs.toFixed(2)} ms`, "under 5 ms");
row(`search "news" (${matches.length} results)`, `${searchMs.toFixed(1)} ms`, "");
row(
  "memory held by the guide",
  gc ? `${heapMb.toFixed(0)} MB` : "run with --expose-gc",
  "under 80 MB",
);
await Promise.all([guide.dispose(), restarted.dispose()]);
await rm(dataDir, { recursive: true, force: true });

/** The guide channels a document lists programmes for. */
async function guideChannelIds(path: string): Promise<string[]> {
  const ids = new Set<string>();
  let tail = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = tail + String(chunk);
    for (const match of text.matchAll(/<programme[^>]*channel="([^"]+)"/g)) ids.add(match[1] ?? "");
    tail = text.slice(-200);
  }
  return [...ids];
}

/** A guide shaped like a large panel's: two days of programmes for each guide channel. */
function generated(): string {
  const words = ["News", "Match", "Journal", "Kitchen", "Crime", "Nature", "Quiz", "Talk", "Film"];
  const first = now - 24 * 60 * 60 * 1000;
  const slot = (48 * 60 * 60 * 1000) / PROGRAMMES_PER_CHANNEL;
  const parts = ['<?xml version="1.0" encoding="utf-8"?><tv>'];
  for (let channel = 0; channel < GUIDE_CHANNELS; channel++) {
    for (let index = 0; index < PROGRAMMES_PER_CHANNEL; index++) {
      const start = first + index * slot;
      const title = `${words[(channel + index) % words.length]} ${channel % 97} ${index}`;
      const description = `Episode ${index}. ${"A description of a length panels often send. ".repeat(5)}`;
      parts.push(
        `<programme start="${time(start)}" stop="${time(start + slot)}" channel="c${channel}.test">` +
          `<title lang="en">${title}</title><desc lang="en">${description}</desc></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}

function time(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
}
