// In-app updates, the release channel, and starting fresh on Stable.
//
// Nothing happens on its own: the user checks, downloads and confirms the restart. The first run
// stores the build's own channel; after that only the user changes it, so a Nightly user who
// installs a stable build stays on Nightly.
//
// Starting fresh downloads and checks Stable first; cancelling or a failure changes nothing.
// Only after the final confirmation does it write a marker, erase this device's data and
// install. The next start calls `finishFreshStart` before anything reads the data: it completes
// an erase a crash interrupted and says whether Stable arrived.
import { join } from "node:path";
import { type } from "arktype";
import type { FreshStart, UpdatePhase, UpdateStatus } from "../../shared/updates.ts";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "../../shared/version.ts";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
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
  /** Quits, installs the downloaded release and starts it. */
  install(): void;
}

export interface UpdatesDeps {
  readonly dataDir: string;
  /** The running build's version. */
  readonly installed: string;
  /** The update metadata this platform installs from, such as latest-mac.yml. */
  readonly metadataFile: string;
  readonly releases: () => Promise<readonly PublishedRelease[]>;
  readonly installer: Installer;
  /** Erases this device's data; `eraseDeviceData` plus whatever the browser session keeps. */
  readonly erase: () => Promise<void>;
  /** What `finishFreshStart` found at this start. */
  readonly freshOutcome: FreshStart;
  readonly onChanged: (status: UpdateStatus) => void;
}

const SETTINGS_FILE = "updates.json";
const MARKER_FILE = "fresh-start.json";
/** This device's data: the subscription and its sealed password, preferences and watch history, the channel list, the update settings. */
const DEVICE_FILES = ["subscription.json", "preferences.json", "catalogue.json", SETTINGS_FILE];

const Settings = type({ channel: "'stable' | 'nightly'" });
const Marker = type({ version: "string" });

/** Deletes this device's data files. Safe to repeat. */
export async function eraseDeviceData(dataDir: string): Promise<void> {
  await Promise.all(DEVICE_FILES.map((file) => removeFile(join(dataDir, file))));
}

/**
 * Finishes a fresh start the previous run began. Call before anything reads the data folder.
 * Returns `not-installed` when the data was erased but Stable did not replace this build.
 */
