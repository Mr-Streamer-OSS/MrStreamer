// Explicit native acceptance. The ordinary release-UI scenario never calls this workload.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type {
  AnalyticsRecord,
  CaptureEvent,
  StreamSummary,
} from "../../src/main/analytics/model.ts";
import { delay, type Page } from "./app.ts";
import { boundary, type Boundary } from "./analytics-boundary.ts";
import type { analyticsOptions } from "./analytics-options.ts";
import { installedTelemetryPair } from "./analytics-installed-pair.ts";
import { windowsDeleteLock } from "./analytics-windows-lock.ts";

type Target = { executable: string | undefined; version: string; source: string };
type Context = {
  options: ReturnType<typeof analyticsOptions>;
  evidence: string;
  abort: AbortSignal;
  candidate: Target;
  page(): Page;
  main(): Page;
  profile(): string;
  fresh(): Promise<void>;
  launch(target?: Target, local?: boolean): Promise<void>;
  connect(): Promise<void>;
  settings(): Promise<void>;
  verifyAbout(): Promise<void>;
  click(selector: string): Promise<void>;
  namedButton(selector: string, name: string, title?: boolean): Promise<void>;
  escape(): Promise<void>;
  snapshot(name: string): Promise<void>;
  preference(): Promise<Preferences>;
  quit(): Promise<void>;
  kill(): Promise<number>;
  waitFor(check: () => Promise<boolean>, timeoutMs?: number): Promise<void>;
  read(): Promise<AnalyticsRecord>;
  events(): CaptureEvent[];
  bodies: { body: string; at: number; closedAt?: number }[];
  capture(mode: "accept" | "reject" | "hold" | "hold-usage" | "offline"): Promise<void>;
  observations: Record<string, unknown>;
};
const checkbox = '[role="checkbox"][aria-label="Share basic usage statistics"]';

/** A repeated HTTP UUID is one logical event only when every received byte is identical. */
export function reconcileBodies(bodies: readonly string[]) {
  const events = new Map<string, string>();
  for (const body of bodies) {
    const event = JSON.parse(body) as { uuid: string };
    if (events.has(event.uuid))
      assert.equal(body, events.get(event.uuid), "UUID changed its wire body");
    else events.set(event.uuid, body);
  }
  return { deliveries: bodies.length, logicalEvents: events.size };
}

