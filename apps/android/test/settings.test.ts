import { afterEach, expect, it, vi } from "vitest";
import { setLanguage } from "@mrstreamer/core/i18n";

vi.mock("../src/platform/storage.ts", () => ({ readJsonStrict: vi.fn(), writeJson: vi.fn() }));

import { preferences } from "../src/platform/preferences.ts";
import { diagnosticsText } from "../src/settings/diagnostics.ts";
import { t } from "../src/settings/copy.ts";
import { androidAnalytics } from "../src/telemetry/analytics.ts";
import { recoveryAction, providerRecovery } from "../src/settings/recovery.ts";
import { store } from "../src/platform/store.ts";
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

it("reports a partial removal and only clears statistics once the last provider is removed", async () => {
  const source = {
    id: "source",
    kind: "m3u" as const,
    label: "example.invalid",
    channels: {
      kind: "failed" as const,
      error: { kind: "needs-secret" as const, subscriptionId: "source" },
    },
  };

  const state = store<Sources>({ kind: "ready", sources: [source] });
  const discard = vi.fn(() => true);
  let fails = true;

  const recovery = providerRecovery(
    {
      state,
      restore: async () => {},
      connect: async () => ({ kind: "cancelled" }),
      retry: () => {},
      remove: async () => {
        if (fails) throw new Error("registry refused");
        state.set({ kind: "ready", sources: [] });
      },
    },
    discard,
  );

  expect(recoveryAction(source)).toBe("enter-login");
  expect(await recovery.remove("source")).toBe("partial");
  expect(discard).not.toHaveBeenCalled();
  fails = false;
  expect(await recovery.remove("source")).toBe("removed");
  expect(discard).toHaveBeenCalledOnce();
});

it("captures only Android fields and aborts delivery when switched Off", async () => {
  const send = vi.fn(async (_event: unknown, _signal: AbortSignal) => "accepted" as const);

  const build = {
    os: "android" as const,
    os_major: 16,
    app_version: "0.1.0",
    app_build: "1",
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
    transport: { kind: "local", send },
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

it("lists exactly the generated licence manifest and full notices", async () => {
  const { licences, licenceCount, licenceAt } = await import("../src/settings/licences.ts");
  const { default: manifest } = await import("../licenses/manifest.json");
  expect(licenceCount).toBe(manifest.length);
  expect(licences).toEqual(manifest);
  expect(licenceCount).toBeGreaterThan(0);
  expect(licenceAt(-1)).toBeNull();
  expect(licenceAt(licenceCount)).toBeNull();

  for (const component of licences) {
    expect(component.name).not.toBe("");
    expect(component.version).not.toBe("");
    expect(component.licence).not.toBe("");
    expect(component.source).not.toBe("");
    expect(component.notice.length).toBeGreaterThan(50);
  }
});

it("uses the Android release major, version and build, with release-only production gating", async () => {
  const { androidBuild } = await import("../src/telemetry/model.ts");
  const { analyticsTransport } = await import("../src/telemetry/transport.ts");
  expect(androidBuild("16", "0.1.0", "1")).toEqual({
    os: "android",
    os_major: 16,
    app_version: "0.1.0",
    app_build: "1",
  });

  const config = {
    development: false,
    releaseBuild: "1",
    host: "https://eu.i.posthog.com",
    projectToken: "phc_example",
    localEndpoint: undefined,
  };

  expect(analyticsTransport(config)?.kind).toBe("production");
  expect(analyticsTransport({ ...config, development: true })).toBeNull();
  expect(analyticsTransport({ ...config, releaseBuild: undefined })).toBeNull();
  expect(analyticsTransport({ ...config, host: "https://example.invalid" })).toBeNull();
});
