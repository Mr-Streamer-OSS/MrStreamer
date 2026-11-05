import { type as arkType } from "arktype";
// A Vitest reporter that writes the seconds each test file took, by its path from the root, in
// the form test/durations.json keeps for test/sequencer.ts. A file's seconds cover its import,
// setup, hooks and tests, which the JSON report's times leave out. CI's Test job adds it to the
// merge of its shards from the trusted validation tools' checkout, whatever the candidate has, so
// a change here changes how older candidates merge too, and every run's test-results artifact
// carries a fresh table:
//
//   vitest run --merge-reports=<blobs> --reporter=./scripts/test-durations.ts --outputFile.durations=<file>
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

export default class TestDurations implements Reporter {
  #vitest: Vitest | undefined;

  onInit(vitest: Vitest) {
    this.#vitest = vitest;
  }

  onTestRunEnd(modules: readonly TestModule[]) {
    const config = this.#vitest?.config;

    const output = arkType("object")
      .narrow((value) => !(value instanceof Function))
      .allows(config?.outputFile)
      ? config.outputFile["durations"]
      : "";

    if (!config || !output) throw new Error("Pass --outputFile.durations=<file>");

    const seconds = modules
      .map((module) => {
        const taken = module.diagnostic();

        const ms =
          taken.environmentSetupDuration +
          taken.prepareDuration +
          taken.collectDuration +
          taken.setupDuration +
          taken.duration;

        const path = relative(config.root, module.moduleId).replaceAll("\\", "/");

        return [path, Math.round(ms / 100) / 10] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : 1));

    writeFileSync(output, `${JSON.stringify(Object.fromEntries(seconds), null, 2)}\n`);
  }
}
