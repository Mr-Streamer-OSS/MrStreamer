// Composition root: creates the window and wires the services to IPC.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, safeStorage, session, shell } from "electron";
import { emit, registerIpc } from "./ipc.ts";
import { removeUnfinishedWrites } from "./platform/json-file.ts";
import { electronInstaller } from "./platform/installer.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import { createLibrary, type Library } from "./services/library.ts";
import { createPlayback, type Playback } from "./services/playback.ts";
import { createPreferences } from "./services/preferences.ts";
import { createSubscriptions, type Subscriptions } from "./services/subscription.ts";
import { createUpdates, eraseDeviceData, finishFreshStart } from "./services/updates.ts";
import { fetchReleases, metadataFileFor } from "./updates/feed.ts";

// Matches `appId` in electron-builder.yml: Windows groups taskbar entries and notifications by it.
const APP_ID = "io.github.mr-streamer-oss.mrstreamer";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/** Where updates come from: GitHub's release list, or a test feed that answers the same way. */
const UPDATE_FEED = process.env["MR_STREAMER_UPDATE_FEED"] ?? "https://api.github.com";
const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";

/** Refresh the channel list in the background when the cached copy is older than this. */
const CATALOGUE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;

function openWindow(playback: Playback): BrowserWindow {
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
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#00000000", symbolColor: "#ffffff", height: 40 },
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
    playback.closeAll();
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
  // Before any service reads the data: a fresh start from the last run may have to finish.
  const freshOutcome = await finishFreshStart(dataDir, app.getVersion());
  const userAgent = `MrStreamer/${app.getVersion()}`;

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "fullscreen");
  });

  const subscriptions = createSubscriptions({
    dataDir,
    secrets: keychainSecrets,
    providerOptions: { userAgent },
  });
  const library = createLibrary({
    dataDir,
    source: subscriptions.source,
    onUpdated: (status) => {
      if (mainWindow) emit(mainWindow.webContents, "library.updated", status);
    },
  });
  const playback = createPlayback({
    source: subscriptions.source,
    userAgent,
    ffmpeg: ffmpegPath(),
  });
  const preferences = createPreferences(dataDir);
  const updates = createUpdates({
    dataDir,
    installed: app.getVersion(),
    metadataFile: metadataFileFor(process.platform),
    releases: () => fetchReleases(UPDATE_FEED, REPOSITORY),
    installer: electronInstaller(),
    erase: async () => {
      playback.closeAll();
      await eraseDeviceData(dataDir);
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
    },
    freshOutcome,
    onChanged: (status) => {
      if (mainWindow) emit(mainWindow.webContents, "updates.changed", status);
    },
  });

  registerIpc(
    {
      "subscription.get": () => subscriptions.get(),
      "subscription.connect": async (login) => {
        const previous = await subscriptions.get();
        const connected = await subscriptions.connect(login);
        if (previous?.server !== connected.server || previous.username !== connected.username) {
          // A different account: its channels, and what was last watched, no longer apply.
          playback.closeAll();
          await library.clear();
          await preferences.update({
            lastChannelId: null,
            lastCategoryId: null,
            recentChannelIds: [],
          });
        }
        return connected;
      },
      "subscription.remove": async () => {
        playback.closeAll();
        await subscriptions.remove();
        await library.clear();
        await preferences.update({
          lastChannelId: null,
          lastCategoryId: null,
          recentChannelIds: [],
        });
        return null;
      },
      "library.status": () => library.status(),
      "library.categories": () => library.categories(),
      "library.channels": (filter) => library.channels(filter),
      "library.channel": ({ channelId }) => library.channel(channelId),
      "library.refresh": () => library.refresh(),
      "playback.open": ({ channelId, decoders, repair }) =>
        playback.open(channelId, decoders, { repair: repair ?? false }),
      "playback.close": ({ sessionId }) => {
        playback.close(sessionId);
        return null;
      },
      "playback.failure": ({ sessionId }) => playback.failure(sessionId),
      "preferences.get": () => preferences.get(),
      "preferences.update": (patch) => preferences.update(patch),
      "preferences.recordWatch": ({ channelId }) => preferences.recordWatch(channelId),
      "updates.status": () => updates.status(),
      "updates.setChannel": ({ channel }) => updates.setChannel(channel),
      "updates.check": () => updates.check(),
      "updates.download": () => updates.download(),
      "updates.cancel": () => {
        updates.cancel();
        return null;
      },
      "updates.restart": () => {
        updates.restart();
        return null;
      },
      "updates.prepareFresh": () => updates.prepareFresh(),
      "updates.keepEverything": () => updates.keepEverything(),
      "updates.startFresh": async () => {
        await updates.startFresh();
        return null;
      },
    },
    (sender) => sender === mainWindow?.webContents,
  );

  mainWindow = openWindow(playback);
  app.on("activate", () => {
    mainWindow ??= openWindow(playback);
  });
  app.on("will-quit", () => {
    void playback.dispose();
  });

  void refreshInBackground(subscriptions, library);
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

/** Keeps account status and the channel list current without making the UI wait. */
async function refreshInBackground(subscriptions: Subscriptions, library: Library): Promise<void> {
  try {
    if (!(await subscriptions.recheck())) return;
    const { fetchedAt } = await library.status();
    if (fetchedAt === null || Date.now() - fetchedAt > CATALOGUE_MAX_AGE_MS)
      await library.refresh();
  } catch (cause) {
    console.warn("[startup] background refresh failed", cause);
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void start();
