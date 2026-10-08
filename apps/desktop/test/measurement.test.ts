import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_METRICS,
  compareMeasurements,
  metric,
  validateMeasurement,
  type Measurement,
} from "../scripts/measurement.ts";

function report(): Measurement {
  return {
    schemaVersion: 1,
    tool: "app",
    environment: {
      recordedAt: "2026-10-08T00:00:00Z",
      platform: "contract",
      cpu: "fixture",
      logicalCpus: 2,
      loadAverage: [0, 0, 0],
      node: "24",
      electron: "44",
      ffmpeg: "8",
      revision: "fixture",
      sourceDirty: false,
      buildMode: "built-checkout",
      buildSha256: "fixture",
    },
    workload: { runs: 1, subscriptions: 2 },
    conditions: { timingResolutionMs: 5, cache: "fixture" },
    calibration: [
      {
        method: "probe-only",
        knownDelayMs: 5,
        actualDelayMs: 5,
        observationErrorMs: 1,
        overheadMs: 0.1,
      },
    ],
    metrics: Object.fromEntries(
      Object.entries(APP_METRICS).map(([name, unit]) => [
        name,
        metric(unit, [unit === "ms" ? 100 : 1]),
      ]),
    ),
    checks: { completeMetrics: true, movingPicture: true },
  };
}

describe("measurement result contract", () => {
  it("compares complete samples with absolute deltas, spread and warning-only budgets", () => {
    const before = report(),
      after = report();
    after.metrics["time to picture"]!.samples = [140];
    const measure = compareMeasurements([before], [after]).find(
      (value) => value.name === "time to picture",
    );
    expect(measure).toMatchObject({
      absoluteDelta: 40,
      relativeDelta: 0.4,
      baselineSpread: { min: 100, max: 100, samples: 1 },
      outcome: "warning",
    });
    expect(
      validateMeasurement({
        ...report(),
        metrics: { ...report().metrics, "time to picture": metric("ms", [100], 50) },
      }).metrics["time to picture"]?.budget?.outcome,
    ).toBe("warning");
  });

  it("rejects missing metrics, empty/non-finite samples, incorrect units and failed readiness", () => {
    const missing = report();
    delete missing.metrics["time to picture"];
    expect(() => compareMeasurements([report()], [missing])).toThrow(/complete metric/);
    for (const samples of [[], [NaN], [Infinity]]) {
      const invalid = report();
      invalid.metrics["time to picture"]!.samples = samples;
      expect(() => validateMeasurement(invalid)).toThrow();
    }
    const wrongUnit = report();
    wrongUnit.metrics["time to picture"]!.unit = "count";
    expect(() => compareMeasurements([report()], [wrongUnit])).toThrow(/unit/);
    expect(() => compareMeasurements([], [])).toThrow(/rounds/);
    const failed = report();
    failed.checks["movingPicture"] = false;
    expect(() => validateMeasurement(failed)).toThrow(/movingPicture/);
  });

  it("requires matched workload, round count and sample count", () => {
    const other = report();
    other.workload["subscriptions"] = 1;
    expect(() => compareMeasurements([report()], [other])).toThrow(/workload/);
    expect(() => compareMeasurements([report()], [report(), report()])).toThrow(/rounds/);
    const short = report();
    short.workload["runs"] = 2;
    expect(() => validateMeasurement(short)).toThrow(/samples/);
  });

  it("uses calibrated resolution and handles a zero baseline without invented percentages", () => {
    const before = report(),
      after = report();
    before.metrics["streams opened, Home to Watch (count)"]!.samples = [0];
    after.calibration![0]!.observationErrorMs = 30;
    after.metrics["time to picture"]!.samples = [140];
    const result = compareMeasurements([before], [after]);
    expect(result.find((measure) => measure.name === "time to picture")).toMatchObject({
      noise: 60,
      outcome: "pass",
    });
    expect(
      result.find((measure) => measure.name === "streams opened, Home to Watch (count)"),
    ).toMatchObject({ absoluteDelta: 1, relativeDelta: null, outcome: "warning" });
  });
});

it("comparison CLI retains a warning verdict but exits nonzero for invalid instrumentation", () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-contract-"));
  try {
    const before = join(directory, "before.json"),
      after = join(directory, "after.json"),
      output = join(directory, "comparison");
    const candidate = report();
    candidate.metrics["time to picture"]!.samples = [140];
    writeFileSync(before, JSON.stringify(report()));
    writeFileSync(after, JSON.stringify(candidate));
    const args = [
      resolve("apps/desktop/test/e2e/compare-builds.ts"),
      "--baseline-json",
      before,
      "--candidate-json",
      after,
      "--output",
      output,
    ];
    const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
      status: "valid",
      verdict: "warning",
      rawFiles: [before, after],
    });
    delete candidate.metrics["time to picture"];
    writeFileSync(after, JSON.stringify(candidate));
    const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
      status: "invalid-instrumentation",
      rawFiles: [before, after],
    });
    expect(readFileSync(before, "utf8")).toBeTruthy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("public CLI count validation fails before launching or generating workloads", () => {
  const cases = [
    ["test/e2e/compare-builds.ts", "--rounds", "0", "unused", "unused"],
    ["test/e2e/compare-builds.ts", "--rounds", "21", "unused", "unused"],
    ["test/e2e/measure-app.ts", "--runs", "NaN", "unused"],
    ["scripts/measure-guide.ts", "--guide-channels=-1"],
    ["scripts/measure-viewing.ts", "--events", "2.5"],
  ];
  for (const [file, ...args] of cases) {
    const result = spawnSync(process.execPath, [resolve("apps/desktop", file!), ...args], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/must be an integer from 1/);
  }
});
