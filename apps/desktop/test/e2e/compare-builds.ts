// Measures two builds on one machine and reports how the second compares with the first. Starts
// each once to warm the machine and its disk cache, then runs measure-app.ts on each in turn,
// swapping the order every round, so a machine that slows down or speeds up during the runs affects
// both alike. Shared CI runners vary too much for absolute numbers; the difference between builds
// measured together is what they can tell.
//
//   node test/e2e/compare-builds.ts [--rounds 3] <baseline executable> <candidate executable> [-- app arguments]
//
// Prints a table and, in GitHub Actions, adds it to the run summary and warns about each measure
// more than 10% worse by more than noise. It reports and never fails: a warning asks for a second look, on the same
// runner or on real hardware, before anyone calls it a regression.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type } from "arktype";
import { connect, delay, launch } from "./app.ts";

/** How much worse a median may get before the report warns. */
const BUDGET = 0.1;
/** Differences smaller than this are noise, whatever share they are: a point of CPU, 10 MB, 20 ms. */
const NOISE = { "%": 1, MB: 10, ms: 20 };
/** What measure-app.ts writes with `--json`: every run of every measure. */
const Results = type({ "[string]": "number[]" });

const { values: options, positionals } = parseArgs({
  options: { rounds: { type: "string", default: "3" } },
  allowPositionals: true,
});
const [baseline, candidate, ...appArgs] = positionals;
if (!baseline || !candidate) {
  throw new Error(
    "Usage: node test/e2e/compare-builds.ts [--rounds n] <baseline> <candidate> [-- args]",
  );
}
const rounds = Number(options.rounds);
const builds = { baseline, candidate };
type Build = keyof typeof builds;

// The first launch on a machine is slower, whichever build it is: pay for it outside the runs.
for (const executable of [baseline, candidate]) await warmUp(executable);

const folder = mkdtempSync(join(tmpdir(), "mr-streamer-compare-"));
const runs: Record<Build, Record<string, number[]>[]> = { baseline: [], candidate: [] };
try {
  for (let round = 0; round < rounds; round++) {
    const order: Build[] = round % 2 === 0 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    for (const build of order) {
      console.log(`Round ${round + 1}: ${build}`);
      const output = join(folder, `${build}-${round}.json`);
      execFileSync(
        process.execPath,
        [
          join(import.meta.dirname, "measure-app.ts"),
          "--json",
          output,
          builds[build],
          "--",
          ...appArgs,
        ],
        { stdio: "inherit" },
      );
      runs[build].push(Results.assert(JSON.parse(readFileSync(output, "utf8"))));
    }
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const lines = [`| Measure | Baseline | This build | Change |`, `| --- | --- | --- | --- |`];
const worse: string[] = [];
for (const measure of Object.keys(runs.baseline[0] ?? {})) {
  const before = median(runs.baseline.flatMap((run) => run[measure] ?? []));
  const after = median(runs.candidate.flatMap((run) => run[measure] ?? []));
  const change = before > 0 ? (after - before) / before : 0;
  const over = change > BUDGET && after - before > NOISE[unitOf(measure)];
  if (over)
    worse.push(`${measure}: ${shown(measure, before)} before, ${shown(measure, after)} now`);
  const percent = `${change >= 0 ? "+" : ""}${Math.round(change * 100)}%`;
  lines.push(
    `| ${measure} | ${shown(measure, before)} | ${shown(measure, after)} | ${over ? `**${percent}**` : percent} |`,
  );
}
const table = lines.join("\n");
console.log(table);

const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) {
  appendFileSync(
    summary,
    `### This build against the baseline (${process.platform})\n\nMedians of ${rounds} runs of each build on this runner, alternated, after starting each once. Changes over ${BUDGET * 100}% and beyond noise are bold; runners vary, so measure again before calling one a regression.\n\n${table}\n`,
  );
}
for (const line of worse) console.log(`::warning title=More than ${BUDGET * 100}% worse::${line}`);

/** Starts a build with a throwaway profile, waits for its window, and quits it. */
async function warmUp(executable: string): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "mr-streamer-warm-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = launch(executable, appArgs, { port, profile });
  try {
    (await connect(port)).close();
    await delay(3000);
  } finally {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await Promise.race([exited, delay(10_000)]);
    app.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** The middle value, or the mean of the two middle ones: idle measures give one value a run. */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[Math.floor(middle)] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function shown(measure: string, value: number): string {
  const unit = unitOf(measure);
  return `${Math.round(value * 10) / 10}${unit === "ms" ? " ms" : ""}`;
}

/** The unit a measure is in: named in brackets, or milliseconds. */
function unitOf(measure: string): keyof typeof NOISE {
  if (measure.includes("(%)")) return "%";
  if (measure.includes("(MB)")) return "MB";
  return "ms";
}
