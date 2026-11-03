import { type } from "arktype";
import { defined } from "@mrstreamer/core/defined";
import { statisticsConsent, type ConsentRecord } from "@mrstreamer/mobile/consent/statistics";
import {
  CaptureEvent,
  type AndroidBuild,
  type AndroidAction,
  type AndroidFeature,
} from "./model.ts";
import type { CaptureTransport } from "./transport.ts";

/** Android's current observations only. Every queued event must hold on disk before delivery. */
export function androidAnalytics(ports: {
  readonly load: () => unknown;
  readonly save: (record: ConsentRecord<CaptureEvent>) => boolean;
  readonly revocation?: { load(): boolean; save(pending: boolean): boolean };
  readonly uuid: () => string;
  readonly build: AndroidBuild;
  readonly transport: CaptureTransport | null;
}) {
  const consent = statisticsConsent<CaptureEvent>({
    load() {
      const value = ports.load();

      if (value === null) return null;

      const parsed = type({
        choice: "'on' | 'off' | null",
        installationId: "string.uuid | null",
        pending: CaptureEvent().array().atMostLength(64),
      })(value);

      if (parsed instanceof type.errors) throw new Error("Statistics unavailable.");

      if (parsed.pending.some((event) => event.distinct_id !== parsed.installationId))
        throw new Error("Statistics unavailable.");

      return parsed;
    },
    save: ports.save,
  });

  let revocationPending = false;

  try {
    revocationPending = ports.revocation?.load() ?? false;
  } catch {
    revocationPending = true;
  }

  if (revocationPending) revoke();

  function revoke() {
    revocationPending = true;
    ports.revocation?.save(true);
    const held = consent.configure(false);

    if (!held) return false;
    const cleared = ports.revocation?.save(false) ?? true;
    revocationPending = !cleared;

    return true;
  }

  let request: AbortController | null = null;
  let generation = 0;
  let lastMinute = -Infinity;
  let count = 0;

  async function pump() {
    if (revocationPending && !revoke()) return;

    if (request || !consent.enabled || !ports.transport) return;
    const event = consent.get().pending[0];

    if (!event) return;
    const revision = generation;
    const controller = new AbortController();
    request = controller;

    const result = await ports.transport
      .send(event, controller.signal)
      .catch(() => "retry" as const);

    if (request === controller) request = null;

    if (revision !== generation || !consent.enabled) return;

    // A failed request stays queued for the next observation or launch, without a retry loop.
    if (result === "retry") return;

    if (
      consent.replace({
        ...consent.get(),
        pending: consent.get().pending.filter((item) => item.uuid !== event.uuid),
      })
    )
      void pump();
  }

  function capture(name: AndroidAction | "feature_opened", feature?: AndroidFeature) {
    if (!consent.enabled || !ports.transport) return;
    const minute = Math.floor(Date.now() / 60_000);

    if (minute !== lastMinute) {
      lastMinute = minute;
      count = 0;
    }

    if (count++ >= 60) return;
    const record = consent.get();
    const identity = record.installationId ?? ports.uuid();

    const event = CaptureEvent()({
      uuid: ports.uuid(),
      distinct_id: identity,
      timestamp: new Date().toISOString(),
      event: name,
      properties: {
        ...ports.build,
        $process_person_profile: false,
        $geoip_disable: true,
        ...defined({ feature }),
      },
    });

    if (event instanceof type.errors) return;

    if (
      consent.replace({
        ...record,
        installationId: identity,
        pending: [...record.pending, event].slice(-64),
      })
    )
      void pump();
  }

  function stop() {
    generation++;
    request?.abort();
    request = null;
  }

  return {
    consent,
    configure(enabled: boolean) {
      stop();
      const revoked = !enabled || revocationPending ? revoke() : true;
      const held = enabled ? revoked && !revocationPending && consent.configure(true) : revoked;

      if (held && enabled) void pump();

      return held;
    },
    discard() {
      stop();

      if (revocationPending) return revoke();

      return consent.discard();
    },
    noteAction: (action: AndroidAction) => capture(action),
    noteFeature: (feature: AndroidFeature) => capture("feature_opened", feature),
    resume: pump,
  };
}
