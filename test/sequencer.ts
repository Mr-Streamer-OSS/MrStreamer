// How vitest.config.ts orders and shards the test files: by the seconds test/durations.json
// records for each, from a hosted Checks run (docs/maintainers/ci.md has how to refresh it).
// Vitest's own split cuts by path hash and, without a results cache as on CI, starts the largest
// files first, which left one shard with twice the work and a slow small file starting last.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const durations: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL("durations.json", import.meta.url), "utf8"),
);

const recorded = Object.values(durations).sort((a, b) => a - b);

/** A file the table doesn't name yet counts as the median one. */
const unrecorded = recorded[Math.floor(recorded.length / 2)] ?? 1;

export class DurationSequencer extends BaseSequencer {
  /** The recorded seconds of a file, by its path from the root with forward slashes. */
  #seconds(spec: TestSpecification) {
    const path = relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");

    return durations[path] ?? unrecorded;
  }

  /** The longest first, so the files that bound a run start at once; ties go by path. */
  #longestFirst(files: readonly TestSpecification[]) {
    return files
      .map((spec) => ({ spec, seconds: this.#seconds(spec) }))
      .sort((a, b) => b.seconds - a.seconds || (a.spec.moduleId < b.spec.moduleId ? -1 : 1))
      .map(({ spec }) => spec);
  }

  /**
   * Hands each file, longest first, to the shard with the fewest recorded seconds so far. Every
   * shard computes the same split from the same files, so each file runs in exactly one.
   */
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const loads = Array.from({ length: count }, () => 0);

    return this.#longestFirst(files).filter((spec) => {
      const least = loads.indexOf(Math.min(...loads));
      loads[least] = (loads[least] ?? 0) + this.#seconds(spec);

      return least === index - 1;
    });
  }

  override async sort(files: TestSpecification[]) {
    return this.#longestFirst(files);
  }
}
