import type { AnalyticsRecord } from "../../src/main/analytics/model.ts";
import type { Page } from "./app.ts";

export type Boundary = {
  kind: "checkpoint" | "seal" | "reserve" | "retire" | "next";
  phase: "before" | "after";
  uuid?: string;
};
type Hit = {
  at: number;
  before: AnalyticsRecord;
  after: AnalyticsRecord;
  phase: Boundary["phase"];
};

/** Holds one public filesystem promise around a real atomic rename, never an analytics method. */
export async function boundary(main: Page, profile: string, directory = profile) {
  await main.evaluate(
    `(${install.toString()})(${JSON.stringify(profile)},${JSON.stringify(directory)})`,
  );
  return {
    arm: async (spec: Boundary) => {
      await main.evaluate(`globalThis.__nativeTelemetryFS.arm(${JSON.stringify(spec)})`);
    },
    hit: () => main.evaluate<Hit | null>("globalThis.__nativeTelemetryFS.hit"),
    release: () => main.evaluate("globalThis.__nativeTelemetryFS.release()"),
    measurements: () =>
      main.evaluate<{ at: number; ms: number; code: string | null }[]>(
        "globalThis.__nativeTelemetryFS.measurements",
      ),
    restore: () => main.evaluate("globalThis.__nativeTelemetryFS.restore()"),
  };
}

async function install(profile: string, directory: string) {
  const fs = process.getBuiltinModule("fs").promises;
  const path = process.getBuiltinModule("path");
  const { syncBuiltinESMExports } = process.getBuiltinModule("module");
  if (
    !process.argv.includes(`--user-data-dir=${profile}`) ||
    !process.argv.includes("--enable-automation")
  )
    throw new Error("Filesystem probe requires the owned automated profile");
  // Electron can return the same Windows directory under its long rather than 8.3 name.
  if (directory !== profile && (await fs.realpath(directory)) !== (await fs.realpath(profile)))
    throw new Error("Filesystem probe directory differs from the owned profile");
  const original = fs.rename;
  const destination = path.join(directory, "analytics.json");
  const read = async (file: string) =>
    JSON.parse(await fs.readFile(file, "utf8")) as AnalyticsRecord;
  const queue = (record: AnalyticsRecord) => record.summaries?.pending ?? [];
  let spec: Boundary | null = null;
  let release: (() => void) | null = null;
  const probe = {
    hit: null as Hit | null,
    measurements: [] as { at: number; ms: number; code: string | null }[],
    arm(next: Boundary) {
      if (spec || release) throw new Error("Filesystem boundary already armed");
      spec = next;
      probe.hit = null;
    },
    release() {
      if (!release) throw new Error("No held filesystem operation");
      release();
      release = null;
    },
    restore() {
      if (release || fs.rename !== wrapped)
        throw new Error("Filesystem probe still held or changed owner");
      fs.rename = original;
      syncBuiltinESMExports();
      delete (globalThis as typeof globalThis & { __nativeTelemetryFS?: unknown })
        .__nativeTelemetryFS;
    },
  };
  const chosen = (uuid: string) => !spec?.uuid || uuid === spec.uuid;
  const matches = (before: AnalyticsRecord, after: AnalyticsRecord) => {
    switch (spec?.kind) {
      case "next":
        return true;
      case "checkpoint": {
        const journal = after.summaries?.unfinished;
        return (
          !!journal &&
          chosen(journal.event.uuid) &&
          JSON.stringify(journal) !== JSON.stringify(before.summaries?.unfinished)
        );
      }
      case "seal":
        return [before.summaries?.usage, before.summaries?.unfinished?.event].some(
          (event) =>
            event &&
            chosen(event.uuid) &&
            queue(after).some((item) => item.event.uuid === event.uuid),
        );
      case "reserve":
        return queue(after).some(
          (item) =>
            chosen(item.event.uuid) &&
            queue(before).some(
              (prior) =>
                prior.event.uuid === item.event.uuid && item.attempts === prior.attempts + 1,
            ),
        );
      case "retire":
        return queue(before).some(
          (item) =>
            chosen(item.event.uuid) &&
            !queue(after).some((next) => next.event.uuid === item.event.uuid),
        );
      default:
        return false;
    }
  };
  async function wrapped(
    from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1],
  ) {
    if (
      typeof from !== "string" ||
      to !== destination ||
      path.dirname(from) !== directory ||
      !/^analytics\.json\.[0-9a-f-]{36}\.tmp$/.test(path.basename(from))
    )
      return original(from, to);
    const started = performance.now();
    const before = spec ? await read(destination) : null;
    const after = spec ? await read(from) : null;
    const selected = before && after && matches(before, after) ? spec : null;
    const hold = async () => {
      if (!selected || !before || !after) return;
      spec = null;
      await new Promise<void>((resolve) => {
        release = resolve;
        probe.hit = { at: Date.now(), before, after, phase: selected.phase };
      });
    };
    if (selected?.phase === "before") await hold();
    try {
      await original(from, to);
      probe.measurements.push({ at: Date.now(), ms: performance.now() - started, code: null });
    } catch (error) {
      probe.measurements.push({
        at: Date.now(),
        ms: performance.now() - started,
        code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
      });
      throw error;
    }
    if (selected?.phase === "after") await hold();
  }
  const global = globalThis as typeof globalThis & { __nativeTelemetryFS?: typeof probe };
  if (global.__nativeTelemetryFS) throw new Error("Filesystem probe already installed");
  global.__nativeTelemetryFS = probe;
  fs.rename = wrapped;
  syncBuiltinESMExports();
  return { pid: process.pid, profile, boundary: "actual public fs.rename on owned analytics.json" };
}
