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
      release: [
        {
          attempt: "attempt",
          hold: { kind: "source", sourceId: "source" },
          outcome: "unconfirmed",
        },
      ],
    });
    expect(events).toEqual(["release", "released", "erase"]);
    expect(discard).toHaveBeenCalledTimes(erase === "removed" ? 1 : 0);
  },
);
