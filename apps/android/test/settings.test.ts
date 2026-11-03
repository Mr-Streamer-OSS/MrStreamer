import { URL as NodeURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";

vi.mock("../src/platform/storage.ts", () => ({ readJsonStrict: vi.fn(), writeJson: vi.fn() }));

import { preferences } from "../src/platform/preferences.ts";
import { diagnosticsText } from "../src/settings/diagnostics.ts";
import { t } from "../src/settings/copy.ts";
import { androidAnalytics } from "../src/telemetry/analytics.ts";
import { providerRecovery } from "../src/settings/recovery.ts";
import { androidBuild } from "../src/telemetry/model.ts";
import { analyticsTransport } from "../src/telemetry/transport.ts";
import { store } from "../src/platform/store.ts";
import type { PlayerOwner } from "../src/player/player.ts";
import type { Sources } from "../src/connect/sources.ts";

afterEach(() => setLanguage({ locale: "en-US", formats: "en-US" }));

it("reports refused writes and unreadable preferences without turning them into missing values", () => {
  const files = preferences({ read: () => ({ choice: "nl-NL" }), write: () => {} });
  expect(files.write("language.json", { choice: "en-US" })).toBe(false);
  expect(files.language()).toBe("nl-NL");

  const unreadable = preferences({
    read: () => {
      throw new Error("unreadable");
    },
    write: () => {},
  });

  expect(() => unreadable.language()).toThrow();
  expect(unreadable.write("language.json", { choice: "en-US" })).toBe(false);
});

it("uses complete Dutch settings copy", () => {
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });
  expect(t("Interface language")).toBe("Taal van de interface");
  expect(t("Diagnostics")).toBe("Diagnostiek");
  expect(t("Unavailable. Try again.")).toBe("Niet beschikbaar. Probeer het opnieuw.");
  expect(t("Your statistics choice can't be saved on this phone right now.")).toBe(
    "Je keuze voor statistieken kan nu niet op deze telefoon worden bewaard.",
  );
});

it("diagnostics only include anonymous kinds and counts despite private input", () => {
  const text = diagnosticsText({
    version: "0.1.0",
    build: "1",
    release: "16",
    api: 36,
    now: 0,
    sources: {
      kind: "ready",
      sources: [
        {
          id: "private-id",
          kind: "xtream",
          label: "https://fake-user:fake-password@example.invalid/stream/fake-token",
          channels: {
            kind: "failed",
            error: {
              kind: "unexpected",
              detail:
                "fake-user fake-password https://example.invalid/live/fake-user/fake-password/1.ts /private/fake-path",
            },
          },
        },
      ],
    },
  });

  expect(text).toContain("Android release: 16\nAPI level: 36");
  expect(text).toContain("Providers: 1 Xtream");
  expect(text).toContain("Channels: failed");

  for (const secret of [
    "fake-user",
    "fake-password",
    "example.invalid",
    "fake-token",
    "fake-path",
    "private-id",
  ])
    expect(text).not.toContain(secret);
});

