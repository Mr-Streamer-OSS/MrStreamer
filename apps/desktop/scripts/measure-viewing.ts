// Measures the viewing record with a long history: how long a change takes to commit, how long a
// start takes to open the database, and how long rebuilding the lists from every event takes, as
// after a change to the rules. Uses a temporary database the size of years of heavy use.
//
//   node scripts/measure-viewing.ts [--events 100000]
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { LegacyViewing, ViewingAccount, ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";

const CHANNELS = 13_000;
/** About this many favourites at a time. */
const FAVOURITES = 50;
const SAMPLES = 1_000;

const { values } = parseArgs({ options: { events: { type: "string", default: "100000" } } });
const events = Number(values.events);
const dataDir = await mkdtemp(join(tmpdir(), "mr-streamer-viewing-"));
const database = join(dataDir, "mrstreamer.db");

/** The viewing record as the app runs it, for one account. Resolves once the database is open. */
async function start() {
  const runtime = ManagedRuntime.make(
    ViewingRecord.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ViewingAccount, { current: Effect.succeed("measure") }),
          Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
          viewingStoreLayer(dataDir),
        ),
      ),
    ),
  );
  const viewing = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ViewingRecord;
    }),
  );
  return { runtime, viewing };
}

/** Median and 99th percentile of `samples`, in milliseconds. */
function spread(samples: number[]): string {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return `median ${at(0.5).toFixed(2)} ms, p99 ${at(0.99).toFixed(2)} ms`;
}

try {
  // Mostly watches across the catalogue, with favourites changed now and then among a few.
  let { runtime, viewing } = await start();
  const pick = (count: number) => String(Math.floor(Math.random() * count));
  for (let index = 0; index < events; index++) {
    const command =
      index % 20 === 0
        ? viewing.setFavourite(`fill-${index}`, pick(FAVOURITES * 2), Math.random() < 0.5)
        : viewing.recordWatch(`fill-${index}`, pick(CHANNELS));
    await runtime.runPromise(command);
  }

  const watch: number[] = [];
  const favourite: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const channelId = String(index);
    let started = performance.now();
    await runtime.runPromise(viewing.recordWatch(`watch-${index}`, channelId));
    watch.push(performance.now() - started);
    started = performance.now();
    await runtime.runPromise(
      viewing.setFavourite(`star-${index}`, pick(FAVOURITES * 2), index % 2 === 0),
    );
    favourite.push(performance.now() - started);
  }
  const state = await runtime.runPromise(viewing.state);
  await runtime.dispose();

  let started = performance.now();
  ({ runtime } = await start());
  const open = performance.now() - started;
  await runtime.dispose();

  // What a change to the rules does: the stored lists no longer count.
  const db = new DatabaseSync(database);
  db.exec("delete from meta where key = 'state-version'");
  db.close();
  started = performance.now();
  ({ runtime, viewing } = await start());
  const rebuild = performance.now() - started;
  const rebuilt = await runtime.runPromise(viewing.state);
  await runtime.dispose();

  const size =
    (await stat(database)).size + (await stat(`${database}-wal`).catch(() => ({ size: 0 }))).size;
  console.log(`events: ${state.sequence.toLocaleString("en")}`);
  console.log(`watch: ${spread(watch)}`);
  console.log(`favourite: ${spread(favourite)}`);
  console.log(`start: ${open.toFixed(1)} ms`);
  console.log(`start with rebuild: ${rebuild.toFixed(1)} ms`);
  console.log(`rebuilt lists match: ${JSON.stringify(rebuilt) === JSON.stringify(state)}`);
  console.log(`database: ${(size / 1024 / 1024).toFixed(1)} MB`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