export async function finishFreshStart(dataDir: string, installed: string): Promise<FreshStart> {
  const marker = await readJsonFile(join(dataDir, MARKER_FILE), Marker);
  if (!marker) return { kind: "idle" };
  await eraseDeviceData(dataDir);
  await writeJsonFile(join(dataDir, SETTINGS_FILE), { channel: "stable" });
  await removeFile(join(dataDir, MARKER_FILE));
  return installed === marker.version
    ? { kind: "idle" }
    : { kind: "not-installed", version: marker.version };
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
  let fresh: FreshStart = deps.freshOutcome;
  let aheadOf: string | null = null;
  let target: Candidate | null = null;
  /** The one download in flight, update or fresh start: there is one installer. */
  let downloading: AbortController | null = null;

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
    return {
      version: deps.installed,
      channel: await getChannel(),
      aheadOf,
      update,
      fresh,
    };
  }

  function changed(): void {
    void status().then(deps.onChanged);
  }

  function reason(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  /** Runs one download at a time, reporting progress through `onPercent`. */
  async function fetchRelease(
    release: Candidate,
    allowDowngrade: boolean,
    onPercent: (percent: number) => void,
  ): Promise<"done" | "cancelled"> {
    const controller = new AbortController();
    downloading = controller;
    try {
      await deps.installer.download(
        { feedUrl: release.feedUrl, version: formatVersion(release.version), allowDowngrade },
        (percent) => {
          if (downloading === controller) onPercent(percent);
        },
        controller.signal,
      );
      return "done";
    } catch (cause) {
      if (controller.signal.aborted) return "cancelled";
      throw cause;
    } finally {
      if (downloading === controller) downloading = null;
    }
  }

  return {
    status,

    /** Changes the channel. Takes effect at the next check; nothing is installed or removed. */
    async setChannel(next: Channel): Promise<UpdateStatus> {
      await writeJsonFile(settingsPath, { channel: next });
      channel = Promise.resolve(next);
      if (update.kind !== "downloading" && update.kind !== "ready") update = { kind: "idle" };
      aheadOf = null;
      changed();
      return status();
    },

    /** Looks for a newer release on the chosen channel. */
    async check(): Promise<UpdateStatus> {
      if (downloading || update.kind === "ready") return status();
      update = { kind: "checking" };
      changed();
      try {
        const available = candidates(await deps.releases(), deps.metadataFile);
        const chosen = await getChannel();
        const newest = newestOn(chosen, available);
        const newestStable = newestOn("stable", available);
        aheadOf =
          chosen === "stable" &&
          installed.nightly &&
          newestStable &&
          compareVersions(newestStable.version, installed) < 0
            ? formatVersion(newestStable.version)
            : null;
        target = newest && compareVersions(newest.version, installed) > 0 ? newest : null;
        update = target
          ? { kind: "available", version: formatVersion(target.version) }
          : { kind: "current" };
      } catch (cause) {
        update = { kind: "failed", step: "check", detail: reason(cause) };
      }
      changed();
      return status();
    },

    /** Downloads the release the last check found. Playback carries on meanwhile. */
    async download(): Promise<UpdateStatus> {
      if (update.kind !== "available" || !target || downloading) return status();
      const release = target;
      const version = formatVersion(release.version);
      update = { kind: "downloading", version, percent: 0 };
      fresh = fresh.kind === "not-installed" ? fresh : { kind: "idle" };
      changed();
      try {
        const outcome = await fetchRelease(release, false, (percent) => {
          update = { kind: "downloading", version, percent };
          changed();
        });
        update = outcome === "done" ? { kind: "ready", version } : { kind: "available", version };
      } catch (cause) {
        update = { kind: "failed", step: "download", detail: reason(cause) };
      }
      changed();
      return status();
    },

    /** Stops a download in progress; the update or fresh start goes back a step. */
    cancel(): void {
      downloading?.abort();
    },

    /** Installs the downloaded update. The user has confirmed the restart. */
    restart(): void {
      if (update.kind === "ready") deps.installer.install();
    },

    /** Downloads and checks the newest stable release, even when it is older than this build. */
    async prepareFresh(): Promise<UpdateStatus> {
      if (downloading) return status();
      try {
        const newest = newestOn("stable", candidates(await deps.releases(), deps.metadataFile));
        if (!newest) {
          fresh = { kind: "failed", detail: "No stable release is available yet." };
        } else {
          const version = formatVersion(newest.version);
          fresh = { kind: "downloading", version, percent: 0 };
          if (update.kind === "ready" || update.kind === "available") update = { kind: "idle" };
          changed();
          const outcome = await fetchRelease(newest, true, (percent) => {
            fresh = { kind: "downloading", version, percent };
            changed();
          });
          fresh = outcome === "done" ? { kind: "ready", version } : { kind: "idle" };
        }
      } catch (cause) {
        fresh = { kind: "failed", detail: reason(cause) };
      }
      changed();
      return status();
    },

    /** Leaves the fresh start: nothing was erased, and the download stays unused. */
    keepEverything(): UpdateStatus | Promise<UpdateStatus> {
      downloading?.abort();
      fresh = { kind: "idle" };
      changed();
      return status();
    },

    /**
     * Erases this device's data and installs the downloaded Stable. The user has confirmed
     * both. The marker goes first, so an interrupted erase finishes at the next start.
     */
    async startFresh(): Promise<void> {
      if (fresh.kind !== "ready") return;
      await writeJsonFile(join(deps.dataDir, MARKER_FILE), { version: fresh.version });
      await deps.erase();
      await writeJsonFile(settingsPath, { channel: "stable" });
      deps.installer.install();
    },
  };
}
