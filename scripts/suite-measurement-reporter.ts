// Read resolved runner policy without overriding its workers, retries, discovery or timeouts.
import { writeFileSync } from "node:fs";
import type { Reporter, Vitest } from "vitest/node";

export default class SuiteMeasurementReporter implements Reporter {
  onInit(ctx: Vitest): void {
    const output = process.env["MR_STREAMER_SUITE_POLICY"];
    if (!output) throw new Error("Suite measurement policy output is required");
    writeFileSync(
      output,
      JSON.stringify(
        {
          maxWorkers: ctx.config.maxWorkers,
          pool: ctx.config.pool,
          retry: ctx.config.retry ?? 0,
          testTimeout: ctx.config.testTimeout,
          hookTimeout: ctx.config.hookTimeout,
          include: ctx.config.include,
          exclude: ctx.config.exclude,
          globalSetup: ctx.config.globalSetup,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
}
