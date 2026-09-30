// The main process's services, assembled once from Layers. The app makes one runtime from
// `mainLayer` at start and disposes of it when quitting: that stops background work and downloads,
// closes streams and the proxy, and closes the database.
import { Guide, GuideCatalogue, GuideSource } from "@mrstreamer/core/guide/service";
import { LegacyViewing, ViewingAccount, ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { guideStoreLayer } from "./platform/guide-store.ts";
import type { Secrets } from "./platform/secrets.ts";
import { viewingStoreLayer } from "./platform/viewing-store.ts";
import { Library } from "./services/library.ts";
import { Playback } from "./services/playback.ts";
import { Settings } from "./services/preferences.ts";
import { Subscriptions } from "./services/subscription.ts";
import { Updates, type UpdatesDeps } from "./services/updates.ts";

export interface MainConfig {
  readonly dataDir: string;
  readonly secrets: Secrets;
  readonly userAgent: string;
  /** The ffmpeg that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  readonly updates: Omit<UpdatesDeps, "dataDir">;
}

export type MainServices =
  Subscriptions | Settings | Library | Playback | Updates | Guide | ViewingRecord;

/** Every main-process service, with the app's adapters for their ports. */
export function mainLayer(config: MainConfig): Layer.Layer<MainServices> {
  const { dataDir } = config;
  const accounts = Layer.mergeAll(
    Subscriptions.layer({
      dataDir,
      secrets: config.secrets,
      providerOptions: { userAgent: config.userAgent },
    }),
    Settings.layer(dataDir),
  );
  const services = Layer.mergeAll(
    Library.layer({ dataDir }),
    Playback.layer({ userAgent: config.userAgent, ffmpeg: config.ffmpeg }),
    Updates.layer({ dataDir, ...config.updates }),
  ).pipe(Layer.provideMerge(accounts));

  const guide = Guide.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          GuideSource,
          Effect.map(Subscriptions, (subscriptions) => ({
            current: Effect.map(subscriptions.source, (source) =>
              source
                ? {
                    key: source.key,
                    download: (signal: AbortSignal) => source.provider.liveGuide(signal),
                  }
                : null,
            ),
          })),
        ),
        Layer.effect(
          GuideCatalogue,
          Effect.map(Library, (library) => ({ channels: library.guideChannels })),
        ),
        guideStoreLayer(dataDir),
      ),
    ),
  );
  const viewing = ViewingRecord.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(
          ViewingAccount,
          Effect.map(Subscriptions, (subscriptions) => ({
            current: Effect.map(subscriptions.source, (source) => source?.key ?? null),
          })),
        ),
        Layer.effect(
          LegacyViewing,
          Effect.map(Settings, (settings) => ({
            take: settings.legacyLists,
            drop: settings.dropLegacyLists,
          })),
        ),
        viewingStoreLayer(dataDir),
      ),
    ),
  );
  return Layer.mergeAll(guide, viewing).pipe(Layer.provideMerge(services));
}
