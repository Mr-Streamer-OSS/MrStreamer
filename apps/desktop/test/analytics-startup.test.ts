import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../src/main/analytics/service.ts";
import { analyticsStore } from "../src/main/analytics/storage.ts";
import * as jsonFile from "../src/main/platform/json-file.ts";
import type {
  AnalyticsRecord,
  BuildProperties,
  CaptureEvent,
  ProfileOrigin,
  SummaryEvent,
} from "../src/main/analytics/model.ts";
import { tempDir } from "./support.ts";

const properties: BuildProperties = {
  app_version: "0.0.18",
  build_channel: "stable",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
};
const id = "fd17819b-85f2-41e4-8322-444bfa91ece0";
const timestamp = "2026-10-23T12:00:00.000Z";
const envelope = {
  ...properties,
  profile_origin: "upgrading" as const,
  $process_person_profile: false as const,
  $geoip_disable: true as const,
};
const installation = {
  uuid: "e1ebd019-ab3e-4d80-b1bd-912eb2ac0800",
  distinct_id: id,
  timestamp,
  event: "installation_observed",
  properties: envelope,
} satisfies CaptureEvent;
const usage: SummaryEvent = {
  uuid: "be219421-d07a-48f0-bd4e-fdb8bf58fa46",
  distinct_id: id,
  timestamp,
  event: "usage_window",
  properties: {
    ...envelope,
    window_start: timestamp,
    window_end: "2026-10-23T12:05:00.000Z",
    counts: { feature_home: 2 },
  },
};
const play: SummaryEvent = {
  uuid: "3634b8ec-c442-48da-861c-0e99941d35be",
  distinct_id: id,
  timestamp,
  event: "stream_summary",
  properties: {
    ...envelope,
    stream_type: "live",
    started_at: timestamp,
    started_update_channel: "stable",
    watch_duration_seconds: 42,
    end_reason: "interrupted",
  },
};
function retained(): AnalyticsRecord {
  return {
    format: 2,
    enabled: true,
    installationId: id,
    profileOrigin: "upgrading",
    firstSeen: true,
    lastDay: "2026-10-23",
    pending: [{ event: structuredClone(installation), attempts: 1 }],
  };
}

