// Temporary paired trial: the unchanged candidate completeness gate judges the combined report.
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Use <artifact directory> <union.json>");
const files = [...globSync(join(directory, "*/test-results.json"))];
if (files.length !== 2) throw new Error(`Expected two shard reports, found ${files.length}`);
const testResults: unknown[] = files.flatMap((file): unknown[] => {
  const report: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !report ||
    typeof report !== "object" ||
    !("testResults" in report) ||
    !Array.isArray(report.testResults)
  )
    throw new Error(`Missing testResults in ${file}`);
  return report.testResults;
});
writeFileSync(output, JSON.stringify({ testResults }));
