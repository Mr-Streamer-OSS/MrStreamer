// Composition root: creates the window and wires the services to IPC.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, safeStorage, session, shell } from "electron";
import type { IpcEvent, IpcEvents } from "@mrstreamer/contracts/ipc";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import type { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { fetchReleases, metadataFileFor } from "@mrstreamer/core/updates/feed";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { WINDOW_BAR } from "../shared/window-bar.ts";
import { emit, registerIpc } from "./ipc.ts";
import { electronInstaller } from "./platform/installer.ts";
import { removeUnfinishedWrites } from "./platform/json-file.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import { mainLayer } from "./runtime.ts";
import { Library } from "./services/library.ts";
import { Playback } from "./services/playback.ts";
import { Settings } from "./services/preferences.ts";
import { Subscriptions } from "./services/subscription.ts";
import { Updates } from "./services/updates.ts";

// Matches `appId` in electron-builder.yml: Windows groups taskbar entries and notifications by it.
const APP_ID = "app.mrstreamer.player";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/** Where updates come from: GitHub's release list, or a test feed that answers the same way. */
const UPDATE_FEED = process.env["MR_STREAMER_UPDATE_FEED"] ?? "https://api.github.com";
const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";

/** Refresh the channel list in the background when the cached copy is older than this. */
const CATALOGUE_MAX_AGE = "12 hours";

let mainWindow: BrowserWindow | null = null;

function openWindow(closeStreams: () => void): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#000000",
    // The picture fills the window. macOS keeps its traffic lights top left; Windows draws its
    // window controls top right over a transparent strip.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: WINDOW_BAR.trafficLights }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#ffffff",
            height: WINDOW_BAR.height,
          },
        }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    // Nothing can be watching once the window is gone, so release the provider connection.
    closeStreams();
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