it("captures only Android fields and aborts delivery when switched Off", async () => {
  const send = vi.fn(async (_event: unknown, _signal: AbortSignal) => "accepted" as const);

  const build = {
    ...androidBuild("16", "0.1.0", "1"),
    model: "private-model",
    locale: "private-locale",
    provider: "private-provider",
    title: "private-title",
    url: "https://example.invalid/private",
  };

  const owner = androidAnalytics({
    load: () => null,
    save: () => true,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    build,
    transport: { send },
  });

  owner.noteFeature("settings");
  expect(send).not.toHaveBeenCalled();
  owner.configure(true);
  owner.noteFeature("settings");
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toEqual({
    uuid: "11111111-1111-4111-8111-111111111111",
    distinct_id: "11111111-1111-4111-8111-111111111111",
    timestamp: expect.any(String),
    event: "feature_opened",
    properties: {
      os: "android",
      os_major: 16,
      app_version: "0.1.0",
      app_build: "1",
      feature: "settings",
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
  owner.configure(false);
  expect(send.mock.calls[0]?.[1].aborted).toBe(true);
  expect(owner.consent.get()).toEqual({ choice: "off", installationId: null, pending: [] });
  await Promise.resolve();
});

it("has every manifest component's licence, version, source and full notice", async () => {
  const { default: manifest } = await import("../licenses/manifest.json");
  expect(manifest.length).toBeGreaterThan(0);

  for (const component of manifest) {
    expect(component.name).not.toBe("");
    expect(component.version).not.toBe("");
    expect(component.licence).not.toBe("");
    expect(component.source).not.toBe("");
    expect(component.notice.length).toBeGreaterThan(50);
  }
});

it("sends to production only from a release bundle with an approved host", () => {
  const config = {
    development: false,
    releaseBuild: "1",
    host: "https://eu.i.posthog.com",
    projectToken: "phc_example",
    localEndpoint: undefined,
  };

  expect(analyticsTransport(config)).not.toBeNull();
  expect(analyticsTransport({ ...config, development: true })).toBeNull();
  expect(analyticsTransport({ ...config, releaseBuild: undefined })).toBeNull();
  expect(analyticsTransport({ ...config, host: "https://example.invalid" })).toBeNull();
});

it("clears statistics only once the last provider is removed", async () => {
  const ready = (id: string) => ({
    id,
    kind: "m3u" as const,
    label: "example.invalid",
    channels: { kind: "ready" as const, rows: [] },
  });

  const state = store<Sources>({ kind: "ready", sources: [ready("first"), ready("last")] });
  const discard = vi.fn(() => true);

  const recovery = providerRecovery(
    {
      state,
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" }),
      retry: () => {},
      remove: async (id) => {
        const now = state.get();

        if (now.kind === "ready")
          state.set({ kind: "ready", sources: now.sources.filter((each) => each.id !== id) });
      },
    },
    discard,
    { release: async () => [] },
  );

  expect(await recovery.remove("first")).toMatchObject({ erase: "removed" });
  expect(discard).not.toHaveBeenCalled();
  expect(await recovery.remove("last")).toMatchObject({ erase: "removed" });
  expect(discard).toHaveBeenCalledOnce();
});

it.each(["removed", "partial", "refused"] as const)(
  "awaits only this source's playback before erase, retaining unconfirmed release, and keeps statistics unless erased, with %s",
  async (erase) => {
    const source = {
      id: "source",
      kind: "m3u" as const,
      label: "example.invalid",
      channels:
        erase === "partial"
          ? {
              kind: "failed" as const,
              error: { kind: "needs-secret" as const, subscriptionId: "source" },
            }
          : { kind: "ready" as const, rows: [] },
    };

    const state = store<Sources>({ kind: "ready", sources: [source] });
    const events: string[] = [];
    const discard = vi.fn(() => true);
    let finish!: () => void;

    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const release: PlayerOwner["release"] = async (matches) => {
      expect(matches({ kind: "source", sourceId: "source" })).toBe(true);
      expect(matches({ kind: "source", sourceId: "other" })).toBe(false);
      expect(matches({ kind: "file", path: "download" })).toBe(false);
      events.push("release");
      await waiting;
      events.push("released");

      if (events.filter((event) => event === "release").length > 1) return [];

      return [
        {
          attempt: "attempt",
          hold: { kind: "source", sourceId: "source" },
          outcome: "unconfirmed",
        },
      ];
    };

    const recovery = providerRecovery(
      {
        state,
        restore: async () => {},
        connect: async () => ({ kind: "cancelled" }),
        retry: () => {},
        remove: async () => {
          events.push("erase");

          if (erase === "partial")
            state.set({
              kind: "ready",
              sources: [{ ...source, channels: { ...source.channels } }],
            });

          if (erase !== "removed") throw new Error("erase refused");
          state.set({ kind: "ready", sources: [] });
        },
      },
      discard,
      { release },
    );

    const pending = recovery.remove("source");
    expect(events).toEqual(["release"]);
    finish();
    expect(await pending).toEqual({
      erase,
      release: Array.from({ length: 1 }, () => ({
        attempt: "attempt",
        hold: { kind: "source", sourceId: "source" },
        outcome: "unconfirmed",
      })),
    });
    expect(events).toEqual(["release", "released", "release", "released", "erase"]);
    expect(discard).toHaveBeenCalledTimes(erase === "removed" ? 1 : 0);
  },
);

it("keeps a refused record and never discards unreadable consent", async () => {
  const { statisticsConsent } = await import("@mrstreamer/mobile/consent/statistics");
  const saved = { choice: "on" as const, installationId: "identity", pending: ["queued"] };
  const consent = statisticsConsent({ load: () => saved, save: () => false });
  expect(consent.configure(false)).toBe(false);
  expect(consent.get()).toEqual(saved);
  expect(consent.enabled).toBe(false);
  expect(consent.pendingRevocation).toBe(true);
  const save = vi.fn(() => true);

  const unreadable = statisticsConsent({
    load: () => {
      throw Error("read");
    },
    save,
  });

  expect(unreadable.discard()).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it("retries a refused Off before delivery after a new owner starts", async () => {
  let saved: unknown = null;
  let pending = false;
  let refused = false;
  const send = vi.fn(async () => "retry" as const);

  const ports = {
    load: () => saved,
    save: (record: unknown) => {
      if (refused) return false;
      saved = record;

      return true;
    },
    revocation: {
      load: () => pending,
      save: (value: boolean) => {
        pending = value;

        return true;
      },
    },
    uuid: () => "11111111-1111-4111-8111-111111111111",
    build: androidBuild("16", "0.1.0", "1"),
    transport: { send },
  };

  const first = androidAnalytics(ports);
  first.configure(true);
  first.noteFeature("settings");
  await Promise.resolve();
  refused = true;
  expect(first.configure(false)).toBe(false);
  send.mockClear();
  const restarted = androidAnalytics(ports);
  await restarted.resume();
  restarted.noteFeature("settings");
  expect(send).not.toHaveBeenCalled();
  refused = false;
  await restarted.resume();
  expect(saved).toEqual({ choice: "off", installationId: null, pending: [] });
  expect(send).not.toHaveBeenCalled();
});

it("releases a play started during removal's wait and deduplicates removal", async () => {
  let finish!: () => void;

  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });

  let playing = false;

  const release = vi.fn(async () => {
    await wait;
    playing = false;

    return release.mock.calls.length === 1
      ? [
          {
            attempt: "first",
            hold: { kind: "source" as const, sourceId: "source" },
            outcome: "connections-closed" as const,
          },
        ]
      : [];
  });

  const remove = vi.fn(async () => {
    expect(playing).toBe(false);
  });

  const owner = {
    state: store<Sources>({ kind: "ready", sources: [] }),
    restore: async () => {},
    connect: async () => ({ kind: "cancelled" as const }),
    retry: () => {},
    remove,
  };

  const recovery = providerRecovery(owner, () => true, { release });
  const first = recovery.remove("source");
  expect(recovery.remove("source")).toBe(first);
  finish();
  // A new playback is admitted after the first release has completed.
  queueMicrotask(() => {
    playing = true;
  });
  await first;
  expect(release).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledOnce();
});

it("keeps the provider when playback release rejects and permits retry", async () => {
  const remove = vi.fn(async () => {});

  const release = vi.fn(async () => {
    throw Error("native refused");
  });

  const recovery = providerRecovery(
    {
      state: store<Sources>({ kind: "ready", sources: [] }),
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" as const }),
      retry: () => {},
      remove,
    },
    () => true,
    { release },
  );

  expect(await recovery.remove("source")).toMatchObject({ erase: "refused" });
  expect(remove).not.toHaveBeenCalled();
  await recovery.remove("source");
  expect(release).toHaveBeenCalledTimes(2);
});

it("sends the exact capture JSON and maps HTTP statuses", async () => {
  const event = {
    uuid: "11111111-1111-4111-8111-111111111111",
    distinct_id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-11-03T00:00:00.000Z",
    event: "feature_opened" as const,
    properties: {
      ...androidBuild("16", "0.1.0", "1"),
      feature: "settings" as const,
      $process_person_profile: false as const,
      $geoip_disable: true as const,
    },
  };

  const config = {
    development: true,
    releaseBuild: undefined,
    host: undefined,
    projectToken: undefined,
    localEndpoint: "http://127.0.0.1:1234/i/v0/e/",
  };

  for (const endpoint of [
    "http://localhost:1234/i/v0/e/",
    "http://127.0.0.1:1234/i/v0/e/?x=1",
    "http://127.0.0.1:1234/capture",
  ])
    expect(analyticsTransport({ ...config, localEndpoint: endpoint })).toBeNull();
  const request = vi.fn(async () => ({ status: 200 }));
  vi.stubGlobal("fetch", request);

  try {
    const transport = analyticsTransport(config)!;

    for (const [status, result] of [
      [200, "accepted"],
      [204, "accepted"],
      [400, "discard"],
      [401, "discard"],
      [429, "retry"],
      [500, "retry"],
    ] as const) {
      request.mockResolvedValue({ status });
      expect(await transport.send(event, new AbortController().signal)).toBe(result);
    }

    expect(request.mock.calls[0]).toEqual([
      config.localEndpoint,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          api_key: "mrstreamer-local-verification",
          event: event.event,
          uuid: event.uuid,
          distinct_id: event.distinct_id,
          timestamp: event.timestamp,
          properties: {
            app_version: "0.1.0",
            app_build: "1",
            os: "android",
            os_major: 16,
            $process_person_profile: false,
            $geoip_disable: true,
            feature: "settings",
          },
        }),
      }),
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("inventories exactly the release bundle packages and resolved native coordinates", async () => {
  const { readFile } = await import("node:fs/promises");
  const { default: manifest } = await import("../licenses/manifest.json");
  const entries = new Set(manifest.map(({ name, version }) => `${name}@${version}`));

  const report = await readFile(
    new NodeURL("../licenses/releaseRuntimeClasspath.txt", import.meta.url),
    "utf8",
  );

  const native = new Set<string>();

  for (const line of report.split("\n")) {
    if (line.includes("(c)")) continue;
    const match = /--- ([\w.-]+):([\w.-]+)(?::([^\s]+))?(?: -> ([^\s]+))?/.exec(line);

    if (!match) continue;
    const [, group, name, requested, resolved] = match;
    const version = resolved ?? requested;

    if (version)
      native.add(
        version.includes(":") ? version.replace(/:([^:]+)$/, "@$1") : `${group}:${name}@${version}`,
      );
  }

  expect(native.size).toBeGreaterThan(0);
  expect([...native].filter((coordinate) => !entries.has(coordinate))).toEqual([]);
  expect(
    [...native].some((coordinate) => coordinate.startsWith("com.facebook.hermes:hermes-android@")),
  ).toBe(true);
  const lock = await readFile(new NodeURL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const packages = lock.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0] ?? "";
  const locked = [...packages.matchAll(/^  '?([^\s']+@[^\s']+)'?:$/gm)].map((match) => match[1]!);
  expect(locked.length).toBeGreaterThan(0);
  const { default: sources } = await import("../licenses/bundle-sources.json");
  const { default: config } = await import("../app.json");
  const { default: bundled } = await import("../licenses/bundle-components.json");
  const { default: projects } = await import("../licenses/native-projects.json");
  const { default: summary } = await import("../licenses/summary.json");
  expect(summary.count).toBe(manifest.length);
  const importer = lock.split("\npackages:\n")[0]!;
  const resolved = new Set<string>();

  for (const source of sources) {
    if (source.startsWith("\0")) continue;
    const segment = /\/node_modules\/\.pnpm\/([^/]+)\/node_modules\//.exec(source)?.[1];
    let key: string;

    if (segment) key = segment.split("_")[0]!.replaceAll("+", "/");
    else if (source.startsWith("/node_modules/")) {
      const name = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(source)![1]!;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const version = new RegExp(
        `      '?${escaped}'?:\\n        specifier: [^\\n]+\\n        version: ([^\\n(]+)`,
      ).exec(importer)?.[1];

      expect(version, source).toBeDefined();
      key = `${name}@${version}`;
    } else {
      const workspace = /^\/packages\/([^/]+)\//.exec(source)?.[1];
      const path = workspace ? `../../../packages/${workspace}/package.json` : "../package.json";

      const metadata = JSON.parse(await readFile(new NodeURL(path, import.meta.url), "utf8")) as {
        name: string;
      };

      key = `${metadata.name}@${config.expo.version}`;
    }

    if (source.includes("/node_modules/")) expect(locked, source).toContain(key);
    resolved.add(key);
  }

  expect([...resolved].sort()).toEqual(bundled);
  const shipped = new Set([...report.matchAll(/--- project :([^\s]+)/g)].map((match) => match[1]!));
  expect(Object.keys(projects).sort()).toEqual([...shipped].sort());

  for (const key of Object.values(projects))
    if (!key.startsWith("mrstreamer-android@")) expect(locked).toContain(key);

  for (const key of Object.values(projects)) native.add(key);
  expect(bundled.length).toBeGreaterThan(0);
  expect([...entries].sort()).toEqual([...new Set([...native, ...bundled])].sort());
});

it.each(["on", "startup", "clear-refused"] as const)(
  "finishes pending revocation truthfully: %s",
  (mode) => {
    let pending = mode === "startup";
    let refuseRecord = false;

    const owner = androidAnalytics({
      load: () => null,
      save: () => !refuseRecord,
      revocation: {
        load: () => pending,
        save: (value) => {
          if (mode === "clear-refused" && !value) return false;
          pending = value;

          return true;
        },
      },
      uuid: () => "11111111-1111-4111-8111-111111111111",
      build: androidBuild("16", "0.1.0", "1"),
      transport: null,
    });

    if (mode === "startup") {
      expect(pending).toBe(false);

      return;
    }

    if (mode === "clear-refused") {
      expect(owner.configure(false)).toBe(true);
      expect(owner.consent.get().choice).toBe("off");

      return;
    }

    owner.configure(true);
    refuseRecord = true;
    expect(owner.configure(false)).toBe(false);
    refuseRecord = false;
    expect(owner.configure(true)).toBe(true);
    expect(owner.consent.enabled).toBe(true);
  },
);

it("does not claim an invalid login was erased when deletion was refused", async () => {
  const recovery = providerRecovery(
    {
      state: store<Sources>({
        kind: "ready",
        sources: [
          {
            id: "source",
            kind: "m3u",
            label: "example.invalid",
            channels: { kind: "failed", error: { kind: "invalid-login" } },
          },
        ],
      }),
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" }),
      retry: () => {},
      remove: async () => {
        throw Error("refused");
      },
    },
    () => true,
    { release: async () => [] },
  );

  expect((await recovery.remove("source")).erase).toBe("refused");
});

it.each([false, true])(
  "drains a play admitted during the second release, bounded=%s",
  async (bounded) => {
    let playing = true;
    let calls = 0;

    const remove = vi.fn(async () => {
      expect(playing).toBe(false);
    });

    const recovery = providerRecovery(
      {
        state: store<Sources>({ kind: "ready", sources: [] }),
        restore: async () => {},
        connect: async () => ({ kind: "cancelled" }),
        retry: () => {},
        remove,
      },
      () => true,
      {
        release: async () => {
          calls++;

          if (!playing) return [];
          playing = bounded || calls < 3;

          return [
            {
              attempt: String(calls),
              hold: { kind: "source", sourceId: "source" },
              outcome: "connections-closed",
            },
          ];
        },
      },
    );

    const result = await recovery.remove("source");

    if (bounded) {
      expect(result.erase).toBe("refused");
      expect(remove).not.toHaveBeenCalled();
      expect(calls).toBeLessThanOrEqual(5);
    } else {
      expect(result.erase).toBe("removed");
      expect(remove).toHaveBeenCalledOnce();
      expect(result.release).toHaveLength(3);
    }
  },
);
