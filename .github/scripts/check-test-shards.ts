// Temporary paired trial: joins both shard reports so the unchanged candidate completeness gate
// (scripts/ci-test-results.ts) judges their union.
//
//   node .github/scripts/check-test-shards.ts <artifact directory> <union.json>
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Use <artifact directory> <union.json>");
const files = globSync(join(directory, "*/test-results.json"));
if (files.length !== 2)
  throw new Error(
    `Expected two shard reports from this attempt, found ${files.length}. Use Re-run all jobs; partial reruns are not matched measurements.`,
  );
const testResults = files.flatMap((file): unknown[] => {
  const report: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof report !== "object" ||
    report === null ||
    !("testResults" in report) ||
    !Array.isArray(report.testResults)
  )
    throw new Error(`Missing testResults in ${file}`);
  return report.testResults;
});
writeFileSync(output, JSON.stringify({ testResults }));
