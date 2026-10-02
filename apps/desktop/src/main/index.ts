// Composition root: creates the window and wires the services to IPC.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, Menu, safeStorage, session, shell } from "electron";
import type { IpcEvent, IpcEvents } from "@mrstreamer/contracts/ipc";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { discovery, metadataFileFor } from "@mrstreamer/core/updates/feed";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { WINDOW_BAR } from "../shared/window-bar.ts";
import { emit, registerIpc } from "./ipc.ts";
import { miniPlayer, miniPlayerAvailable } from "./mini-player.ts";
import { electronInstaller } from "./platform/installer.ts";
import { removeUnfinishedWrites } from "./platform/json-file.ts";
import { keychainSecrets } from "./platform/secrets.ts";
// electron-vite builds the worker as its own file and hands back a function that starts it; the
// lint plugin reads the source file, which has no default export.
// oxlint-disable-next-line import/default
import createCatalogueWorker from "./ondemand/catalogue-worker.ts?nodeWorker";
import { mainLayer } from "./runtime.ts";
import { Library } from "./services/library.ts";
import { OnDemand } from "./services/ondemand.ts";
import { Licences } from "./services/licences.ts";
import { Playback } from "./services/playback.ts";
import { Settings } from "./services/preferences.ts";
import { Subscriptions } from "./services/subscription.ts";
import { DEFAULT_SCHEDULE, Updates } from "./services/updates.ts";

// Matches `appId` in electron-builder.yml: Windows groups taskbar entries and notifications by it.
const APP_ID = "app.mrstreamer.player";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/**
 * Where updates are found: the feed the release workflow publishes, and GitHub's API when the
 * feed is missing. Tests point both at local servers; MR_STREAMER_UPDATE_CHECKS=off stops the
 * automatic checks, as the packaged-app test and measurements do.
 */
const UPDATE_FEED =
  process.env["MR_STREAMER_UPDATE_FEED"] ??
  "https://mr-streamer-oss.github.io/MrStreamer/updates.json";
const UPDATE_API = process.env["MR_STREAMER_UPDATE_API"] ?? "https://api.github.com";
const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";

/**
 * A copy installed as an MSIX package, from the Microsoft Store or sideloaded, runs with the
 * package's identity. The Store updates it, so the app never does, and it keeps a data folder of
 * its own: Windows lets a package change files that a direct install left in AppData, while
 * keeping the files it creates to itself, so sharing that folder would mix two profiles. An
 * explicit --user-data-dir, as tests pass, still wins.
 */
const storeCopy = process.windowsStore === true;
if (storeCopy && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "Mr. Streamer Store"));
}
/** The app's page in the Microsoft Store, by the Store ID Partner Center gave it. */
const STORE_PAGE = "ms-windows-store://pdp/?ProductId=9N45GG76ZP4T";

/**
 * Chromium's own cache, mostly posters and backdrops, on disk at most this big; the oldest go
 * first. Artwork shown this session stays in memory either way.
 */
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
app.commandLine.appendSwitch("disk-cache-size", String(DISK_CACHE_BYTES));

/** Refresh the channel list in the background when the cached copy is older than this. */
const CATALOGUE_MAX_AGE = "12 hours";

let mainWindow: BrowserWindow | null = null;
/** The smallest the window gets, except as the mini player. */
const MIN_SIZE = { minWidth: 960, minHeight: 600 } as const;
/** Each window's mini player, which remembers where the window was. */
const miniPlayers = new WeakMap<BrowserWindow, ReturnType<typeof miniPlayer>>();

