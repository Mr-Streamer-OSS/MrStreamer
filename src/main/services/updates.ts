// In-app updates, the release channel, and starting fresh on Stable.
//
// Nothing happens on its own: the user checks, downloads and confirms the restart. The first run
// stores the build's own channel; after that only the user changes it, so a Nightly user who
// installs a stable build stays on Nightly.
//
// Starting fresh downloads and checks Stable first; cancelling or a failure changes nothing.
// After the final confirmation it writes a marker naming that Stable version and installs. The
// data is erased only once Stable itself starts: `finishFreshStart` runs before anything reads
// the data and erases it when the running version is the one the marker names. When the system
// refuses the update, or an interrupted install leaves the old build running, the data stays.
// The marker is read by the Stable build, so its format must stay readable by later versions.
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

/**
 * Finishes a fresh start the previous run began. Call before anything reads the data folder.
 * When Stable is now running, erases this device's data files and, through `eraseBrowserData`,
 * what the browser session keeps; Stable then starts clean, on Stable. When the previous build
 * is still running, Stable didn't install: the data stays, and the outcome says so.
 */
export async function finishFreshStart(
  dataDir: string,
  installed: string,
  eraseBrowserData: () => Promise<void>,
): Promise<FreshStart> {
  const markerPath = join(dataDir, MARKER_FILE);
  const marker = await readJsonFile(markerPath, Marker);
  if (!marker) return { kind: "idle" };
  if (installed !== marker.version) {
    await removeFile(markerPath);
    return { kind: "not-installed", version: marker.version, detail: null };
  }
  // The marker goes last, so an erase a crash interrupts runs again at the next start.
  await Promise.all(DEVICE_FILES.map((file) => removeFile(join(dataDir, file))));
  await eraseBrowserData();
  await writeJsonFile(join(dataDir, SETTINGS_FILE), { channel: "stable" });
  await removeFile(markerPath);
  return { kind: "idle" };
}

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
  let fresh: FreshStart = deps.freshOutcome;
  let aheadOf: string | null = null;
  let target: Candidate | null = null;
  /** The one download in flight, update or fresh start: there is one installer. */
  let downloading: AbortController | null = null;
  /** The update download whose outcome still counts; a channel change can void it. */
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
          if (downloading === controller && !controller.signal.aborted) onPercent(percent);
        },
        controller.signal,
      );
      // A download that finishes after it was cancelled still doesn't count.
      return controller.signal.aborted ? "cancelled" : "done";
    } catch (cause) {
      if (controller.signal.aborted) return "cancelled";
      throw cause;
    } finally {
      if (downloading === controller) downloading = null;
    }
  }

  return {
    status,

    /**
     * Changes the channel. Takes effect at the next check. An update the new channel doesn't
     * receive, such as a nightly after switching to Stable, is dropped: its download stops, and
     * a downloaded one won't install. Nothing installed is removed.
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
      aheadOf = null;
      await writeJsonFile(settingsPath, { channel: next });
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

    /**
     * Downloads the release the last check found, or again after a failed download or install.
     * Playback carries on meanwhile.
     */
    async download(): Promise<UpdateStatus> {
      const retry = update.kind === "failed" && update.step !== "check";
      if ((update.kind !== "available" && !retry) || !target || downloading) return status();
      const release = target;
      const version = formatVersion(release.version);
      const mine = {};
      attempt = mine;
      update = { kind: "downloading", version, percent: 0 };
      fresh = fresh.kind === "not-installed" ? fresh : { kind: "idle" };
      changed();
      try {
        const outcome = await fetchRelease(release, false, (percent) => {
          if (attempt !== mine) return;
          update = { kind: "downloading", version, percent };
          changed();
        });
        if (attempt !== mine) return status();
        update = outcome === "done" ? { kind: "ready", version } : { kind: "available", version };
      } catch (cause) {
        if (attempt !== mine) return status();
        update = { kind: "failed", step: "download", detail: reason(cause) };
      }
      attempt = null;
      changed();
      return status();
    },

    /** Stops a download in progress; the update or fresh start goes back a step. */
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
     * Installs the downloaded Stable, which erases this device's data when it starts. The user
     * has confirmed both. When the system refuses Stable, nothing is erased.
     */
    async startFresh(): Promise<void> {
      if (fresh.kind !== "ready") return;
      const { version } = fresh;
      const markerPath = join(deps.dataDir, MARKER_FILE);
      await writeJsonFile(markerPath, { version });
      try {
        await deps.installer.install();
      } catch (cause) {
        await removeFile(markerPath);
        fresh = { kind: "not-installed", version, detail: reason(cause) };
        changed();
      }
    },
  };
}
