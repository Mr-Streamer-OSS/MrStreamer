// CI requires every behavioral test in these multimedia files, including their tool-gated groups.
// Local runs retain their optional skips; this checks the CI reporter's observable results.
import { readFileSync } from "node:fs";
import { type } from "arktype";

const Report = type({
  testResults: type({
    name: "string",
    assertionResults: type({
      fullName: "string",
      status: "string",
    }).array(),
  }).array(),
});

const path = process.argv[2];
if (!path) throw new Error("Pass the Vitest JSON report path.");
const input: unknown = JSON.parse(readFileSync(path, "utf8"));
const report = Report.assert(input);
const required = [
  "titles",
  "playback",
  "receiver",
  "output",
  "playlist-playback",
  "title-filter-playback",
];
for (const name of required) {
  const file = report.testResults.find((file) =>
    file.name.replaceAll("\\", "/").endsWith(`/apps/desktop/test/${name}.test.ts`),
  );
  if (!file || file.assertionResults.length === 0)
    throw new Error(`Required multimedia tests are missing: ${name}.`);
  const incomplete = file.assertionResults.filter((test) => test.status !== "passed");
  if (incomplete.length)
    throw new Error(
      `Required multimedia tests did not pass: ${incomplete.map((test) => `${test.fullName} (${test.status})`).join(", ")}`,
    );
  console.log(`Multimedia coverage: ${name}, ${file.assertionResults.length} passed, no skips.`);
}
