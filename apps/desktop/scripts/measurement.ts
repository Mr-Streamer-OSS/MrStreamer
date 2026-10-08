// Shared result contract for the existing measurement CLIs. Invalid instrumentation throws;
// exceeded performance budgets remain warnings and never turn a sample into zero.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { resolve } from "node:path";
import { type } from "arktype";

const Metric = type({
  unit: "'ms' | 'MB' | 'count'",
  samples: "number[]",
  "budget?": { limit: "number", outcome: "'pass' | 'warning'", basis: "'max' | 'median'" },
});
const Calibration = type({
  method: "string",
  knownDelayMs: "number",
  actualDelayMs: "number",
  observationErrorMs: "number",
  overheadMs: "number",
});
const Result = type({
  schemaVersion: "1",
  tool: "string",
  environment: {
    recordedAt: "string",
    platform: "string",
    cpu: "string",
    logicalCpus: "number",
    loadAverage: "number[]",
    node: "string",
    electron: "string",
    ffmpeg: "string",
    revision: "string",
    sourceDirty: "boolean",
    buildMode: "string",
    buildSha256: "string",
  },
  workload: { "[string]": "string | number | boolean" },
  conditions: { "[string]": "string | number | boolean" },
  "calibration?": Calibration.array(),
  "observations?": type({ "[string]": "number | string | boolean" }).array(),
  metrics: { "[string]": Metric },
  checks: { "[string]": "boolean" },
});
export type Measurement = typeof Result.infer;
export type MetricSamples = typeof Metric.infer;

export function positiveCount(value: string, name: string, maximum: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return count;
}

export function environment(
  options: {
    revision?: string;
    electron?: string;
    appDirectory?: string;
    executable?: string;
  } = {},
): Measurement["environment"] {
  const command = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "unavailable";
    }
  };
  const main = options.appDirectory ? resolve(options.appDirectory, "out/main/index.js") : "";
  return {
    recordedAt: new Date().toISOString(),
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    loadAverage: loadavg(),
    node: process.version,
    electron: options.electron ?? "not-used",
    ffmpeg:
      command(process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg", ["-version"]).split("\n")[0] ??
      "unavailable",
    revision: options.revision ?? command("git", ["rev-parse", "HEAD"]),
    sourceDirty: command("git", ["status", "--porcelain"]) !== "",
    buildMode:
      main && existsSync(main) ? "built-checkout" : options.executable ? "packaged" : "node-source",
    buildSha256:
      main && existsSync(main)
        ? createHash("sha256").update(readFileSync(main)).digest("hex")
        : options.executable
          ? createHash("sha256").update(readFileSync(options.executable)).digest("hex")
          : "not-applicable",
  };
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample)))
    throw new Error("Instrumentation requires nonempty finite samples");
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function metric(
  unit: MetricSamples["unit"],
  samples: number[],
  limit?: number,
  basis: "max" | "median" = "max",
): MetricSamples {
  const value = basis === "max" ? Math.max(...samples) : median(samples);
  return {
    unit,
    samples,
    ...(limit === undefined
      ? {}
      : {
          budget: {
            limit,
            basis,
            outcome: value < limit ? ("pass" as const) : ("warning" as const),
          },
        }),
  };
}

export function validateMeasurement(input: unknown): Measurement {
  const result = Result.assert(input);
  const expected =
    result.tool === "app"
      ? APP_METRICS
      : result.tool === "guide"
        ? GUIDE_METRICS
        : result.tool === "viewing"
          ? VIEWING_METRICS
          : null;
  if (!expected) throw new Error("Unknown measurement tool");
  if (
    JSON.stringify(Object.keys(result.metrics).sort()) !==
    JSON.stringify(Object.keys(expected).sort())
  )
    throw new Error("Instrumentation requires complete metric sets");
  for (const [name, unit] of Object.entries(expected))
    if (result.metrics[name]?.unit !== unit) throw new Error(`Incorrect metric unit: ${name}`);
  if (result.tool === "app") {
    const runs = positiveCount(String(result.workload["runs"]), "runs", 20);
    positiveCount(String(result.workload["subscriptions"]), "subscriptions", 4);
    for (const [name, measure] of Object.entries(result.metrics)) {
      const count =
        name === "installed size (MB)" || name === "streams opened, Home to Watch (count)"
          ? 1
          : runs;
      if (measure.samples.length !== count) throw new Error(`Incomplete samples: ${name}`);
    }
    if (!result.calibration?.length) throw new Error("Missing renderer calibration");
    for (const sample of result.calibration)
      if (
        [
          sample.knownDelayMs,
          sample.actualDelayMs,
          sample.observationErrorMs,
          sample.overheadMs,
        ].some((value) => !Number.isFinite(value) || value < 0)
      )
        throw new Error("Invalid renderer calibration");
  }
  const requiredChecks =
    result.tool === "app"
      ? ["completeMetrics", "movingPicture"]
      : result.tool === "guide"
        ? ["searchReturnsProgrammes", "listSearchReturnsChannels", "mappingsAvailable"]
        : ["rebuiltListsMatch", "rebuiltOrderMatches"];
  for (const check of requiredChecks)
    if (result.checks[check] !== true) throw new Error(`Invalid instrumentation: ${check}`);
  for (const values of [result.workload, result.conditions])
    if (Object.values(values).some((value) => typeof value === "number" && !Number.isFinite(value)))
      throw new Error("Non-finite measurement metadata");
  if (result.tool === "app" && !(Number(result.conditions["timingResolutionMs"]) > 0))
    throw new Error("Missing timing resolution");
  for (const [name, measure] of Object.entries(result.metrics)) {
    median(measure.samples);
    if (measure.samples.some((sample) => sample < 0)) throw new Error(`Negative sample: ${name}`);
    if (measure.unit === "count" && measure.samples.some((sample) => !Number.isInteger(sample)))
      throw new Error(`Non-integer count sample: ${name}`);
    if (measure.budget && (!Number.isFinite(measure.budget.limit) || measure.budget.limit <= 0))
      throw new Error(`Invalid budget: ${name}`);
    if (measure.budget) {
      const value =
        measure.budget.basis === "max" ? Math.max(...measure.samples) : median(measure.samples);
      if (measure.budget.outcome !== (value < measure.budget.limit ? "pass" : "warning"))
        throw new Error(`Incorrect budget outcome: ${name}`);
    }
  }
  for (const [name, passed] of Object.entries(result.checks))
    if (!passed) throw new Error(`Invalid instrumentation: ${name}`);
  return result;
}