const owners: Analytics[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date(timestamp));
});
afterEach(async () => {
  const closing = Promise.all(owners.splice(0).map((owner) => owner.close()));
  await vi.advanceTimersByTimeAsync(1500);
  await closing;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(
  options: {
    record?: AnalyticsRecord | null;
    origin?: Promise<ProfileOrigin>;
    store?: ReturnType<typeof analyticsStore>;
  } = {},
) {
  const dataDir = await tempDir();
  const load = Promise.withResolvers<AnalyticsRecord | null>();
  let record = options.record === undefined ? retained() : structuredClone(options.record);
  const writes: AnalyticsRecord[] = [];
  const store = options.store ?? {
    load: () => load.promise,
    async save(next: AnalyticsRecord) {
      record = structuredClone(next);
      writes.push(record);
    },
  };
  const events: CaptureEvent[] = [];
  const owner = new Analytics({
    dataDir,
    origin: options.origin ?? Promise.resolve("fresh"),
    properties,
    store,
    transport: {
      kind: "local",
      async send(event) {
        events.push(structuredClone(event));
        return "accepted";
      },
    },
  });
  owners.push(owner);
  return { owner, events, writes, load, snapshot: () => structuredClone(record) };
}

/** Real file work settles independently of the controlled deadline clock. */
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error("Analytics startup side effect did not settle.");
}

describe("optional analytics startup", () => {
  it.each([200, 1700])(
    "delivers retained work after a %i ms store load without extending the settings deadline",
    async (ms) => {
      const { owner, load, events, writes, snapshot } = await start();
      const settings = owner.settings();
      setTimeout(() => load.resolve(retained()), ms);
      await vi.advanceTimersByTimeAsync(Math.min(1500, ms));
      expect(await settings).toEqual(
        ms <= 1500
          ? { enabled: true, transport: "local" }
          : { enabled: false, transport: "unavailable" },
      );
      await vi.advanceTimersByTimeAsync(Math.max(0, ms - 1500));
      expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
      expect(events).toEqual([installation]);
      expect(writes[0]?.pending).toEqual([{ event: installation, attempts: 2 }]);
      expect(snapshot()).toMatchObject({
        installationId: id,
        profileOrigin: "upgrading",
        pending: [],
      });
      owner.setForeground(true);
      await owner.configure(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.map((event) => event.event)).toEqual([
        "installation_observed",
        "app_version_observed",
      ]);
      expect(events[1]?.properties).toMatchObject({ observation_kind: "unknown_history" });
    },
  );

  it("waits for a late origin before classifying a fresh foreground profile, then observes it once", async () => {
    const origin = Promise.withResolvers<ProfileOrigin>();
    const { owner, load, events, snapshot } = await start({ record: null, origin: origin.promise });
    load.resolve(null);
    owner.setForeground(true);
    const settings = owner.settings();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settings).toEqual({ enabled: false, transport: "unavailable" });
    expect(events).toEqual([]);
    origin.resolve("fresh");
    await vi.advanceTimersByTimeAsync(200);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    expect(events.map((event) => event.event)).toEqual([
      "installation_observed",
      "app_active_day",
      "app_version_observed",
    ]);
    expect(events.every((event) => event.properties.profile_origin === "fresh")).toBe(true);
    expect(new Set(events.map((event) => event.distinct_id)).size).toBe(1);
    expect(snapshot()).toMatchObject({ firstSeen: true, lastDay: "2026-10-23", pending: [] });
    owner.setForeground(false);
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(3);
  });

  it.each(["store", "origin"] as const)(
    "fails closed on a late %s rejection without writing or exposing the failure",
    async (port) => {
      const origin = Promise.withResolvers<ProfileOrigin>();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { owner, load, events, writes } = await start({ origin: origin.promise });
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      expect(await settings).toMatchObject({ transport: "unavailable" });
      if (port === "store") {
        load.reject(new Error("PRIVATE-ID /private/path"));
        origin.resolve("fresh");
      } else {
        load.resolve(retained());
        origin.reject(new Error("PRIVATE-ID /private/path"));
      }
      await vi.advanceTimersByTimeAsync(200);
      owner.setForeground(true);
      await expect(owner.configure(true)).rejects.toThrow(
        "Analytics preference could not be saved.",
      );
      expect(await owner.settings()).toEqual({ enabled: false, transport: "unavailable" });
      expect(events).toEqual([]);
      expect(writes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("keeps a timed-out opt-out pending until loading settles, clears work and never backfills on re-enable", async () => {
    const before = {
      ...retained(),
      summaries: {
        version: 1 as const,
        installationId: id,
        pending: [],
        usage,
        unfinished: { event: play, watchMs: 42_000 },
      },
    };
    const { owner, load, events, snapshot } = await start({ record: before });
    owner.setForeground(true);
    const disabled = expect(owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    await vi.advanceTimersByTimeAsync(1500);
    await disabled;
    expect(events).toEqual([]);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(snapshot()).toEqual({ ...retained(), enabled: false, pending: [] });
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((event) => event.event)).toEqual(["app_version_observed"]);
    expect(events[0]?.properties).toMatchObject({ observation_kind: "unknown_history" });
    expect(events[0]?.properties).not.toHaveProperty("previous_app_version");
    expect(snapshot()).toMatchObject({ ...retained(), pending: [] });
  });

  it.each([
    [false, true],
    [true, false],
    [false, true, false],
  ])(
    "serializes consent requests made after the startup deadline: %j",
    async (...requests: boolean[]) => {
      const { owner, load, events, snapshot } = await start();
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      await settings;
      const changes = requests.map((enabled) => owner.configure(enabled));
      load.resolve(retained());
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(changes);
      expect(await owner.settings()).toEqual({ enabled: requests.at(-1), transport: "local" });
      expect(snapshot()).toEqual({ ...retained(), enabled: requests.at(-1), pending: [] });
      expect(events).toEqual([]);
    },
  );

  it("respects saved opt-out after a late load", async () => {
    const before = { ...retained(), enabled: false, pending: [] };
    const { owner, load, events, writes } = await start({ record: before });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(1700);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(0);
    expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("recovers open summaries once after a pending enable and preserves an existing summary's retry time", async () => {
    const delayed = { ...play, uuid: "9a93e0a9-c293-44fe-a41e-c491e9f99107" };
    const before: AnalyticsRecord = {
      ...retained(),
      summaries: {
        version: 1,
        installationId: id,
        usage,
        unfinished: { event: play, watchMs: 42_000 },
        pending: [
          { event: delayed, attempts: 1, failures: 2, nextAttemptAt: "2026-10-23T12:00:05.000Z" },
        ],
      },
    };
    const { owner, load, events, snapshot } = await start({ record: before });
    const settings = owner.settings();
    await vi.advanceTimersByTimeAsync(1500);
    await settings;
    const enabled = owner.configure(true);
    await vi.advanceTimersByTimeAsync(200);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(0);
    await enabled;
    expect(events).toEqual([installation, usage, play]);
    expect(snapshot()?.summaries).toEqual({ ...before.summaries, usage: null, unfinished: null });
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(3300);
    expect(events).toEqual([installation, usage, play, delayed]);
    expect(snapshot()?.summaries?.pending).toEqual([]);
  });

  it("keeps a failed recovery write unavailable without sending or replacing durable consent", async () => {
    const before: AnalyticsRecord = {
      ...retained(),
      summaries: { version: 1, installationId: id, pending: [], usage, unfinished: null },
    };
    const gate = Promise.withResolvers<AnalyticsRecord>();
    const { owner, events } = await start({
      store: {
        load: () => gate.promise,
        save: async () => {
          throw new Error("PRIVATE-ID");
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1700);
    gate.resolve(structuredClone(before));
    await vi.advanceTimersByTimeAsync(0);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
    await expect(owner.configure(true)).rejects.toThrow("Analytics preference could not be saved.");
    expect(events).toEqual([]);
    expect(before.summaries?.usage).toEqual(usage);
  });

  it.each(["resolve", "reject"] as const)(
    "bounds quit during a pending load and does no later work on %s",
    async (outcome) => {
      const { owner, load, events, writes } = await start();
      owner.setForeground(true);
      const closing = owner.close();
      await vi.advanceTimersByTimeAsync(500);
      await closing;
      if (outcome === "resolve") load.resolve(retained());
      else load.reject(new Error("PRIVATE-ID"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(events).toEqual([]);
      expect(writes).toEqual([]);
      await expect(owner.configure(true)).rejects.toThrow(
        "Analytics preference could not be saved.",
      );
    },
  );

  it("does not apply a queued preference after quitting with initialization still pending", async () => {
    const { owner, load, events, writes } = await start();
    const disabled = expect(owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    await vi.advanceTimersByTimeAsync(1000);
    await disabled;
    load.resolve(retained());
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each(["success", "failure", "opt-out"] as const)(
    "handles a late format-one migration %s through the real loader",
    async (outcome) => {
      const dataDir = await tempDir();
      const path = join(dataDir, "analytics.json");
      const legacy = {
        ...retained(),
        format: 1,
        summary: { private: "discarded" },
        pending: [
          ...retained().pending,
          { event: { ...installation, event: "app_summary_day" }, attempts: 0 },
        ],
      };
      await writeFile(path, JSON.stringify(legacy));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = jsonFile.writeJsonFile;
      vi.spyOn(jsonFile, "writeJsonFile").mockImplementationOnce(async (destination, value) => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") throw new Error("PRIVATE-ID rename EACCES");
        await original(destination, value);
      });
      const { owner, events } = await start({ store: analyticsStore(dataDir) });
      const disabled =
        outcome === "opt-out"
          ? expect(owner.configure(false)).rejects.toThrow(
              "Analytics preference could not be saved.",
            )
          : null;
      await entered.promise;
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      await disabled;
      expect(await settings).toEqual({ enabled: false, transport: "unavailable" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
      release.resolve();
      if (outcome === "success") {
        await until(
          async () =>
            events.length === 1 && (await analyticsStore(dataDir).load())?.pending.length === 0,
        );
        expect(events).toEqual([installation]);
        expect(await analyticsStore(dataDir).load()).toMatchObject({ ...retained(), pending: [] });
        expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
      } else if (outcome === "opt-out") {
        await until(async () => JSON.parse(await readFile(path, "utf8")).enabled === false);
        expect(events).toEqual([]);
        expect(await analyticsStore(dataDir).load()).toEqual({
          ...retained(),
          enabled: false,
          pending: [],
        });
        expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
      } else {
        await until(async () => {
          try {
            await owner.configure(true);
            return false;
          } catch {
            return true;
          }
        });
        expect(await owner.settings()).toEqual({ enabled: false, transport: "unavailable" });
        expect(events).toEqual([]);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
      }
    },
  );
});