export async function runNativeTelemetry(c: Context) {
  const cases: {
    name: string;
    status: "running" | "passed" | "failed";
    started: number;
    ended?: number;
    proof?: unknown;
  }[] = [];
  c.observations.nativeCases = cases;
  c.observations.nativeLimits = [
    "Loopback only; native package and production acceptance require separately pinned real candidate runs.",
    "Filesystem holds are controlled promise delays around real rename, not physical slow-disk measurements.",
  ];
  const selected = c.options.nativeCase;
  let boundaryIndex = 0;
  const pending = (record: AnalyticsRecord) => record.summaries?.pending ?? [];
  const wires = (uuid: string) =>
    c.bodies.filter(({ body }) => (JSON.parse(body) as { uuid: string }).uuid === uuid);
  const journal = async () => {
    const event = (await c.read()).summaries?.unfinished?.event;
    assert(event, "No actual admitted durable journal");
    return event;
  };
  const saved = async (name: string) => {
    const state = await c.read();
    await writeFile(join(c.evidence, `${name}-record.json`), JSON.stringify(state, null, 2));
    return state;
  };
  const awake = async () => {
    await c.page().send("Emulation.setFocusEmulationEnabled", { enabled: true });
  };
  const fresh = async () => {
    await c.capture("accept");
    await c.fresh();
    await c.launch();
    await awake();
    await c.connect();
    await c.escape();
    await c.verifyAbout();
    await c.waitFor(
      async () => !!(await c.read()).installationId && (await c.read()).pending.length === 0,
    );
  };
  const restart = async () => {
    await c.launch();
    await awake();
    await c.verifyAbout();
  };
  const play = async () => {
    await c.escape();
    await c.namedButton("header button", "Live TV");
    await c.click('button[aria-label="Search"]');
    await c.page().send("Input.insertText", { text: "TEST | H.264 + AAC" });
    await c.waitFor(() =>
      c
        .page()
        .evaluate<boolean>(
          "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
        ),
    );
    for (const type of ["rawKeyDown", "keyUp"])
      await c.page().send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await c.waitFor(async () => !!(await c.read()).summaries?.unfinished);
    await c.waitFor(() =>
      c
        .page()
        .evaluate<boolean>(
          "!!document.querySelector('[data-view=watch]') && document.querySelector('video').videoWidth > 0 && !document.querySelector('video').paused",
        ),
    );
    return journal();
  };
  const home = async () => {
    await c.escape();
    await c.namedButton("header button", "Home");
  };
  const stop = async () => {
    await c.click('button[aria-label="Stop"]');
  };
  const recovered = async (event: StreamSummary) => {
    await c.waitFor(async () => wires(event.uuid).length > 0);
    const actual = c.events().find((item) => item.uuid === event.uuid);
    assert.deepEqual(actual, event, "Recovery changed the checkpoint event or fabricated time");
    assert.equal(
      c
        .events()
        .filter(
          (item) =>
            item.event === "stream_summary" &&
            item.properties.started_at === event.properties.started_at,
        ).length,
      wires(event.uuid).length,
      "Second UUID for the same admitted play",
    );
    await c.waitFor(
      async () => !pending(await c.read()).some((item) => item.event.uuid === event.uuid),
    );
    return { checkpoint: event, ...reconcileBodies(wires(event.uuid).map((wire) => wire.body)) };
  };
  const killAt = async (probe: Awaited<ReturnType<typeof boundary>>) => {
    await c.waitFor(async () => !!(await probe.hit()), 1500);
    const hit = await probe.hit();
    assert(hit);
    // Retain the real before/after bytes externally before killing main. Never restore them.
    await writeFile(
      join(c.evidence, `boundary-${++boundaryIndex}-${hit.phase}.json`),
      JSON.stringify(hit, null, 2),
    );
    assert(Date.now() - hit.at < 1500, "Missed the unchanged serializer deadline");
    const killedAt = await c.kill();
    assert(killedAt - hit.at < 1500, "Main kill completed after the serializer deadline");
    return hit;
  };
  const run = async (name: string, work: () => Promise<unknown>) => {
    if (selected && selected !== name) return;
    c.abort.throwIfAborted();
    const receipt: (typeof cases)[number] = { name, status: "running", started: Date.now() };
    cases.push(receipt);
    console.log(`Native telemetry: ${name}`);
    try {
      receipt.proof = await work();
      receipt.status = "passed";
    } catch (error) {
      receipt.status = "failed";
      throw error;
    } finally {
      receipt.ended = Date.now();
      await writeFile(join(c.evidence, "native-cases.json"), JSON.stringify(cases, null, 2));
    }
  };

  // A Windows published pair installs candidate before any app starts, and owns replacement.
  const pair = c.options.installedPair
    ? await installedTelemetryPair(c.options.installedPair, c.evidence, c.candidate)
    : null;
  if (pair) await pair.select("candidate");
  let primaryError: unknown;
  let failed = false;
  const cleanupErrors: string[] = [];
  try {
    await run("consent", async () => {
      await fresh();
      const before = await saved("consent-on");
      await play();
      await c.capture("hold");
      await stop();
      await c.waitFor(async () =>
        c.bodies.some(
          ({ body, closedAt }) =>
            JSON.parse(body).distinct_id === before.installationId &&
            JSON.parse(body).event === "stream_summary" &&
            !closedAt,
        ),
      );
      await play();
      assert((await c.read()).summaries?.unfinished, "No active journal at opt-out");
      await c.escape();
      await c.settings();
      await c.waitFor(async () =>
        c.bodies.some(
          ({ body, closedAt }) =>
            JSON.parse(body).distinct_id === before.installationId &&
            JSON.parse(body).event === "stream_summary" &&
            closedAt === undefined,
        ),
      );
      const from = c.bodies.length;
      const held = c.bodies.findLast(
        ({ body, closedAt }) =>
          JSON.parse(body).distinct_id === before.installationId &&
          JSON.parse(body).event === "stream_summary" &&
          closedAt === undefined,
      );
      assert(held, "No received request held at opt-out");
      const optedOutAt = Date.now();
      await c.click(checkbox);
      await c.waitFor(async () => !(await c.preference()).analyticsEnabled);
      await c.waitFor(async () =>
        c.bodies
          .filter(({ body }) => JSON.parse(body).distinct_id === before.installationId)
          .every((wire) => wire.closedAt !== undefined),
      );
      assert.equal(c.bodies.length, from, "Opt-out sent new work");
      assert(
        held.closedAt !== undefined && held.closedAt >= optedOutAt && held.closedAt - held.at < 900,
        "Held request reached its ordinary HTTP timeout instead of being aborted by opt-out",
      );
      const disabled = await saved("consent-off");
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.summaries, undefined);
      assert.equal(disabled.pending.length, 0);
      await c.quit();
      await restart();
      await c.settings();
      await delay(1200);
      assert.equal((await c.preference()).analyticsEnabled, false);
      assert.equal(c.bodies.length, from);
      await c.snapshot("native-consent-off");
      await c.click(checkbox);
      await c.waitFor(async () => !!(await c.preference()).analyticsEnabled);
      await delay(1200);
      const enabled = await saved("consent-reenabled");
      assert.equal(enabled.installationId, before.installationId);
      assert.equal(enabled.firstSeen, before.firstSeen);
      assert.equal(enabled.lastDay, before.lastDay);
      assert.equal(c.bodies.length, from);
      await c.capture("accept");
      await c.quit();
      return {
        identity: before.installationId,
        disabled,
        enabled,
        disabledCaptures: 0,
        optedOutAt,
        heldRequest: held,
      };
    });

    await run("offline", async () => {
      await fresh();
      await play();
      await c.capture("offline");
      await stop();
      await c.waitFor(async () =>
        pending(await c.read()).some(
          (item) =>
            item.event.event === "stream_summary" && item.failures > 0 && item.attempts === 0,
        ),
      );
      const kept = pending(await saved("offline-ended")).find(
        (item) => item.event.event === "stream_summary",
      )!;
      assert.equal(wires(kept.event.uuid).length, 0);
      await c.quit();
      await restart();
      assert(pending(await c.read()).some((item) => item.event.uuid === kept.event.uuid));
      await c.capture("accept");
      await c.waitFor(async () => wires(kept.event.uuid).length === 1);
      assert.deepEqual(
        c.events().find((event) => event.uuid === kept.event.uuid),
        kept.event,
      );
      await c.quit();
      return { retained: kept, delivered: wires(kept.event.uuid) };
    });

    await run("checkpoint", async () => {
      const proofs: unknown[] = [];
      for (const phase of ["before", "after"] as const) {
        await fresh();
        const admitted = await play();
        await delay(8000);
        const probe = await boundary(c.main(), c.profile());
        await probe.arm({ kind: "checkpoint", phase, uuid: admitted.uuid });
        await home();
        const hit = await killAt(probe);
        const disk = await saved(`checkpoint-${phase}-killed`);
        const expected = (phase === "before" ? hit.before : hit.after).summaries!.unfinished!.event;
        assert.deepEqual(disk.summaries?.unfinished?.event, expected);
        if (phase === "after") assert(expected.properties.watch_duration_seconds >= 7);
        const deadFrom = Date.now();
        await delay(2000);
        await restart();
        proofs.push({ phase, deadMs: Date.now() - deadFrom, ...(await recovered(expected)) });
        await c.quit();
      }
      return proofs;
    });

    await run("periodic", async () => {
      await fresh();
      const admitted = await play();
      const start = Date.now();
      // One actual counted five-minute run, separate from the normal five-minute UI budget.
      await c.waitFor(
        async () => (await journal()).properties.watch_duration_seconds >= 300,
        330_000,
      );
      const checkpoint = await journal();
      assert.equal(checkpoint.uuid, admitted.uuid);
      assert(Date.now() - start >= 295_000, "Periodic checkpoint used fabricated elapsed time");
      const checkpointAt = Date.now();
      const usage = c
        .events()
        .filter(
          (event) => event.event === "usage_window" && event.distinct_id === checkpoint.distinct_id,
        );
      assert(
        usage.some((event) => {
          if (event.event !== "usage_window") return false;
          const end = Date.parse(event.properties.window_end);
          return (
            end >= start &&
            end <= checkpointAt &&
            end % 300_000 === 0 &&
            wires(event.uuid).some((wire) => wire.at >= start && wire.at <= checkpointAt)
          );
        }),
        "No actual five-minute UTC window ended and transmitted inside the measured run",
      );
      await saved("periodic-checkpoint");
      await c.snapshot("periodic-watch");
      await c.kill();
      await restart();
      const proof = await recovered(checkpoint);
      await c.quit();
      return { start, checkpointAt, wallMs: checkpointAt - start, usage, ...proof };
    });

    await run("seal-send-ack", async () => {
      const proofs: unknown[] = [];
      for (const spec of [
        { kind: "seal", phase: "before" },
        { kind: "seal", phase: "after" },
        { kind: "reserve", phase: "before" },
        { kind: "reserve", phase: "after" },
        { kind: "retire", phase: "before" },
        { kind: "retire", phase: "after" },
      ] satisfies Boundary[]) {
        await fresh();
        const admitted = await play();
        await delay(1100);
        const probe = await boundary(c.main(), c.profile());
        await probe.arm({ ...spec, uuid: admitted.uuid });
        await stop();
        const hit = await killAt(probe);
        const state = await saved(`${spec.kind}-${spec.phase}-killed`);
        const expectedState = spec.phase === "before" ? hit.before : hit.after;
        assert.deepEqual(
          state,
          expectedState,
          "Actual committed atomic state differs from boundary",
        );
        const queued = pending(expectedState).find((item) => item.event.uuid === admitted.uuid);
        const expected = expectedState.summaries?.unfinished?.event ?? queued?.event;
        const before = wires(admitted.uuid).length;
        if (spec.kind === "reserve") {
          assert.equal(before, 0);
          assert.equal(queued?.attempts, spec.phase === "after" ? 1 : 0);
        }
        if (spec.kind === "retire") assert.equal(before, 1, "Ack case never received a real body");
        await restart();
        if (spec.kind === "retire" && spec.phase === "after") {
          await delay(2200);
          assert.equal(wires(admitted.uuid).length, before);
        } else {
          assert(expected);
          await c.waitFor(async () => wires(admitted.uuid).length > before);
          assert.deepEqual(
            c.events().findLast((event) => event.uuid === admitted.uuid),
            expected,
          );
        }
        const delivery = reconcileBodies(wires(admitted.uuid).map((wire) => wire.body));
        assert(
          c
            .events()
            .filter(
              (event) =>
                event.event === "stream_summary" &&
                event.properties.started_at === admitted.properties.started_at,
            )
            .every((event) => event.uuid === admitted.uuid),
        );
        proofs.push({ spec, hit, delivery });
        await c.quit();
      }
      return proofs;
    });

    await run("ambiguous", async () => {
      await fresh();
      const admitted = await play();
      await c.capture("hold");
      await stop();
      await c.waitFor(async () => wires(admitted.uuid).length === 1);
      const held = await saved("body-held");
      assert.equal(pending(held).find((item) => item.event.uuid === admitted.uuid)?.attempts, 1);
      assert.equal(wires(admitted.uuid)[0]!.closedAt, undefined);
      const killedAt = await c.kill();
      assert(
        killedAt - wires(admitted.uuid)[0]!.at < 1000,
        "Main was not killed while its first body was held",
      );
      await restart();
      await c.waitFor(async () => wires(admitted.uuid).length === 3);
      await c.waitFor(
        async () => !pending(await c.read()).some((item) => item.event.uuid === admitted.uuid),
      );
      const replay = reconcileBodies(wires(admitted.uuid).map((wire) => wire.body));
      assert.deepEqual(replay, { deliveries: 3, logicalEvents: 1 });
      await c.quit();
      await restart();
      await delay(2200);
      assert.equal(wires(admitted.uuid).length, 3);
      await c.quit();

      // Stage the real dialog while the first request is held. Admit the direct incident
      // before its first two-second backoff, with no navigation left inside that interval.
      await fresh();
      const priority = await play();
      await c.capture("hold");
      await stop();
      await c.escape();
      await c.namedButton("header button", "Movies");
      await c.namedButton("nav button", "All movies");
      await c.namedButton("button[title]", "Missing file", true);
      const preparedAt = Date.now();
      await c.namedButton('[role="dialog"] button', "Play");
      await c.waitFor(async () =>
        c
          .events()
          .some(
            (event) => event.event === "stream_error" && event.distinct_id === priority.distinct_id,
          ),
      );
      await c.waitFor(async () => wires(priority.uuid).length === 3);
      const incident = c
        .events()
        .find(
          (event) => event.event === "stream_error" && event.distinct_id === priority.distinct_id,
        );
      assert(incident);
      assert(
        wires(priority.uuid)[0]!.closedAt !== undefined &&
          preparedAt <= wires(priority.uuid)[0]!.closedAt!,
        "Navigation was not staged while the first request was held",
      );
      assert(
        wires(incident.uuid)[0]!.at < wires(priority.uuid)[1]!.at,
        "Ready direct incident waited for summary's first two-second backoff",
      );
      await c.waitFor(
        async () => !pending(await c.read()).some((item) => item.event.uuid === priority.uuid),
      );
      const proof = reconcileBodies(wires(priority.uuid).map((wire) => wire.body));
      assert.equal(proof.deliveries, 3);
      assert.equal(proof.logicalEvents, 1);
      await c.quit();
      await restart();
      assert(!pending(await c.read()).some((item) => item.event.uuid === priority.uuid));
      await delay(2200);
      assert.equal(wires(priority.uuid).length, 3);
      await c.quit();
      return { held, killedAt, replay, priority: { preparedAt, ...proof } };
    });

    await run("quit", async () => {
      await fresh();
      const admitted = await play();
      // Accept the window-close summary; hold only the usage fragment sealed by will-quit.
      // This distinguishes analytics.close's allowance from an earlier playback request.
      await c.capture("hold-usage");
      const marker = join(c.evidence, "native-will-quit.json");
      await c
        .main()
        .evaluate(
          `(async () => { const {app}=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const fs=process.getBuiltinModule('fs'); app.once('will-quit',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({at:Date.now()}))); })()`,
        );
      await c.quit();
      const at = (JSON.parse(await readFile(marker, "utf8")) as { at: number }).at;
      const held = c.bodies.find((wire) => {
        const event = JSON.parse(wire.body) as CaptureEvent;
        return (
          event.distinct_id === admitted.distinct_id &&
          event.event === "usage_window" &&
          wire.at >= at
        );
      });
      assert(
        held?.closedAt,
        "Quit did not send and close its actual held usage request after will-quit",
      );
      // 500 ms product allowance plus at most 250 ms for OS/socket observation. A natural
      // 1000 ms transport timeout cannot pass. Whole-app teardown has its own strict check.
      assert(
        held.closedAt - at <= 750,
        "Analytics quit exceeded 500 ms + 250 ms observation tolerance",
      );
      const uuid = (JSON.parse(held.body) as CaptureEvent).uuid;
      const retained = pending(await saved("quit-held")).find((item) => item.event.uuid === uuid);
      assert(retained, "Quit lost its actual final outbox");
      await c.capture("accept");
      await restart();
      await c.waitFor(async () => wires(uuid).length === 2);
      assert.equal(reconcileBodies(wires(uuid).map((wire) => wire.body)).logicalEvents, 1);
      await c.quit();
      await fresh();
      const future = await play();
      await c.capture("reject");
      await stop();
      await c.waitFor(async () =>
        pending(await c.read()).some(
          (item) => item.event.uuid === future.uuid && Date.parse(item.nextAttemptAt) > Date.now(),
        ),
      );
      const from = wires(future.uuid).length;
      const closing = Date.now();
      await c.quit();
      assert.equal(wires(future.uuid).length, from, "Quit bypassed a persisted future backoff");
      return {
        markerAt: at,
        requestAbortedAfterMs: held.closedAt - at,
        final: retained,
        backoffQuitAt: closing,
      };
    });

    await run("slow-write", async () => {
      await fresh();
      await play();
      await delay(1200);
      const before = await c.read();
      const probe = await boundary(c.main(), c.profile());
      await probe.arm({ kind: "checkpoint", phase: "before" });
      await home();
      await c.waitFor(async () => !!(await probe.hit()), 1500);
      const hit = await probe.hit();
      assert(hit);
      await delay(Math.max(0, 1650 - (Date.now() - hit.at)));
      await c.settings();
      await c.click(checkbox);
      await c.waitFor(() =>
        c.page().evaluate<boolean>("!!document.querySelector('.text-destructive')"),
      );
      await c.snapshot("slow-write-fail-closed");
      assert.equal((await c.read()).installationId, before.installationId);
      assert.equal((await c.read()).enabled, before.enabled);
      const from = c.bodies.length;
      await probe.release();
      await delay(1200);
      assert.equal(c.bodies.length, from, "Late write resumed capture");
      const measurements = await probe.measurements();
      assert(measurements.length > 0);
      await probe.restore();
      await c.quit();
      await restart();
      assert.equal((await c.read()).installationId, before.installationId);
      assert.equal((await c.read()).enabled, before.enabled);
      await c.quit();
      return { injectedPromiseHold: true, deadlineMs: 1500, hit, measurements };
    });

    if (process.platform === "win32")
      await run("windows-rename", async () => {
        await fresh();
        await play();
        const probe = await boundary(c.main(), c.profile());
        await delay(1200);
        await home();
        await c.waitFor(async () => (await probe.measurements()).length > 0);
        const normal = await probe.measurements();
        await c.namedButton("button", "Watch");
        await delay(1200);
        const prior = await readFile(join(c.profile(), "analytics.json"), "utf8");
        const lock = await windowsDeleteLock(c.profile());
        try {
          await home();
          await c.waitFor(async () =>
            (await probe.measurements()).some((entry) => entry.code !== null),
          );
          assert.equal(await readFile(join(c.profile(), "analytics.json"), "utf8"), prior);
          const failedTemps = await Promise.all(
            (await readdir(c.profile()))
              .filter((name) => /^analytics\.json\.[a-f0-9-]{36}\.tmp$/.test(name))
              .map(async (name) => ({
                name,
                record: JSON.parse(
                  await readFile(join(c.profile(), name), "utf8"),
                ) as AnalyticsRecord,
              })),
          );
          assert(
            failedTemps.some(
              ({ record }) =>
                (record.summaries?.unfinished?.event.properties.watch_duration_seconds ?? 0) >
                (JSON.parse(prior) as AnalyticsRecord).summaries!.unfinished!.event.properties
                  .watch_duration_seconds,
            ),
            "The failed real rename did not contain the newly counted checkpoint",
          );
          await writeFile(
            join(c.evidence, "windows-failed-checkpoint-temps.json"),
            JSON.stringify(failedTemps, null, 2),
          );
          await c.settings();
          await c.click(checkbox);
          await c.waitFor(() =>
            c.page().evaluate<boolean>("!!document.querySelector('.text-destructive')"),
          );
          await c.snapshot("windows-rename-failed");
        } finally {
          await lock.close();
        }
        const from = c.bodies.length;
        await delay(1200);
        assert.equal(c.bodies.length, from);
        const failed = await probe.measurements();
        await probe.restore();
        await c.quit();
        await restart();
        assert.equal((await c.read()).installationId, JSON.parse(prior).installationId);
        assert.equal((await c.read()).enabled, JSON.parse(prior).enabled);
        await c.quit();
        return { normalRename: normal, failedRename: failed, lock: lock.ready };
      });

    const prior = pair
      ? pair.prior
      : c.options.priorExecutable
        ? {
            executable: c.options.priorExecutable,
            version: "0.0.15",
            source: c.options.priorSource!,
          }
        : null;
    if (prior)
      await run("compatibility", async () => {
        const select = async (which: "stable" | "candidate", local = true) => {
          await c.quit();
          if (pair) await pair.select(which);
          await c.launch(which === "stable" ? prior : c.candidate, local);
          await awake();
          await c.waitFor(() =>
            c
              .page()
              .evaluate<boolean>(
                "!!document.querySelector('header') || document.querySelectorAll('form input').length >= 3",
              ),
          );
          if (await c.page().evaluate<boolean>("!!document.querySelector('header')"))
            await c.verifyAbout();
        };
        const proofs: unknown[] = [];
        // Profiles are created by actual binaries. There is no seeded crash snapshot.
        for (const variant of [
          "legacy-queue",
          "off",
          "write",
          "opt-out",
          "reenable",
          "no-write",
        ] as const) {
          await c.capture("accept");
          await c.fresh();
          if (variant === "legacy-queue" || variant === "off") {
            await select("stable");
            await c.connect();
            await c.escape();
            await c.verifyAbout();
            const identity = (await c.read()).installationId;
            if (variant === "off") {
              await c.settings();
              await c.click(checkbox);
              await c.waitFor(async () => !(await c.read()).enabled);
            } else {
              await c.capture("offline");
              await c.settings();
              await c.waitFor(async () =>
                (await c.read()).pending.some((item) => item.event.event === "feature_opened"),
              );
            }
            const old = await saved(`compat-${variant}-015`);
            // .15 deliberately skips backoff at quit and spends all remaining refused-connect
            // attempts. Kill its actual main with the admitted queue still durable instead.
            if (variant === "legacy-queue") {
              await c.kill();
              assert.deepEqual((await c.read()).pending, old.pending);
            } else await c.quit();
            await c.capture("accept");
            const from = c.bodies.length;
            await select("candidate");
            assert.equal((await c.read()).installationId, identity);
            assert.equal((await c.read()).enabled, old.enabled);
            if (variant === "legacy-queue") {
              const event = old.pending.find(
                (item) => item.event.event === "feature_opened",
              )!.event;
              await c.waitFor(async () => wires(event.uuid).length > 0);
              assert.deepEqual(
                c.events().find((item) => item.uuid === event.uuid),
                event,
              );
            } else {
              await delay(1200);
              assert.equal(c.bodies.length, from);
            }
            proofs.push({ variant, old, after: await saved(`compat-${variant}-return`) });
          } else {
            await select("candidate");
            await c.connect();
            await c.escape();
            await c.verifyAbout();
            await play();
            await c.capture("offline");
            await stop();
            await c.waitFor(async () =>
              pending(await c.read()).some(
                (item) =>
                  item.event.event === "stream_summary" && item.attempts === 0 && item.failures > 0,
              ),
            );
            const before = await saved(`compat-${variant}-before`);
            await c.quit();
            const bytes = await readFile(join(c.profile(), "analytics.json"), "utf8");
            await select("stable", variant !== "no-write");
            assert.equal((await c.preference()).analyticsEnabled, true);
            assert.equal((await c.read()).installationId, before.installationId);
            await c.verifyAbout();
            if (variant === "no-write") {
              await c.quit();
              assert.equal(await readFile(join(c.profile(), "analytics.json"), "utf8"), bytes);
            } else {
              await c.capture("accept");
              await c.settings();
              if (variant === "opt-out" || variant === "reenable") {
                await c.click(checkbox);
                await c.waitFor(async () => !(await c.read()).enabled);
                if (variant === "reenable") {
                  await c.click(checkbox);
                  await c.waitFor(async () => (await c.read()).enabled);
                }
              } else
                await c.waitFor(async () =>
                  c
                    .events()
                    .some(
                      (event) =>
                        event.event === "feature_opened" &&
                        event.properties.app_version === "0.0.15" &&
                        event.distinct_id === before.installationId,
                    ),
                );
              await c.waitFor(async () => !(await c.read()).summaries);
            }
            await select("candidate");
            await c.capture("accept");
            assert.equal((await c.read()).installationId, before.installationId);
            assert.equal((await c.read()).enabled, variant !== "opt-out");
            if (variant === "no-write") {
              for (const item of pending(before)) {
                await c.waitFor(async () => wires(item.event.uuid).length > 0);
                assert.deepEqual(
                  c.events().find((event) => event.uuid === item.event.uuid),
                  item.event,
                );
              }
            } else {
              await delay(2200);
              for (const item of pending(before))
                assert.equal(
                  wires(item.event.uuid).length,
                  0,
                  "Unsupported work revived after an old-build write",
                );
            }
            proofs.push({ variant, before, after: await saved(`compat-${variant}-after`) });
          }
          await c.quit();
        }
        return proofs;
      });
    assert(cases.length > 0, "Unknown or inapplicable --native-case");
    c.events(); // Validate every raw decoded body, including duplicates, against the wire allowlist.
    c.observations.nativeReconciliation = reconcileBodies(c.bodies.map((wire) => wire.body));
    c.observations.nativeCoverage = {
      selected: selected ?? "all applicable core cases",
      compatibility: !!prior,
      windows: process.platform === "win32",
      installed: !!c.candidate.executable,
      productionEvidence:
        "Separately owned by the release runner; local synthetic captures do not establish production ingestion",
      pending: [
        ...(!prior
          ? ["installed .15 compatibility requires --prior-executable or --installed-pair"]
          : []),
        ...(!c.candidate.executable
          ? ["source-build evidence does not close installed native acceptance"]
          : []),
      ],
    };
    pair?.accepted();
  } catch (error) {
    primaryError = error;
    failed = true;
  } finally {
    for (const close of [
      () => c.quit(),
      async () => {
        if (pair) await pair.close();
      },
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    c.observations.nativeCleanupErrors = cleanupErrors;
  }
  if (failed) throw primaryError;
  if (cleanupErrors.length) throw new Error(cleanupErrors.join("\n"));
}
