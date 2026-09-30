// In-app updates and the release channel.
//
// Nothing happens on its own: the user checks, downloads and confirms the restart. The first run
// stores the build's own channel; after that only the user changes it, so a Nightly user who
// installs a stable build stays on Nightly.
//
// Switching a nightly build to Stable offers the newest stable release even when it is older,
// and installs it over the nightly like any update: this device's data stays.
import { join } from "node:path";
import { type } from "arktype";
import type { UpdatePhase, UpdateStatus } from "@mrstreamer/contracts/updates";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "@mrstreamer/contracts/version";
import {
  candidates,
  newestOn,
  type Candidate,
  type PublishedRelease,
} from "@mrstreamer/core/updates/feed";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

/** Downloads and installs releases: electron-updater in the app, a fake in tests. */
export interface Installer {
  /** Downloads and verifies the release in `feedUrl`. Rejects when `signal` aborts. */
  download(
    target: {
      readonly feedUrl: string;
      readonly version: string;
      readonly allowDowngrade: boolean;
    },
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Quits, installs the downloaded release and starts it. Rejects when the system refuses the
   * release, as macOS does when its signature doesn't match; otherwise the app quits first.
   */
  install(): Promise<void>;
}

export interface UpdatesDeps {
  readonly dataDir: string;
  /** The running build's version. */
  readonly installed: string;
  /** The update metadata this platform installs from, such as latest-mac.yml. */
  readonly metadataFile: string;
  readonly releases: () => Promise<readonly PublishedRelease[]>;
  readonly installer: Installer;
}

export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>;
    /**
     * Looks for the release the chosen channel offers this build. Only the latest check counts:
     * one that finishes after a newer check or a channel change leaves the state alone.
     */
    readonly check: Effect.Effect<UpdateStatus>;
    /**
     * Changes the channel and checks what it offers. An update the new channel doesn't receive,
     * such as a nightly after switching to Stable, is dropped: its download stops, and a
     * downloaded one won't install.
     */
    setChannel(next: Channel): Effect.Effect<UpdateStatus>;
    /**
     * Downloads the release the last check found, or again after a failed download or install.
     * Playback carries on meanwhile.
     */
    readonly download: Effect.Effect<UpdateStatus>;
    /** Stops a download in progress; the update goes back to available. */
    readonly cancel: Effect.Effect<void>;
    /** Installs the downloaded update. The user has confirmed the restart. */
    readonly restart: Effect.Effect<void>;
    /** The status after every change, such as a download's progress. */
    readonly changes: Stream.Stream<UpdateStatus>;
  }
>()("mrstreamer/Updates") {
  static readonly layer = (deps: UpdatesDeps) => Layer.effect(Updates, make(deps));
}

const SETTINGS_FILE = "updates.json";
const ChannelFile = type({ channel: "'stable' | 'nightly'" });

/** Whether a channel receives `version`: Nightly receives everything, Stable only stable releases. */
function receives(channel: Channel, version: string): boolean {
  return channel === "nightly" || !parseVersion(version)?.nightly;
}

