// The main process's Effect services, assembled once from Layers. The app makes one runtime from
// `mainLayer` at start and disposes of it when quitting, which stops their background work. Only
// the programme guide runs on it so far; the other services still use promises (slice 3.5).
import { AppFailure } from "@mrstreamer/contracts/errors";
import { Guide, GuideCatalogue, GuideFailed, GuideSource } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { guideStoreLayer } from "./platform/guide-store.ts";
import type { CatalogueSource, Library } from "./services/library.ts";

export interface MainDeps {
  readonly dataDir: string;
  readonly source: () => Promise<CatalogueSource | null>;
  readonly library: Pick<Library, "guideChannels">;
}

/** Every main-process service, with the app's adapters for their ports. */
export function mainLayer(deps: MainDeps): Layer.Layer<Guide> {
  const adapters = Layer.mergeAll(
    Layer.succeed(GuideSource, {
      current: Effect.promise(async () => {
        const source = await deps.source();
        if (!source) return null;
        return {
          key: source.key,
          download: (signal: AbortSignal) => source.provider.liveGuide(signal),
        };
      }),
    }),
    Layer.succeed(GuideCatalogue, {
      channels: Effect.tryPromise({
        try: () => deps.library.guideChannels(),
        catch: (cause) =>
          new GuideFailed({
            error:
              cause instanceof AppFailure
                ? cause.error
                : { kind: "unexpected", detail: String(cause) },
          }),
      }),
    }),
    guideStoreLayer(deps.dataDir),
  );
  return Guide.layer.pipe(Layer.provide(adapters));
}
