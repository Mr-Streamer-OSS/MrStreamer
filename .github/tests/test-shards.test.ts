import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectShards } from "../scripts/test-shards.ts";

// Checks' Test job collects the downloaded shard artifacts, named for report "run" here, before
// Vitest merges their blobs.

const identity = "a".repeat(64);

interface Shard {
  readonly name?: string;
  readonly shard?: string;
  readonly identity?: string;
  readonly blob?: boolean;
}

const three = (patch: (shard: Shard, index: number) => Shard = (shard) => shard) =>
  [1, 2, 3].map((index) => patch({ shard: `${index}/3` }, index));

/** Writes artifacts for `shards` into a fresh folder, hands it to `use`, then removes it. */
function withShards<T>(shards: readonly Shard[], use: (downloads: string, blobs: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "mrstreamer-test-shards-"));
  try {
    shards.forEach((shard, position) => {
      const index = shard.shard?.split("/")[0] ?? String(position + 1);
      const dir = join(root, "downloads", shard.name ?? `test-shard-run-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "shard.json"),
        JSON.stringify({ shard: shard.shard, identity: shard.identity ?? identity }),
      );
      if (shard.blob !== false) writeFileSync(join(dir, "blob.json"), `blob ${index}`);
    });
    return use(join(root, "downloads"), join(root, "blobs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const collect = (shards: readonly Shard[]) =>
  withShards(shards, (downloads, blobs) => ({
    ...collectShards(downloads, "run", blobs, identity),
    blobs: readdirSync(blobs).sort(),
  }));

test("the CLI prints the identity output and exits failed on incomplete shards", () => {
  const cli = resolve(import.meta.dirname, "../scripts/test-shards.ts");
  const run = (shards: readonly Shard[]) =>
    withShards(shards, (downloads, blobs) =>
      spawnSync(process.execPath, [cli, downloads, "run", blobs], {
        encoding: "utf8",
        env: { ...process.env, IDENTITY: identity },
      }),
    );
  const complete = run(three());
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stdout, `identity=${identity}\n`);
  const missing = run(three().slice(1));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Shard 1\/3: found 0 times/);
});

test("every shard once, under the job's identity, keeps the identity and every blob", () => {
  assert.deepEqual(collect(three()), {
    problems: [],
    identity,
    blobs: ["blob-1-3.json", "blob-2-3.json", "blob-3-3.json"],
  });
});

test("a missing shard or blob is a problem, and the blobs found are still copied", () => {
  const missing = collect(three().slice(0, 2));
  assert.deepEqual(missing.problems, ["Shard 3/3: found 0 times, not once."]);
  assert.deepEqual(missing.blobs, ["blob-1-3.json", "blob-2-3.json"]);

  const noBlob = collect(
    three((shard, index) => (index === 2 ? { ...shard, blob: false } : shard)),
  );
  assert.deepEqual(noBlob.problems, ["Shard 2/3: no Vitest blob report. Did its tests run?"]);
});

test("no shards, disagreeing counts or a mislabelled shard are problems", () => {
  assert.deepEqual(collect([]).problems, ["No test shard reports named test-shard-run-<index>."]);
  assert.match(
    collect([{ shard: "1/2" }, { shard: "2/3" }, { shard: "3/3" }]).problems.join("\n"),
    /disagree on their count/,
  );
  const mislabelled = collect([...three().slice(0, 2), { name: "test-shard-run-3", shard: "2/3" }]);
  assert.deepEqual(mislabelled.problems, [
    "test-shard-run-3: shard.json names no shard <index>/<count> matching its name.",
    "Shard 3/3: found 0 times, not once.",
  ]);
});

test("other candidates' shards in the same run are left out", () => {
  const result = collect([...three(), { name: "test-shard-run-nightly-1", shard: "1/3" }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.blobs.length, 3);
});

test("a shard under another identity is complete but withholds the identity from reuse", () => {
  const result = collect(
    three((shard, index) => (index === 3 ? { ...shard, identity: "b".repeat(64) } : shard)),
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.identity, "");
});
