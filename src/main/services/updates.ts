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
import type { UpdatePhase, UpdateStatus } from "../../shared/updates.ts";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "../../shared/version.ts";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { candidates, newestOn, type Candidate, type PublishedRelease } from "../updates/feed.ts";

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
  readonly onChanged: (status: UpdateStatus) => void;
}

const SETTINGS_FILE = "updates.json";
const Settings = type({ channel: "'stable' | 'nightly'" });

/** Whether a channel receives `version`: Nightly receives everything, Stable only stable releases. */
function receives(channel: Channel, version: string): boolean {
  return channel === "nightly" || !parseVersion(version)?.nightly;
}

export function createUpdates(deps: UpdatesDeps) {
  const settingsPath = join(deps.dataDir, SETTINGS_FILE);
  // A development build without a release version counts as the oldest stable.
  const installed: Version = parseVersion(deps.installed) ?? {
    major: 0,
    minor: 0,
    patch: 0,
    nightly: null,
  };
  let channel: Promise<Channel> | null = null;
  let update: UpdatePhase = { kind: "idle" };
  let target: Candidate | null = null;
  /** The download in flight; there is one installer. */
  let downloading: AbortController | null = null;
  /** The download whose outcome still counts; a channel change can void it. */
  let attempt: object | null = null;

  function getChannel(): Promise<Channel> {
    channel ??= readJsonFile(settingsPath, Settings).then(async (stored) => {
      if (stored) return stored.channel;
      const first = channelOf(installed);
      await writeJsonFile(settingsPath, { channel: first });
      return first;
    });
    return channel;
  }

  async function status(): Promise<UpdateStatus> {
    return { version: deps.installed, channel: await getChannel(), update };
  }

  function changed(): void {
    void status().then(deps.onChanged);
  }

  function reason(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  /** Looks for the release the chosen channel offers this build. */
  async function check(): Promise<UpdateStatus> {
    if (update.kind === "downloading" || update.kind === "ready") return status();
    update = { kind: "checking" };
    changed();
    try {
      const chosen = await getChannel();
      const newest = newestOn(chosen, candidates(await deps.releases(), deps.metadataFile));
      // A nightly build on Stable goes to the newest stable release, older or not.
      const offered =
        newest &&
        (compareVersions(newest.version, installed) > 0 ||
          (chosen === "stable" && installed.nightly !== null));
      target = offered ? newest : null;
      update = target
        ? { kind: "available", version: formatVersion(target.version) }
        : { kind: "current" };
    } catch (cause) {
      update = { kind: "failed", step: "check", detail: reason(cause) };
    }
    changed();
    return status();
  }

  return {
    status,
    check,

    /**
     * Changes the channel and checks what it offers. An update the new channel doesn't receive,
     * such as a nightly after switching to Stable, is dropped: its download stops, and a
     * downloaded one won't install.
     */
    async setChannel(next: Channel): Promise<UpdateStatus> {
      channel = Promise.resolve(next);
      const staged = update.kind === "downloading" || update.kind === "ready" ? update : null;
      if (!staged || !receives(next, staged.version)) {
        if (staged?.kind === "downloading") downloading?.abort();
        attempt = null;
        target = null;
        update = { kind: "idle" };
      }
      await writeJsonFile(settingsPath, { channel: next });
      changed();
      return check();
    },

    /**
     * Downloads the release the last check found, or again after a failed download or install.
     * Playback carries on meanwhile.
     */
    async download(): Promise<UpdateStatus> {
      const retry = update.kind === "failed" && update.step !== "check";
      if ((update.kind !== "available" && !retry) || !target || downloading) return status();
      const release = target;
      const version = formatVersion(release.version);
      const controller = new AbortController();
      const mine = {};
      downloading = controller;
      attempt = mine;
      update = { kind: "downloading", version, percent: 0 };
      changed();
      try {
        await deps.installer.download(
          {
            feedUrl: release.feedUrl,
            version,
            allowDowngrade: compareVersions(release.version, installed) < 0,
          },
          (percent) => {
            if (attempt !== mine || controller.signal.aborted) return;
            update = { kind: "downloading", version, percent };
            changed();
          },
          controller.signal,
        );
        if (attempt !== mine) return status();
        // A download that finishes after it was cancelled still doesn't count.
        update = controller.signal.aborted
          ? { kind: "available", version }
          : { kind: "ready", version };
      } catch (cause) {
        if (attempt !== mine) return status();
        update = controller.signal.aborted
          ? { kind: "available", version }
          : { kind: "failed", step: "download", detail: reason(cause) };
      } finally {
        if (downloading === controller) downloading = null;
      }
      attempt = null;
      changed();
      return status();
    },

    /** Stops a download in progress; the update goes back to available. */
    cancel(): void {
      downloading?.abort();
    },

    /** Installs the downloaded update. The user has confirmed the restart. */
    async restart(): Promise<void> {
      if (update.kind !== "ready") return;
      try {
        await deps.installer.install();
      } catch (cause) {
        update = { kind: "failed", step: "install", detail: reason(cause) };
        changed();
      }
    },
  };
}
