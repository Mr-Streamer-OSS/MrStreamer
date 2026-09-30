// Measures two builds on one machine and reports how the second compares with the first. Runs
// measure-app.ts on each in turn, swapping the order every round, so a machine that slows down or
// speeds up during the runs affects both alike. Shared CI runners vary too much for absolute
// numbers; the difference between builds measured together is what they can tell.
//
//   node test/e2e/compare-builds.ts [--rounds 2] <baseline executable> <candidate executable> [-- app arguments]
//
// Prints a table and, in GitHub Actions, adds it to the run summary and warns about each measure
// more than 10% worse. It reports and never fails: a warning asks for a second look, on the same
// runner or on real hardware, before anyone calls it a regression.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type } from "arktype";

/** How much worse a median may get before the report warns. */
const BUDGET = 0.1;
/** What measure-app.ts writes with `--json`: every run of every measure. */
const Results = type({ "[string]": "number[]" });

const { values: options, positionals } = parseArgs({
  options: { rounds: { type: "string", default: "2" } },
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

const lines = [`| Measure | Last nightly | This build | Change |`, `| --- | --- | --- | --- |`];
const worse: string[] = [];
for (const measure of Object.keys(runs.baseline[0] ?? {})) {
  const before = median(runs.baseline.flatMap((run) => run[measure] ?? []));
  const after = median(runs.candidate.flatMap((run) => run[measure] ?? []));
  const change = before > 0 ? (after - before) / before : 0;
  const over = change > BUDGET;
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
    `### Measured against the last nightly (${process.platform})\n\nMedians of ${rounds} runs of each build on this runner, alternated. Changes over ${BUDGET * 100}% are bold; runners vary, so measure again before calling one a regression.\n\n${table}\n`,
  );
}
for (const line of worse) console.log(`::warning title=More than ${BUDGET * 100}% worse::${line}`);

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function shown(measure: string, value: number): string {
  return `${Math.round(value * 10) / 10}${measure.includes("(") ? "" : " ms"}`;
}
