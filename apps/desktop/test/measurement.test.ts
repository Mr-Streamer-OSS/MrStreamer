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
    observations: [
      { name: "time to picture", previousTime: 0.2, currentTime: 0.21, videoWidth: 1280 },
      { name: "channel switch", previousTime: 0.2, currentTime: 0.21, videoWidth: 1280 },
    ],
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
    expect(() => validateMeasurement(short)).toThrow(/samples|observations/);
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
      outcome: "inconclusive",
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
      insufficientSamples: true,
      minimumSamplesPerSide: 5,
      rawFiles: [before, after],
    });
    expect(valid.stdout).toContain("insufficient samples");
    expect(valid.stdout).toContain("1/1 (insufficient; minimum 5)");
    expect(valid.stdout).toContain(
      "::warning title=Performance comparison::time to picture: +40.0 ms; insufficient samples;",
    );
    writeFileSync(after, JSON.stringify(report()));
    const inconclusive = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(inconclusive.status, inconclusive.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
      status: "valid",
      verdict: "inconclusive",
      insufficientSamples: true,
    });
    expect(inconclusive.stdout).toContain(
      "Instrumentation valid; verdict inconclusive; insufficient samples",
    );
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

it.each([
  ["test/e2e/compare-builds.ts", "--rounds", "0", "unused", "unused"],
  ["test/e2e/compare-builds.ts", "--rounds", "21", "unused", "unused"],
  ["test/e2e/measure-app.ts", "--runs", "NaN", "unused"],
  ["scripts/measure-guide.ts", "--guide-channels=-1"],
  ["scripts/measure-viewing.ts", "--events", "2.5"],
])("public %s CLI rejects invalid count %s %s before workloads", (file, ...args) => {
  const result = spawnSync(process.execPath, [resolve("apps/desktop", file), ...args], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(/must be an integer from 1/);
});

it("retained CLI reports reject forged movement and unmatched execution environments", () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-retained-"));
  try {
    const mutations: ((value: Measurement) => void)[] = [
      (value) => {
        delete value.observations;
      },
      (value) => {
        value.observations![0]!["currentTime"] = 0.2;
      },
      (value) => {
        value.observations![0]!["videoWidth"] = 0;
      },
      (value) => {
        value.observations!.push(value.observations![0]!);
      },
      ...(["platform", "cpu", "node", "electron", "ffmpeg"] as const).map(
        (field) => (value: Measurement) => {
          value.environment[field] = "different";
        },
      ),
      (value) => {
        value.environment.logicalCpus = 4;
      },
      (value) => {
        value.environment.loadAverage = [Infinity, 0, 0];
      },
    ];
    const before = join(directory, "before.json"),
      after = join(directory, "after.json");
    writeFileSync(before, JSON.stringify(report()));
    for (const [index, mutate] of mutations.entries()) {
      const value = report();
      mutate(value);
      writeFileSync(after, JSON.stringify(value));
      const output = join(directory, String(index));
      const result = spawnSync(
        process.execPath,
        [
          resolve("apps/desktop/test/e2e/compare-builds.ts"),
          "--baseline-json",
          before,
          "--candidate-json",
          after,
          "--output",
          output,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
        status: "invalid-instrumentation",
        rawFiles: [before, after],
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it("small public workloads create nested destinations and reject incomplete retained service reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-services-"));
  try {
    for (const [tool, args, metricName] of [
      ["guide", ["--guide-channels", "2", "--programmes", "70"], "now and next for 60 channels"],
      ["viewing", ["--events", "1"], "watch"],
    ] as const) {
      const file = join(directory, tool, "nested", "result.json");
      const measured = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          resolve(`apps/desktop/scripts/measure-${tool}.ts`),
          ...args,
          "--json",
          file,
        ],
        { encoding: "utf8" },
      );
      expect(measured.status, measured.stderr).toBe(0);
      const retained = JSON.parse(readFileSync(file, "utf8")) as Measurement;
      expect(retained.tool).toBe(tool);
      const mutations: ((value: Measurement) => void)[] = [
        (value) => {
          value.metrics[metricName]!.samples = [1];
        },
        (value) => {
          value.workload["subscriptions"] = 99;
        },
        (value) => {
          value.workload[tool === "guide" ? "programmesPerChannel" : "inputEvents"] = -1;
        },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const value = structuredClone(retained);
        mutate(value);
        const invalid = join(directory, tool, `invalid-${index}.json`);
        writeFileSync(invalid, JSON.stringify(value));
        const output = join(directory, tool, `comparison-${index}`);
        const compared = spawnSync(
          process.execPath,
          [
            resolve("apps/desktop/test/e2e/compare-builds.ts"),
            "--baseline-json",
            invalid,
            "--candidate-json",
            invalid,
            "--output",
            output,
          ],
          { encoding: "utf8" },
        );
        expect(compared.status, compared.stderr).toBe(1);
        expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
          status: "invalid-instrumentation",
        });
      }
    }
    // A regular file cannot be a destination directory. Fail before generating even this tiny guide.
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "occupied");
    const denied = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        resolve("apps/desktop/scripts/measure-guide.ts"),
        "--guide-channels",
        "2",
        "--json",
        join(blocker, "result.json"),
      ],
      { encoding: "utf8" },
    );
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("Measurement destination is not writable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it("reports separated slowdowns, overlapping ranges and insufficient samples through the CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-spread-"));
  try {
    // Two samples are enough to inspect ranges, but do not claim repeated-comparison confidence.
    const before = report(),
      after = report();
    for (const value of [before, after]) {
      value.workload["runs"] = 2;
      for (const [name, measure] of Object.entries(value.metrics))
        if (name !== "installed size (MB)" && name !== "streams opened, Home to Watch (count)")
          measure.samples.push(measure.samples[0]!);
      value.observations!.push(...structuredClone(value.observations!));
    }
    before.metrics["time to picture"]!.samples = [100, 130];
    after.metrics["time to picture"]!.samples = [120, 200];
    after.metrics["channel switch"]!.samples = [140, 160];
    const a = join(directory, "a.json"),
      b = join(directory, "b.json");
    writeFileSync(a, JSON.stringify(before));
    writeFileSync(b, JSON.stringify(after));
    const output = join(directory, "comparison");
    const result = spawnSync(
      process.execPath,
      [
        resolve("apps/desktop/test/e2e/compare-builds.ts"),
        "--baseline-json",
        a,
        "--candidate-json",
        b,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(join(output, "comparison.json"), "utf8")) as {
      comparison: {
        name: string;
        outcome: string;
        insufficientSamples: boolean;
        observedRangeGap: number;
      }[];
    };
    expect(saved.comparison.find((value) => value.name === "time to picture")).toMatchObject({
      outcome: "inconclusive",
      insufficientSamples: true,
      observedRangeGap: -10,
    });
    expect(saved.comparison.find((value) => value.name === "channel switch")).toMatchObject({
      outcome: "warning",
      observedRangeGap: 40,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("requires five pooled samples and warns on separated count increases, including exactly one", () => {
  const countReport = (count: number) => {
    const value = report();
    value.metrics["streams opened per tune (count)"]!.samples = [count];
    return value;
  };
  const baseline = [1, 1, 2, 1, 1].map(countReport);
  const candidate = [2, 2, 2, 2, 2].map(countReport);
  const overlap = compareMeasurements(baseline, candidate);
  expect(overlap.find((value) => value.name === "streams opened per tune (count)")).toMatchObject({
    absoluteDelta: 1,
    observedRangeGap: 0,
    insufficientSamples: false,
    outcome: "pass",
  });
  expect(overlap.every((value) => value.outcome === "pass")).toBe(true);
  expect(
    compareMeasurements(baseline.slice(0, 4), candidate.slice(0, 4)).every(
      (value) => value.outcome === "inconclusive" && value.insufficientSamples,
    ),
  ).toBe(true);
  const separated = compareMeasurements(
    Array.from({ length: 5 }, () => countReport(10)),
    Array.from({ length: 5 }, () => countReport(11)),
  );
  expect(separated.find((value) => value.name === "streams opened per tune (count)")).toMatchObject(
    {
      absoluteDelta: 1,
      relativeDelta: 0.1,
      observedRangeGap: 1,
      outcome: "warning",
    },
  );
});