function make(deps: UpdatesDeps) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<UpdateStatus>();
    const settingsPath = join(deps.dataDir, SETTINGS_FILE);
    // A development build without a release version counts as the oldest stable.
    const installed: Version = parseVersion(deps.installed) ?? {
      major: 0,
      minor: 0,
      patch: 0,
      nightly: null,
    };
    let channel: Promise<Channel> | null = null;
    /** The channel once known, for the checks that cannot wait for `channel`. */
    let chosen: Channel | null = null;
    let update: UpdatePhase = { kind: "idle" };
    let target: Candidate | null = null;
    /** The check whose result still counts; a newer check or a channel change voids it. */
    let checking: object | null = null;
    /** The download in flight; there is one installer. */
    let downloading: Fiber.Fiber<void, unknown> | null = null;
    /** The download whose outcome still counts; a channel change can void it. */
    let attempt: object | null = null;

    const getChannel = Effect.promise(() => {
      channel ??= readJsonFile(settingsPath, ChannelFile)
        .then(async (stored) => {
          if (stored) return stored.channel;
          const first = channelOf(installed);
          await writeJsonFile(settingsPath, { channel: first });
          return first;
        })
        // A channel the user picked while the file loaded wins.
        .then((read) => (chosen ??= read));
      return channel;
    });

    /** Whether the chosen channel still receives `version`, checked before downloading or installing it. */
    function wanted(version: string): boolean {
      return chosen !== null && receives(chosen, version);
    }

    const status = Effect.map(getChannel, (on): UpdateStatus => ({
      version: deps.installed,
      channel: on,
      update,
    }));

    const changed = Effect.flatMap(status, (now) => PubSub.publish(updates, now));

    /** Forgets an update the chosen channel no longer receives. */
    const drop = Effect.gen(function* () {
      target = null;
      update = { kind: "idle" };
      yield* changed;
      return yield* status;
    });

    const check = Effect.gen(function* () {
      if (update.kind === "downloading" || update.kind === "ready") return yield* status;
      const mine = {};
      checking = mine;
      update = { kind: "checking" };
      yield* changed;
      const on = yield* getChannel;
      const found = yield* Effect.tryPromise({
        try: () => deps.releases(),
        catch: (cause) => cause,
      }).pipe(
        diagnosed("check"),
        Effect.map((releases) => {
          const newest = newestOn(on, candidates(releases, deps.metadataFile));
          // A nightly build on Stable goes to the newest stable release, older or not.
          const offered =
            newest &&
            (compareVersions(newest.version, installed) > 0 ||
              (on === "stable" && installed.nightly !== null));
          return offered ? newest : null;
        }),
        Effect.result,
      );
      if (checking !== mine) return yield* status;
      checking = null;
      if (found._tag === "Failure") {
        target = null;
        update = { kind: "failed", step: "check", detail: reason(found.failure) };
      } else {
        target = found.success;
        update = found.success
          ? { kind: "available", version: formatVersion(found.success.version) }
          : { kind: "current" };
      }
      yield* changed;
      return yield* status;
    });

    return {
      status,
      check,

      setChannel: (next: Channel) =>
        Effect.gen(function* () {
          channel = Promise.resolve(next);
          chosen = next;
          checking = null;
          const staged = update.kind === "downloading" || update.kind === "ready" ? update : null;
          if (!staged || !receives(next, staged.version)) {
            attempt = null;
            target = null;
            update = { kind: "idle" };
            if (downloading) yield* Fiber.interrupt(downloading);
          }
          yield* Effect.promise(() => writeJsonFile(settingsPath, { channel: next }));
          yield* changed;
          return yield* check;
        }),

      download: Effect.gen(function* () {
        const retry = update.kind === "failed" && update.step !== "check";
        if ((update.kind !== "available" && !retry) || !target || downloading) {
          return yield* status;
        }
        const release = target;
        const version = formatVersion(release.version);
        if (!wanted(version)) return yield* drop;
        const mine = {};
        attempt = mine;
        // Set before anything waits, so a second download finds this one.
        update = { kind: "downloading", version, percent: 0 };
        // In the service's scope, so quitting stops it too. Known before the UI hears of it, so
        // a cancel always finds it.
        const fiber = yield* Effect.forkIn(
          Effect.tryPromise({
            try: (signal) =>
              deps.installer.download(
                {
                  feedUrl: release.feedUrl,
                  version,
                  allowDowngrade: compareVersions(release.version, installed) < 0,
                },
                (percent) => {
                  if (attempt !== mine || signal.aborted) return;
                  update = { kind: "downloading", version, percent };
                  if (chosen) {
                    PubSub.publishUnsafe(updates, {
                      version: deps.installed,
                      channel: chosen,
                      update,
                    });
                  }
                },
                signal,
              ),
            catch: (cause) => cause,
          }).pipe(diagnosed("download")),
          scope,
        );
        downloading = fiber;
        yield* changed;
        const exit = yield* Fiber.await(fiber);
        if (downloading === fiber) downloading = null;
        if (attempt !== mine) return yield* status;
        attempt = null;
        // A download that finishes after it was cancelled doesn't count either.
        if (Exit.isSuccess(exit)) update = { kind: "ready", version };
        else if (Cause.hasInterrupts(exit.cause)) update = { kind: "available", version };
        else
          update = { kind: "failed", step: "download", detail: reason(Cause.squash(exit.cause)) };
        yield* changed;
        return yield* status;
      }),

      cancel: Effect.suspend(() => (downloading ? Fiber.interrupt(downloading) : Effect.void)),

      restart: Effect.gen(function* () {
        if (update.kind !== "ready") return;
        if (!wanted(update.version)) {
          yield* drop;
          return;
        }
        const installing = yield* Effect.tryPromise({
          try: () => deps.installer.install(),
          catch: (cause) => cause,
        }).pipe(diagnosed("install"), Effect.result);
        if (installing._tag === "Failure") {
          update = { kind: "failed", step: "install", detail: reason(installing.failure) };
          yield* changed;
        }
      }),

      changes: Stream.fromPubSub(updates),
    };
  });
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
