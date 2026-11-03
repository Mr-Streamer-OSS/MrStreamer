import { requireNativeModule } from "expo";
import { AppState } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import { library } from "../library/runtime.ts";
import { libraryDownload } from "./library-presentation.ts";
import { libraryDownloads, libraryIntents, type DownloadIntent } from "../library/intents.ts";
import { player } from "../player/instance.ts";
import { downloadState, type TransferPort, type DownloadRow, type Action } from "./state.ts";

let owner: ReturnType<typeof createRuntime> | undefined;

function createRuntime() {
  const native = requireNativeModule<TransferPort>("Transfers");
  const model = downloadState(native);

  async function enqueue({ media }: DownloadIntent) {
    const title = library().title(media.kind === "movie" ? "movie" : "series", media.titleKey);

    if (!title) throw new Error("title");

    const details = await library().details({
      ...title,
      subscriptionId: media.sourceId,
      id: media.titleId,
    });

    const episode =
      media.kind === "episode" && details.value?.kind === "series"
        ? details.value.seasons
            .flatMap((season) => season.episodes)
            .find(
              (entry) => entry.id === media.episodeId && entry.subscriptionId === media.sourceId,
            )
        : undefined;

    const id = media.kind === "movie" ? media.titleId : media.episodeId;
    const container = details.containers.get(id) ?? media.version.container;

    if (!container) throw new Error("container");
    const roster = sources.state.get();

    if (roster.kind !== "ready") throw new Error("source");
    const source = roster.sources.find((s) => s.id === media.sourceId);

    if (!source) throw new Error("source");

    const copyId = await native.enqueue(
      JSON.stringify({
        key: JSON.stringify([media.sourceId, media.kind, id, container]),
        sourceId: media.sourceId,
        sourceLabel: source.label,
        kind: media.kind,
        mediaId: id,
        container,
        title: title.title,
        year: title.year,
        duration: episode?.duration ?? details.value?.duration ?? null,
        season: episode?.season,
        episode: episode?.number,
        episodeName: episode?.title,
      }),
    );

    if (title.posterUrl) {
      try {
        await native.cacheArtwork(copyId, title.posterUrl);
      } catch {
        /* The media stays queued when optional artwork cannot be saved. */
      }
    }
  }

  const refresh = () => void model.refresh();
  let held: string | undefined;

  async function syncPlayer() {
    const state = player.state.get();

    const next =
      state.kind === "playing" && state.intent.kind !== "file" ? state.intent.sourceId : undefined;

    if (held === next) return;
    const previous = held;
    held = next;

    if (next) await native.blockSource(next, true);

    if (previous) {
      const released = await player.release(
        (hold) => hold.kind === "source" && hold.sourceId === previous,
      );

      if (released.some((entry) => entry.outcome === "unconfirmed")) return;
      await native.blockSource(previous, false);
    }

    refresh();
  }

  const removing = new Set<string>();
  let stop: (() => void) | undefined;

  return {
    ...model,
    native,
    start() {
      if (stop) return () => {};

      const unregister = libraryIntents.register({
        download: (intent) => void model.change(() => enqueue(intent)),
      });

      const unregisterPresentation = libraryDownloads.register({
        snapshot: model.state.get,
        subscribe: model.state.subscribe,
        read: (media) =>
          libraryDownload(model.state.get().rows, media, (row, action) => {
            if (action === "play")
              void downloads()
                .playCopy(row)
                .catch(() => {});
            else void model.change(() => native.command(row.id, action));
          }),
      });

      const unsubscribe = player.state.subscribe(() => void syncPlayer().catch(() => {}));

      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });

      const timer = setInterval(() => {
        if (AppState.currentState === "active") refresh();
      }, 1500);

      void model
        .refresh(true)
        .then(async () => {
          const state = sources.state.get();

          if (state.kind === "ready")
            for (const source of state.sources) await native.blockSource(source.id, false);
          await syncPlayer();
        })
        .catch(() => {});
      stop = () => {
        unregister();
        unregisterPresentation();
        unsubscribe();
        app.remove();
        clearInterval(timer);
        stop = undefined;
      };

      return () => stop?.();
    },
    async playCopy(row: DownloadRow) {
      if (removing.has(row.id)) throw new Error("removing");
      const path = await native.path(row.id);

      if (removing.has(row.id)) throw new Error("removing");
      player.play({ kind: "file", path, title: row.title });
    },
    async command(row: DownloadRow, action: Action) {
      if (removing.has(row.id)) return "closing" as const;
      removing.add(row.id);

      try {
        if (action === "remove" || action === "cancel") {
          const path = await native.filePath(row.id);

          if (path) {
            const current = player.state.get();

            if (
              current.kind === "playing" &&
              current.intent.kind === "file" &&
              current.intent.path === path
            )
              return "playing" as const;

            const release = await player.release(
              (hold) => hold.kind === "file" && hold.path === path,
            );

            if (release.some((r) => r.outcome !== "file-closed")) return "closing" as const;
          }
        }

        await model.change(() => native.command(row.id, action));

        return null;
      } catch {
        model.state.set((old) => ({ ...old, error: "write" }));

        return null;
      } finally {
        removing.delete(row.id);
      }
    },
  };
}

/** Called by the app owner at launch; cleanup unregisters only this owner's handlers. */
export function startDownloads() {
  return downloads().start();
}

export function downloads() {
  return (owner ??= createRuntime());
}
