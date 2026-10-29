import type { Server } from "node:http";
import { afterEach, vi } from "vitest";
import type {
  AnalyticsRecord,
  BuildProperties,
  CaptureEvent,
} from "../../src/main/analytics/model.ts";
import { Analytics } from "../../src/main/analytics/service.ts";
import { analyticsStore, profileOrigin } from "../../src/main/analytics/storage.ts";
import type { CaptureTransport } from "../../src/main/analytics/transport.ts";
import { tempDir } from "../support.ts";

/** Clock-driven sessions use clones; persistence and failure contracts keep the real store. */
export function memoryStore(
  initial: AnalyticsRecord | null = null,
): ReturnType<typeof analyticsStore> {
  let current = initial;
  return {
    load: async () => structuredClone(current),
    save: async (record) => {
      current = structuredClone(record);
    },
  };
}

/** Owns sessions and HTTP sinks for one suite, including fake-clock shutdown and failed tests. */
export function analyticsFixture(
  properties: BuildProperties,
  include = (_event: CaptureEvent) => true,
) {
  const owners: Analytics[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    const closing = Promise.all(owners.splice(0).map((owner) => owner.close()));
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1500);
    await closing;
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.useRealTimers();
  });
  async function start(
    options: {
      dataDir?: string;
      properties?: Partial<BuildProperties>;
      transport?: Omit<CaptureTransport, "kind"> | null;
      store?: ReturnType<typeof analyticsStore>;
      monotonic?: () => number;
    } = {},
  ) {
    const dataDir = options.dataDir ?? (await tempDir());
    const store = options.store ?? analyticsStore(dataDir);
    const events: CaptureEvent[] = [];
    const build = { ...properties, ...options.properties };
    const transport =
      options.transport === undefined
        ? {
            async send(event: CaptureEvent) {
              if (include(event)) events.push(structuredClone(event));
              return "accepted" as const;
            },
          }
        : options.transport;
    const owner = new Analytics({
      dataDir,
      origin: profileOrigin(dataDir),
      properties: build,
      store,
      transport: transport ? { ...transport, kind: "local" } : null,
      ...(options.monotonic ? { monotonic: options.monotonic } : {}),
    });
    owners.push(owner);
    await owner.settings();
    return { owner, dataDir, events, store, properties: build };
  }
  return { start, servers, owners };
}
