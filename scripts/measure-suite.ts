// Complete default-suite wall time, including pnpm startup and global setup. Retain every
// attempted run, validate CI completeness, and stop at the first failure without replacing it.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, loadavg, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { globSync } from "tinyglobby";
import { include, exclude } from "../test/suites.ts";
import { median, positiveCount } from "../apps/desktop/scripts/measurement.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    runs: { type: "string", default: "5" },
    conditions: { type: "string" },
  },
});
if (!values.output || !values.conditions)
  throw new Error(
    "Usage: node scripts/measure-suite.ts --output <new-directory> --conditions <cache/host description> [--runs 5]",
  );
const runs = positiveCount(values.runs, "runs", 20);
const output = resolve(values.output);
// Refuse reuse: failures and previous campaigns must never be silently overwritten.
mkdirSync(output, { recursive: false });
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hashed = (paths: string[]) =>
  paths.map((path) => ({ path, sha256: sha256(readFileSync(path)) }));
const identity = () => ({
  revision: git("rev-parse", "HEAD"),
  trackedDiffSha256: sha256(git("diff", "HEAD")),
  untracked: hashed(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
  ),
  files: hashed(globSync(include, { dot: true, ignore: exclude, expandDirectories: false }).sort()),
  policy: hashed(["package.json", "pnpm-lock.yaml", "vitest.config.ts", "test/suites.ts"]),
});
const before = identity();
writeFileSync(
  join(output, "environment.json"),
  JSON.stringify(
    {
      ...before,
      recordedAt: new Date().toISOString(),
      conditions: values.conditions,
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      availableParallelism: availableParallelism(),
      logicalCpus: cpus().length,
      // Only runner-related overrides, never arbitrary ambient environment or secrets.
      runnerOverrides: Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          [
            "VITEST_MAX_WORKERS",
            "VITEST_POOL_ID",
            "NODE_OPTIONS",
            "NODE_COMPILE_CACHE",
            "CI",
          ].includes(name),
        ),
      ),
    },
    null,
    2,
  ),
);
const samples: number[] = [];
for (let index = 1; index <= runs; index++) {
  const policy = join(output, `run-${index}.policy.json`);
  const report = join(output, `run-${index}.vitest.json`);
  const args = [
    "test",
    "--reporter=default",
    "--reporter=json",
    "--reporter=./scripts/suite-measurement-reporter.ts",
    `--outputFile.json=${report}`,
  ];
  const log = openSync(join(output, `run-${index}.log`), "wx");
  const startedAt = new Date().toISOString();
  const loadBefore = loadavg();
  const started = performance.now();
  const result = spawnSync("pnpm", args, {
    env: { ...process.env, MR_STREAMER_SUITE_POLICY: policy },
    stdio: ["ignore", log, log],
  });
  const wallMs = performance.now() - started;
  const validation = spawnSync(process.execPath, ["scripts/ci-test-results.ts", report], {
    encoding: "utf8",
  });
  const unchanged = JSON.stringify(before) === JSON.stringify(identity());
  const complete = result.status === 0 && validation.status === 0 && unchanged;
  writeFileSync(
    join(output, `run-${index}.json`),
    JSON.stringify(
      {
        startedAt,
        command: ["pnpm", ...args],
        wallMs,
        loadBefore,
        loadAfter: loadavg(),
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message,
        validation: {
          exitCode: validation.status,
          error: validation.error?.message,
          signal: validation.signal,
          stdout: validation.stdout,
          stderr: validation.stderr,
        },
        unchanged,
        complete,
      },
      null,
      2,
    ),
  );
  closeSync(log);
  console.log(
    `Run ${index}: ${complete ? "complete" : "FAILED"}, ${wallMs.toFixed(0)} ms; ${output}`,
  );
  if (!complete) break;
  samples.push(wallMs);
}
const complete = samples.length === runs;
writeFileSync(
  join(output, "summary.json"),
  JSON.stringify(
    {
      complete,
      requestedRuns: runs,
      successfulRuns: samples.length,
      wallMs: samples,
      medianWallMs: complete ? median(samples) : null,
      eligibleForFiveRunBaseline: complete && runs >= 5,
      note: "Reporting adds overhead. Match this command, hardware, runner policy and cache conditions for candidate runs. No app/native performance or footprint acceptance follows from suite timing.",
    },
    null,
    2,
  ),
);
if (!complete) process.exitCode = 1;
