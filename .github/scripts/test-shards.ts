// Checks' Test job runs this on the downloaded test shard artifacts before Vitest merges their
// reports. Each shard of one candidate, named test-shard-<report-name>-<index>, holds `shard.json`
// ({ shard: "<index>/<count>", identity }) and Vitest's `blob.json`. This copies every shard's blob
// into one folder for `vitest --merge-reports` and prints the GitHub output `identity=`: the
// validation identity when every shard ran under the Test job's own (IDENTITY), empty otherwise,
// so Release won't reuse a mixed run.
//
//   IDENTITY=<this runner's identity> node .github/scripts/test-shards.ts <downloads> <report-name> <blobs>
//
// It fails, after copying what it found, unless shards 1 to <count> are each there once with a
// blob. The merged report then shows what ran; the completeness gate judges it.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The shards found under `downloads` for `reportName`, and what keeps them from being complete. */
export function collectShards(
  downloads: string,
  reportName: string,
  blobs: string,
  identity: string,
) {
  const problems: string[] = [];
  const identities = new Set<string>();
  const indexes: number[] = [];
  const counts = new Set<number>();
  const prefix = `test-shard-${reportName}-`;
  mkdirSync(blobs, { recursive: true });
  // Other candidates' shards in the same run share the download pattern; only exact names count.
  const names = existsSync(downloads)
    ? readdirSync(downloads).filter(
        (name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)),
      )
    : [];
  for (const name of names) {
    const dir = join(downloads, name);
    let shard: { shard?: unknown; identity?: unknown };
    try {
      shard = JSON.parse(readFileSync(join(dir, "shard.json"), "utf8")) ?? {};
    } catch {
      problems.push(`${name}: no readable shard.json.`);
      continue;
    }
    const spec = typeof shard.shard === "string" ? /^(\d+)\/(\d+)$/.exec(shard.shard) : null;
    const [index, count] = [Number(spec?.[1]), Number(spec?.[2])];
    if (!spec || index !== Number(name.slice(prefix.length))) {
      problems.push(`${name}: shard.json names no shard <index>/<count> matching its name.`);
      continue;
    }
    indexes.push(index);
    counts.add(count);
    identities.add(String(shard.identity ?? ""));
    const blob = join(dir, "blob.json");
    if (!existsSync(blob) || statSync(blob).size === 0) {
      problems.push(`Shard ${index}/${count}: no Vitest blob report. Did its tests run?`);
      continue;
    }
    copyFileSync(blob, join(blobs, `blob-${index}-${count}.json`));
  }
  const [count, ...otherCounts] = counts;
  if (count === undefined) problems.push(`No test shard reports named ${prefix}<index>.`);
  else if (otherCounts.length)
    problems.push(`The shards disagree on their count: ${[...counts].join(", ")}.`);
  else
    for (let index = 1; index <= count; index++) {
      const found = indexes.filter((each) => each === index).length;
      if (found !== 1) problems.push(`Shard ${index}/${count}: found ${found} times, not once.`);
    }
  const agreed =
    identities.size === 1 && identities.has(identity) && /^[a-f0-9]{64}$/.test(identity);
  return { problems, identity: agreed ? identity : "" };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [downloads, reportName, blobs] = process.argv.slice(2);
  if (!downloads || !reportName || !blobs) {
    console.error(
      "Use: IDENTITY=<identity> node .github/scripts/test-shards.ts <downloads> <report-name> <blobs>",
    );
    process.exit(1);
  }
  const { problems, identity } = collectShards(
    downloads,
    reportName,
    blobs,
    process.env["IDENTITY"] ?? "",
  );
  if (!identity)
    console.error(
      "::warning::The test shards ran under different validation identities; Release won't reuse this run.",
    );
  console.log(`identity=${identity}`);
  if (problems.length) {
    console.error(
      `The test shards are incomplete:\n${problems.map((line) => `- ${line}`).join("\n")}`,
    );
    process.exitCode = 1;
  }
}
