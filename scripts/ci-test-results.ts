// Checks CI's Vitest JSON report against the test files of the checkout it runs in: every file
// test/suites.ts finds has to be in the report once, with tests, each of them passed. A group that
// skipped for want of ffmpeg, a file that failed to load and a file the run left out all fail CI,
// and a new test file is required as soon as it exists, with no list of names to keep up to date.
//
//   node scripts/ci-test-results.ts <vitest-report.json>
//
// Run it from the root of the checkout the report came from: it finds the test files from the
// current folder and reads the report's absolute paths relative to it. Local runs keep their
// optional skips; this holds CI, on Linux, to running everything. The files that skip on Windows
// fail it there.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { globSync } from "tinyglobby";
import { exclude, include } from "../test/suites.ts";

/**
 * Files whose tests run on one platform alone and skip on every other. They still have to be in
 * the report with their tests, none failed; elsewhere every test has to pass.
 */
const platformOnly: Readonly<Record<string, NodeJS.Platform>> = {
  "apps/desktop/test/airplay-helper-key.test.ts": "darwin",
};

/** One test file's entry in Vitest's JSON report, as far as this reads it. */
interface FileResult {
  readonly name: string;
  readonly status: string;
  readonly message?: unknown;
  readonly assertionResults: readonly { readonly fullName: string; readonly status: string }[];
}

const isTest = (value: unknown): value is FileResult["assertionResults"][number] => {
  const fields: { fullName?: unknown; status?: unknown } = Object(value);

  try {
    return (
      value === fields &&
      fields.fullName === String.prototype.valueOf.call(fields.fullName) &&
      fields.status === String.prototype.valueOf.call(fields.status)
    );
  } catch {
    return false;
  }
};

const isFile = (value: unknown): value is FileResult => {
  const fields: { name?: unknown; status?: unknown; assertionResults?: unknown } = Object(value);

  try {
    return (
      value === fields &&
      fields.name === String.prototype.valueOf.call(fields.name) &&
      fields.status === String.prototype.valueOf.call(fields.status) &&
      Array.isArray(fields.assertionResults) &&
      fields.assertionResults.every(isTest)
    );
  } catch {
    return false;
  }
};

/** The report's file entries, or why the file at `path` is no Vitest JSON report. */
function readReport(path: string): readonly FileResult[] | string {
  let report: { testResults?: unknown };

  try {
    report = Object(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return `Couldn't read ${path} as JSON: ${error instanceof Error ? error.message : error}`;
  }

  if (!Array.isArray(report.testResults) || !report.testResults.every(isFile))
    return `${path} is no Vitest JSON report: each of its testResults needs a name, a status and assertionResults.`;

  return report.testResults;
}

/** What keeps `file`'s results from counting as complete; nothing when they do. */
function problems(file: string, results: readonly FileResult[]): string[] {
  const [result, ...others] = results;

  if (!result) return [`${file}: not in the report. Did it fail to load, or the run stop early?`];

  if (others.length) return [`${file}: in the report ${results.length} times.`];

  let message = "";

  try {
    const text = String.prototype.valueOf.call(result.message);

    if (text === result.message && text) message = ` ${text}`;
  } catch {
    // A non-string diagnostic adds no advice.
  }

  if (result.assertionResults.length === 0) return [`${file}: ran no tests.${message}`];
  const platform = platformOnly[file];
  const allowed = platform && platform !== process.platform ? ["passed", "skipped"] : ["passed"];
  const unfinished = result.assertionResults.filter((test) => !allowed.includes(test.status));
  const found = unfinished.slice(0, 5).map((test) => `${file}: ${test.fullName} (${test.status})`);

  if (unfinished.length > 5) found.push(`${file}: ${unfinished.length - 5} more did not pass.`);

  if (result.status !== "passed" && found.length === 0) found.push(`${file}: failed.${message}`);

  return found;
}

/** Prints `found` and ends the check failed. */
function fail(found: readonly string[]): never {
  console.error(`The test report is incomplete:\n${found.map((line) => `- ${line}`).join("\n")}`);
  process.exit(1);
}

const [path] = process.argv.slice(2);

if (!path) {
  console.error("Name the Vitest JSON report: node scripts/ci-test-results.ts <report.json>");
  process.exit(1);
}

// Found as Vitest 5 finds them (globProjectFiles), dot-named files and folders included.
const files = globSync(include, { dot: true, ignore: exclude, expandDirectories: false });

if (files.length === 0)
  fail([`No test files under ${process.cwd()}. Run this from the repository's root.`]);

const report = readReport(path);

const results: readonly FileResult[] = Array.isArray(report) ? report : fail([String(report)]);

const byFile = Map.groupBy(results, (result) =>
  relative(process.cwd(), result.name).replaceAll("\\", "/"),
);

const found = files.flatMap((file) => problems(file, byFile.get(file) ?? []));

for (const file of byFile.keys())
  if (!files.includes(file))
    found.push(
      `${file}: in the report, but no test file here. Run this from the root of the checkout the report came from.`,
    );

if (found.length) fail(found);

const passed = results.flatMap((result) =>
  result.assertionResults.filter((test) => test.status === "passed"),
);

console.log(`All ${files.length} test files are in the report: ${passed.length} tests passed.`);

for (const [file, [result]] of byFile) {
  const skipped = result?.assertionResults.filter((test) => test.status === "skipped").length;

  if (skipped) console.log(`${file} skipped ${skipped}, which run on ${platformOnly[file]} alone.`);
}