export function saveMeasurement(path: string | undefined, result: Measurement): void {
  validateMeasurement(result);
  if (path) writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}

export function compareMeasurements(baseline: unknown[], candidate: unknown[]) {
  if (!baseline.length || baseline.length !== candidate.length)
    throw new Error("Incomplete comparison rounds");
  const before = baseline.map(validateMeasurement);
  const after = candidate.map(validateMeasurement);
  const first = before[0]!;
  const names = Object.keys(first.metrics).sort();
  for (const run of [...before, ...after]) {
    if (
      run.tool !== first.tool ||
      JSON.stringify(Object.keys(run.metrics).sort()) !== JSON.stringify(names)
    )
      throw new Error("Comparison requires identical metric sets and tools");
    for (const name of names) {
      if (run.metrics[name]!.unit !== first.metrics[name]!.unit)
        throw new Error(`Comparison requires identical units: ${name}`);
      if (run.metrics[name]!.samples.length !== first.metrics[name]!.samples.length)
        throw new Error(`Comparison requires identical sample counts: ${name}`);
    }
    for (const field of ["workload", "conditions"] as const) {
      const entries = (value: Measurement[typeof field]) =>
        JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (entries(run[field]) !== entries(first[field]))
        throw new Error(`Comparison requires identical ${field}`);
    }
  }
  const noiseMs = Math.max(
    20,
    ...[...before, ...after].map((run) =>
      Math.max(
        Number(run.conditions["timingResolutionMs"]) || 0,
        ...(run.calibration ?? []).map((sample) => sample.observationErrorMs * 2),
      ),
    ),
  );
  return names.map((name) => {
    const unit = first.metrics[name]!.unit;
    const a = before.flatMap((run) => run.metrics[name]!.samples);
    const b = after.flatMap((run) => run.metrics[name]!.samples);
    const baselineMedian = median(a),
      candidateMedian = median(b);
    const absoluteDelta = candidateMedian - baselineMedian;
    const relativeDelta = baselineMedian === 0 ? null : absoluteDelta / baselineMedian;
    const noise = unit === "ms" ? noiseMs : unit === "MB" ? 10 : 0;
    const spread = (values: number[]) => ({
      min: Math.min(...values),
      max: Math.max(...values),
      samples: values.length,
    });
    return {
      name,
      unit,
      baselineMedian,
      candidateMedian,
      absoluteDelta,
      relativeDelta,
      baselineSpread: spread(a),
      candidateSpread: spread(b),
      noise,
      outcome:
        absoluteDelta > noise && (relativeDelta === null || relativeDelta > 0.1)
          ? "warning"
          : "pass",
    };
  });
}

export const APP_METRICS = {
  "guide open": "ms",
  "guide list of 13,000": "ms",
  "time to picture": "ms",
  "streams opened per tune (count)": "count",
  "channel switch": "ms",
  "streams opened per switch (count)": "count",
  "search, typed to programmes shown": "ms",
  "streams opened, Home to Watch (count)": "count",
  "cold start to Home": "ms",
  "long series details, name shown": "ms",
  "long series details, episodes shown": "ms",
  "installed size (MB)": "MB",
} as const;

export function electronVersion(executable: string): string {
  return execFileSync(executable, ["-p", "process.versions.electron"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).trim();
}

const GUIDE_METRICS = {
  "download and index": "ms",
  "longest stall while downloading": "ms",
  "read from disk after a restart": "ms",
  "longest stall while reading": "ms",
  "now and next for 60 channels": "ms",
  "search news": "ms",
  "list search news": "ms",
  "mapping list": "ms",
  "mapping list searched": "ms",
  "guide channels searched": "ms",
  "now and next channels mapped": "ms",
  "memory held by guide": "MB",
} as const;
const VIEWING_METRICS = {
  watch: "ms",
  favourite: "ms",
  start: "ms",
  "start with rebuild": "ms",
  "database size": "MB",
  "one favourite to end": "ms",
  "events one favourite to end": "count",
  "last favourite to front": "ms",
  "events last favourite to front": "count",
  "reverse favourites": "ms",
  "events reverse favourites": "count",
  "rebuild ordered favourites": "ms",
} as const;