function openWindow(closeStreams: () => void): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    ...MIN_SIZE,
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
  // Full screen hides the traffic lights and the Windows controls; the top bar takes their room.
  const fullScreen = () => emit(window.webContents, "window.fullScreen", window.isFullScreen());
  window.on("enter-full-screen", fullScreen);
  window.on("leave-full-screen", fullScreen);
  window.webContents.on("did-finish-load", fullScreen);
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
  miniPlayers.set(window, miniPlayer(window, MIN_SIZE));

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
    // Nothing checks spelling, so Chromium has no reason to download a dictionary from Google.
    // macOS uses its own spellchecker and downloads nothing.
    session.defaultSession.setSpellCheckerLanguages([]);
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
      ffmpeg: toolPath("ffmpeg"),
      ffprobe: toolPath("ffprobe"),
      catalogueWorker: (setup) => createCatalogueWorker({ workerData: setup }),
      // MR_STREAMER_TMDB_KEY at run time overrides the key built in, for testing.
      tmdbKey: process.env["MR_STREAMER_TMDB_KEY"] || __TMDB_KEY__ || null,
      region: app.getLocaleCountryCode() || "US",
      ...(process.env["MR_STREAMER_TMDB_API"]
        ? { tmdbApi: process.env["MR_STREAMER_TMDB_API"] }
        : {}),
      // A Store copy never creates electron-updater's updater.
      updates: storeCopy
        ? { installed: app.getVersion(), openStore: () => shell.openExternal(STORE_PAGE) }
        : {
            installed: app.getVersion(),
            discover: discovery({
              feedUrl: UPDATE_FEED,
              api: UPDATE_API,
              repository: REPOSITORY,
              metadataFile: metadataFileFor(process.platform),
              userAgent,
              // A test feed serves its own files.
              ...(process.env["MR_STREAMER_UPDATE_FEED"] ? { filesFrom: "" } : {}),
            }),
            installer: electronInstaller(),
            schedule: process.env["MR_STREAMER_UPDATE_CHECKS"] === "off" ? null : DEFAULT_SCHEDULE,
          },
    }),
  );
  const {
    subscriptions,
    settings,
    library,
    onDemand,
    playback,
    updates,
    guide,
    viewing,
    diagnostics,
    licences,
  } = await runtime.runPromise(
    Effect.all({
      subscriptions: Subscriptions,
      settings: Settings,
      library: Library,
      onDemand: OnDemand,
      playback: Playback,
      updates: Updates,
      guide: Guide,
      viewing: ViewingRecord,
      diagnostics: Diagnostics,
      licences: Licences,
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
  forward(onDemand.changes, "ondemand.updated", (status) => status);
  forward(guide.changes, "guide.updated", () => null);
  forward(viewing.changes, "viewing.changed", (sequence) => ({ sequence }));
  forward(updates.changes, "updates.changed", (status) => status);

  /** Downloads the guide when it is due. A failure keeps the guide in use until the next check. */
  const refreshGuide = guide.refreshIfStale.pipe(warned("[guide] refresh failed"));

  /** A different account: its channels, titles, guide and what was last watched no longer apply. */
  const forgetAccount = Effect.gen(function* () {
    yield* Effect.all([library.clear, onDemand.clear, guide.clear], { concurrency: "unbounded" });
    yield* settings.forget;
  });

  /**
   * Counts what the viewer asked to play or stop. A title waits for the provider before it
   * opens, so one the viewer left or replaced meanwhile doesn't open after all.
   */
  let playbackTurn = 0;
  const nextTurn = Effect.sync(() => ++playbackTurn);

  registerIpc(
    (effect) => runtime.runPromiseExit(effect),
    {
      "subscription.get": () => subscriptions.get,
      "subscription.connect": (login) =>
        Effect.gen(function* () {
          const previous = yield* subscriptions.get;
          const connected = yield* subscriptions.connect(login);
          if (previous?.id !== connected.id) {
            yield* playback.closeAll;
            yield* forgetAccount;
          }
          yield* Effect.forkDetach(refreshGuide);
          return connected;
        }),
      "subscription.remove": ({ eraseViewing }) =>
        Effect.gen(function* () {
          yield* playback.closeAll;
          // First, so a record that can't be erased leaves the subscription to try again.
          const key = yield* subscriptions.key;
          if (eraseViewing && key) yield* viewing.erase(key);
          yield* subscriptions.remove;
          yield* forgetAccount;
          return null;
        }),
      "subscription.recheck": () => subscriptions.recheck,
      "library.status": () => library.status,
      "library.categories": () => library.categories,
      "library.channels": (filter) => library.channels(filter),
      "library.channel": ({ channelId }) => library.channel(channelId),
      "library.refresh": () => library.refresh,
      "guide.listings": ({ channelIds }) => guide.listings(channelIds),
      "guide.schedule": ({ channelId }) => guide.schedule(channelId),
      "guide.search": ({ query }) => guide.search(query),
      "guide.status": () => guide.status,
      "guide.refresh": () => Effect.andThen(guide.refresh, guide.status),
      "ondemand.status": () => onDemand.status,
      "ondemand.refresh": () => onDemand.refresh,
      "ondemand.search": ({ query }) => onDemand.search(query),
      "ondemand.searchKind": ({ kind, query }) => onDemand.searchKind(kind, query),
      "ondemand.details": ({ kind, id }) => onDemand.details(kind, id),
      "ondemand.season": ({ id, season }) => onDemand.season(id, season),
      "ondemand.titles": ({ kind, ids }) => onDemand.titles(kind, ids),
      "ondemand.rows": ({ kind, tab, like }) => onDemand.rows(kind, tab, like),
      "ondemand.tiles": ({ kind, of }) => onDemand.tiles(kind, of),
      "ondemand.collection": (query) => onDemand.collection(query),
      "playback.open": ({ channelId, variant, decoders, repair, audio, audioLanguage }) =>
        Effect.gen(function* () {
          yield* nextTurn;
          const channel = yield* library.channel(channelId);
          const variants = streamsToPlay(channel, yield* settings.get, variant).map(({ id }) => id);
          if (variants.length === 0) {
            return yield* new Failed({
              error: { kind: "channel-not-found", channelId: variant ?? channelId },
            });
          }
          return yield* playback.open(channel.id, decoders, {
            variants,
            repair: repair ?? false,
            audio: audio ?? null,
            audioLanguage: audioLanguage ?? null,
          });
        }),
      "playback.openTitle": ({ title, decoders }) =>
        Effect.gen(function* () {
          const turn = yield* nextTurn;
          // The live preview's connection goes first, so the provider sees one at a time.
          yield* playback.closeAll;
          const file = yield* onDemand.file(title);
          if (turn !== playbackTurn) {
            return yield* new Failed({
              error: { kind: "unexpected", detail: "Something else played in the meantime." },
            });
          }
          return yield* playback.openTitle(title, file.url, decoders);
        }),
      "playback.close": ({ sessionId }) => Effect.as(playback.close(sessionId), null),
      "playback.closeAll": () => Effect.andThen(nextTurn, Effect.as(playback.closeAll, null)),
      "playback.failure": ({ sessionId }) => playback.failure(sessionId),
      "playback.tracks": ({ sessionId }) => playback.tracks(sessionId),
      "playback.playing": ({ sessionId }) => playback.playing(sessionId),
      "preferences.get": () => settings.get,
      "preferences.update": (patch) =>
        Effect.gen(function* () {
          const updated = yield* settings.update(patch);
          if ("tmdbKey" in patch) yield* onDemand.reconfigure;
          return updated;
        }),
      "viewing.get": () => viewing.state,
      "viewing.setFavourite": ({ commandId, channelId, favourite }) =>
        viewing.setFavourite(commandId, channelId, favourite),
      "viewing.recordWatch": ({ commandId, channelId }) =>
        Effect.andThen(
          settings.update({ lastChannelId: channelId }),
          viewing.recordWatch(commandId, channelId),
        ),
      "viewing.recordProgress": ({ commandId, title, position, duration, since }) =>
        viewing.recordProgress(commandId, title, position, duration, since),
      "viewing.removeFromContinue": ({ commandId, ...filter }) =>
        viewing.removeFromContinue(commandId, filter),
      "viewing.finishSeries": ({ commandId, seriesIds }) =>
        viewing.finishSeries(commandId, seriesIds),
      "viewing.progress": (filter) => viewing.progress(filter),
      "updates.status": () => updates.status,
      "updates.setChannel": ({ channel }) => updates.setChannel(channel),
      "updates.check": () => updates.check,
      "updates.download": () => updates.download,
      "updates.cancel": () => Effect.as(updates.cancel, null),
      "updates.restart": () => Effect.as(updates.restart, null),
      "updates.dismiss": ({ version }) => updates.dismiss(version),
      "updates.openStore": () => Effect.as(updates.openStore, null),
      "licences.list": () => licences.list,
      "licences.text": ({ id }) => licences.text(id),
      "window.miniPlayerAvailable": () => Effect.succeed(miniPlayerAvailable()),
      "window.setMiniPlayer": ({ on }) =>
        Effect.promise(async () => {
          const mini = mainWindow && miniPlayers.get(mainWindow);
          await mini?.set(on);
          return null;
        }),
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
      if (connected === false) return;
      yield* refreshGuide;
      // Movies and series last: their lists are the largest and nothing waits for them.
      if (yield* onDemand.isStale(CATALOGUE_MAX_AGE)) {
        yield* onDemand.refresh.pipe(warned("[startup] movie and series refresh failed"));
      }
    }),
  );
}

/**
 * The ffmpeg that converts streams the player cannot decode, or the ffprobe that reads movie
 * files: bundled with packaged builds, from PATH during development. MR_STREAMER_FFMPEG points at
 * another ffmpeg, with its ffprobe beside it.
 */
function toolPath(tool: "ffmpeg" | "ffprobe"): string | null {
  const executable = isWindows ? `${tool}.exe` : tool;
  const override = process.env["MR_STREAMER_FFMPEG"];
  if (override) return tool === "ffmpeg" ? override : join(dirname(override), executable);
  if (!app.isPackaged) return tool;
  const bundled = join(process.resourcesPath, "ffmpeg", executable);
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

// One copy per profile: a second would keep its own copy of the settings and write over the
// first's. Opening the app again brings the running copy's window forward instead.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  // Quitting hands the profile on at once: an update's AppImage starts its new copy just before
  // this one quits.
  app.on("before-quit", () => app.releaseSingleInstanceLock());
  void start();
} else {
  app.quit();
}
