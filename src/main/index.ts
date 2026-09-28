// Composition root: creates the window and wires the services to IPC.
import { join } from "node:path";
import { app, BrowserWindow, Menu, safeStorage, session, shell } from "electron";
import { emit, registerIpc } from "./ipc.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import { createLibrary, type Library } from "./services/library.ts";
import { createPlayback, type Playback } from "./services/playback.ts";
import { createPreferences } from "./services/preferences.ts";
import { createSubscriptions, type Subscriptions } from "./services/subscription.ts";

const APP_ID = "io.github.stienswout.mrstreamer";
const isMac = process.platform === "darwin";

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
  if (process.platform === "linux" && !app.isPackaged) {
    // Linux ships later. Headless dev boxes often lack a keyring, so development falls back to
    // Chromium's fixed-key encryption there instead of refusing to store the login.
    safeStorage.setUsePlainTextEncryption(true);
  }
  const dataDir = app.getPath("userData");
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
  const playback = createPlayback({ source: subscriptions.source, userAgent });
  const preferences = createPreferences(dataDir);

  registerIpc(
    {
      "subscription.get": () => subscriptions.get(),
      "subscription.connect": async (login) => {
        const previous = await subscriptions.source();
        const connected = await subscriptions.connect(login);
        if (previous?.key !== `${connected.server}|${connected.username}`) {
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
      "playback.open": ({ channelId }) => playback.open(channelId),
      "playback.close": ({ sessionId }) => {
        playback.close(sessionId);
        return null;
      },
      "playback.failure": ({ sessionId }) => playback.failure(sessionId),
      "preferences.get": () => preferences.get(),
      "preferences.update": (patch) => preferences.update(patch),
      "preferences.recordWatch": ({ channelId }) => preferences.recordWatch(channelId),
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