async function start(): Promise<void> {
  await app.whenReady();
  if (!isMac) {
    // Windows has no app menu to keep; macOS needs its default menu for Edit shortcuts like paste.
    Menu.setApplicationMenu(null);
    app.setAppUserModelId(APP_ID);
  }
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    // No keyring (GNOME Keyring or KWallet) to hold the key. Like Chromium's own passwords, the
    // login then uses a fixed key: it still saves, but other programs of the same user can read it.
    safeStorage.setUsePlainTextEncryption(true);
  }
  const dataDir = app.getPath("userData");
  await removeUnfinishedWrites(dataDir);
  const userAgent = `MrStreamer/${app.getVersion()}`;

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "fullscreen");
  });

  const runtime = ManagedRuntime.make(
    mainLayer({
      dataDir,
      secrets: keychainSecrets,
      userAgent,
      ffmpeg: ffmpegPath(),
      updates: {
        installed: app.getVersion(),
        metadataFile: metadataFileFor(process.platform),
        releases: () => fetchReleases(UPDATE_FEED, REPOSITORY),
        installer: electronInstaller(),
      },
    }),
  );
  const { subscriptions, settings, library, playback, updates, guide, viewing, diagnostics } =
    await runtime.runPromise(
      Effect.all({
        subscriptions: Subscriptions,
        settings: Settings,
        library: Library,
        playback: Playback,
        updates: Updates,
        guide: Guide,
        viewing: ViewingRecord,
        diagnostics: Diagnostics,
      }),
    );

  /** Sends each change to the window, while there is one. */
  const forward = <A, E extends IpcEvent>(
    changes: Stream.Stream<A>,
    event: E,
    payload: (change: A) => IpcEvents[E],
  ) =>
    runtime.runFork(
      Stream.runForEach(changes, (change) =>
        Effect.sync(() => {
          if (mainWindow) emit(mainWindow.webContents, event, payload(change));
        }),
      ),
    );
  forward(library.changes, "library.updated", (status) => status);
  forward(guide.changes, "guide.updated", () => null);
  forward(viewing.changes, "viewing.changed", (sequence) => ({ sequence }));
  forward(updates.changes, "updates.changed", (status) => status);

  /** Downloads the guide when it is due. A failure keeps the guide in use until the next check. */
  const refreshGuide = guide.refreshIfStale.pipe(warned("[guide] refresh failed"));

  /** A different account: its channels, guide and what was last watched no longer apply. */
  const forgetAccount = Effect.gen(function* () {
    yield* Effect.all([library.clear, guide.clear], { concurrency: "unbounded" });
    yield* settings.forget;
  });

  registerIpc(
    (effect) => runtime.runPromiseExit(effect),
    {
      "subscription.get": () => subscriptions.get,
      "subscription.connect": (login) =>
        Effect.gen(function* () {
          const previous = yield* subscriptions.get;
          const connected = yield* subscriptions.connect(login);
          if (previous?.server !== connected.server || previous.username !== connected.username) {
            yield* playback.closeAll;
            yield* forgetAccount;
          }
          yield* Effect.forkDetach(refreshGuide);
          return connected;
        }),
      "subscription.remove": () =>
        Effect.gen(function* () {
          yield* playback.closeAll;
          yield* subscriptions.remove;
          yield* forgetAccount;
          return null;
        }),
      "library.status": () => library.status,
      "library.categories": () => library.categories,
      "library.channels": (filter) => library.channels(filter),
      "library.channel": ({ channelId }) => library.channel(channelId),
      "library.refresh": () => library.refresh,
      "guide.listings": ({ channelIds }) => guide.listings(channelIds),
      "guide.schedule": ({ channelId }) => guide.schedule(channelId),
      "guide.search": ({ query }) => guide.search(query),
      "playback.open": ({ channelId, decoders, repair }) =>
        playback.open(channelId, decoders, { repair: repair ?? false }),
      "playback.close": ({ sessionId }) => Effect.as(playback.close(sessionId), null),
      "playback.failure": ({ sessionId }) => playback.failure(sessionId),
      "preferences.get": () => settings.get,
      "preferences.update": (patch) => settings.update(patch),
      "viewing.get": () => viewing.state,
      "viewing.setFavourite": ({ commandId, channelId, favourite }) =>
        viewing.setFavourite(commandId, channelId, favourite),
      "viewing.recordWatch": ({ commandId, channelId }) =>
        Effect.andThen(
          settings.update({ lastChannelId: channelId }),
          viewing.recordWatch(commandId, channelId),
        ),
      "updates.status": () => updates.status,
      "updates.setChannel": ({ channel }) => updates.setChannel(channel),
      "updates.check": () => updates.check,
      "updates.download": () => updates.download,
      "updates.cancel": () => Effect.as(updates.cancel, null),
      "updates.restart": () => Effect.as(updates.restart, null),
    },
    (sender) => sender === mainWindow?.webContents,
  );

  const closeStreams = () => void runtime.runFork(playback.closeAll);
  mainWindow = openWindow(closeStreams);
  // How long the app took to show its window, from the start of the process.
  mainWindow.once("ready-to-show", () =>
    diagnostics.record({ op: "start", ms: Math.round(performance.now()), outcome: "ok" }),
  );
  app.on("activate", () => {
    mainWindow ??= openWindow(closeStreams);
  });
  app.on("will-quit", () => {
    // Streams close right away, so no ffmpeg or provider connection outlives the app. The rest
    // of the runtime, background work and the database, closes as the app exits; holding the
    // quit for it would get in the way of an update's restart.
    runtime.runSyncExit(playback.closeAll);
    void runtime.dispose();
  });

  // Keeps account status, the channel list and the guide current without making the UI wait.
  runtime.runFork(
    Effect.gen(function* () {
      const connected = yield* Effect.gen(function* () {
        if (!(yield* subscriptions.recheck)) return false;
        if (yield* library.isStale(CATALOGUE_MAX_AGE)) yield* library.refresh;
        return true;
      }).pipe(warned("[startup] background refresh failed"));
      if (connected !== false) yield* refreshGuide;
    }),
  );
}

/**
 * The ffmpeg that converts streams the player cannot decode: bundled with packaged builds, from
 * PATH during development. MR_STREAMER_FFMPEG points at another build.
 */
function ffmpegPath(): string | null {
  const override = process.env["MR_STREAMER_FFMPEG"];
  if (override) return override;
  if (!app.isPackaged) return "ffmpeg";
  const bundled = join(process.resourcesPath, "ffmpeg", isWindows ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(bundled) ? bundled : null;
}

/** Logs a failure as a warning instead of failing. */
function warned(label: string) {
  return <A>(effect: Effect.Effect<A, Failed>) =>
    effect.pipe(
      Effect.catchTag("Failed", (failed) => Effect.logWarning(label, failed.error)),
      Effect.catchDefect((defect) => Effect.logWarning(label, defect)),
    );
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void start();
