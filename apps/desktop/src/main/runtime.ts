// The main process's services, assembled once from Layers. The app makes one runtime from
// `mainLayer` at start and disposes of it when quitting: that stops background work and downloads,
// closes streams and the proxy, and closes the database. Their diagnostics go to a log in the
// data folder, and disposing waits for the lines still being written.
import { Guide, GuideCatalogue, GuideSource } from "@mrstreamer/core/guide/service";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
} from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { databaseLayer } from "./platform/database.ts";
import { diagnosticsLogLayer } from "./platform/diagnostics-log.ts";
import { guideStoreLayer } from "./platform/guide-store.ts";
import type { Secrets } from "./platform/secrets.ts";
import { viewingStoreLayer } from "./platform/viewing-store.ts";
import { watchlistStoreLayer } from "./platform/watchlist-store.ts";
import { Library } from "./services/library.ts";
import { OnDemand, type OnDemandDeps } from "./services/ondemand.ts";
import { Output, type OutputDeps } from "./services/output.ts";
import { appNotices, Licences } from "./services/licences.ts";
import { Playback } from "./services/playback.ts";
import { Settings } from "./services/preferences.ts";
import { Roster } from "./services/roster.ts";
import { Subscriptions } from "./services/subscription.ts";
import { Updates, type UpdatesConfig } from "./services/updates.ts";
import { Watchlist } from "./services/watchlist.ts";

export interface MainConfig {
  readonly dataDir: string;
  readonly secrets: Secrets;
  readonly userAgent: string;
  /** The ffmpeg that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  /** The ffprobe that reads movie files, or null when this build has none. */
  readonly ffprobe?: string | null;
  readonly updates: UpdatesConfig;
  /** Starts the movie and series catalogue's worker thread. */
  readonly catalogueWorker: OnDemandDeps["worker"];
  /** The app's TMDB key, or null in builds without one. */
  readonly tmdbKey: string | null;
  /** The country whose streaming services to follow. */
  readonly region: string;
  /** Another TMDB API, for tests. */
  readonly tmdbApi?: string;
  /** How this build reaches receivers on the network; none when absent. */
  readonly output?: OutputDeps;
}

export type MainServices =
  | Subscriptions
  | Roster
  | Settings
  | Library
  | OnDemand
  | Playback
  | Output
  | Updates
  | Guide
  | ViewingRecord
  | Watchlist
  | Licences;

/** Every main-process service, with the app's adapters for their ports. */
export function mainLayer(config: MainConfig): Layer.Layer<MainServices> {
  const { dataDir } = config;
  const accounts = Settings.layer(dataDir).pipe(
    Layer.provideMerge(
      Subscriptions.layer({
        dataDir,
        secrets: config.secrets,
        providerOptions: { userAgent: config.userAgent },
      }),
    ),
  );
  const services = Layer.mergeAll(
    Library.layer(),
    OnDemand.layer({
      dataDir,
      userAgent: config.userAgent,
      worker: config.catalogueWorker,
      tmdbKey: config.tmdbKey,
      region: config.region,
      ...(config.tmdbApi ? { tmdbApi: config.tmdbApi } : {}),
    }),
    Playback.layer({
      userAgent: config.userAgent,
      ffmpeg: config.ffmpeg,
      ffprobe: config.ffprobe ?? null,
    }),
    Updates.layer({ dataDir, ...config.updates }),
    Licences.layer(appNotices()),
  ).pipe(Layer.provideMerge(accounts));

  const guide = Guide.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          GuideSource,
          Effect.map(Subscriptions, (subscriptions) => ({
            saved: Effect.gen(function* () {
              const sources = new Map(
                (yield* subscriptions.sources).map((each) => [each.id, each]),
              );
              return (yield* subscriptions.saved).map(({ id, revision, key, dir }) => {
                const provider = sources.get(id)?.provider;
                return {
                  id,
                  revision,
                  key,
                  store: dir,
                  download: provider ? (signal: AbortSignal) => provider.liveGuide(signal) : null,
                };
              });
            }),
          })),
        ),
        Layer.effect(
          GuideCatalogue,
          Effect.map(Library, (library) => ({ channels: library.guideChannels })),
        ),
        guideStoreLayer,
      ),
    ),
  );
  // One connection to the database, for the viewing record and the watchlist alike.
  const stores = Layer.mergeAll(viewingStoreLayer, watchlistStoreLayer).pipe(
    Layer.provide(databaseLayer(dataDir)),
  );
  const viewing = ViewingRecord.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          ViewingAccount,
          Effect.map(Subscriptions, (subscriptions) => ({
            owners: Effect.map(subscriptions.saved, (saved) =>
              saved.map(({ id, key, original }) => ({ subscriptionId: id, key, original })),
            ),
          })),
        ),
        Layer.effect(
          ViewingChannels,
          Effect.map(Library, (library) => ({ lookup: library.lookup })),
        ),
        Layer.effect(
          LegacyViewing,
          Effect.map(Settings, (settings) => ({
            take: settings.legacyLists,
            drop: settings.dropLegacyLists,
          })),
        ),
        stores,
      ),
    ),
  );
  const watchlist = Watchlist.layer.pipe(Layer.provide(stores));
  const output = Output.layer(config.output ?? { adapters: [] }).pipe(Layer.provide(viewing));
  return Roster.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(guide, viewing, watchlist, output)),
    Layer.provideMerge(services),
    Layer.provideMerge(diagnosticsLogLayer(dataDir)),
  );
}
