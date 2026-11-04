import { router } from "expo-router";
import { requireNativeModule } from "expo";
import { Alert, AppState, PermissionsAndroid, Platform } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import { library } from "../library/runtime.ts";
import { libraryDownload } from "./library-presentation.ts";
import { libraryDownloads, libraryIntents, type DownloadIntent } from "../library/intents.ts";
import { player } from "../player/instance.ts";
import { store } from "../platform/store.ts";
import { t } from "./copy.ts";
import { downloadState, type TransferPort, type DownloadRow, type Action } from "./state.ts";

let owner: ReturnType<typeof createRuntime> | undefined;

function createRuntime() {
  const native = requireNativeModule<TransferPort>("Transfers");
  const model = downloadState(native);

  let askedNotifications = false;
  const tapErrors = new Map<string, () => Promise<void>>();
  const identity = (media: DownloadIntent["media"]) => JSON.stringify(media);
  const presentation = store(0);

  function tapAction(media: DownloadIntent["media"], operation: () => Promise<void>) {
    void model.change(async () => {
      try {
        await operation();
        tapErrors.delete(identity(media));
      } catch {
        tapErrors.set(identity(media), operation);
        throw new Error("write");
      } finally {
        presentation.set((value) => value + 1);
      }
    }, identity(media));
  }

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

    if (Platform.OS === "android" && Number(Platform.Version) >= 33 && !askedNotifications) {
      askedNotifications = true;
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    await syncPlayer();

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
  const held = new Set<string>();
  let authority = Promise.resolve();
  const unconfirmed = new Set<string>();
  let revision = 0;

  function syncPlayer(active = true) {
    const pass = ++revision;
    authority = authority
      .catch(() => {})
      .then(async () => {
        if (pass !== revision) return;
        const state = player.state.get();

        // Paused playback can still hold its provider connection open.
        const next =
          active &&
          state.kind === "playing" &&
          state.intent.kind !== "file" &&
          state.phase !== "failed" &&
          state.phase !== "ended" &&
          !state.failure
            ? state.intent.sourceId
            : undefined;

        if (next && !held.has(next)) {
          await native.blockSource(next, true);
          held.add(next);

          if (pass !== revision) return;
        }

        for (const previous of held) {
          if (pass !== revision) return;

          if (previous === next || unconfirmed.has(previous)) continue;

          const released = await player.release(
            (hold) => hold.kind === "source" && hold.sourceId === previous,
          );

          if (released.some((entry) => entry.outcome === "unconfirmed")) unconfirmed.add(previous);

          if (pass !== revision) return;

          if (unconfirmed.has(previous)) continue;
          await native.blockSource(previous, false);
          held.delete(previous);

          if (pass !== revision) return;
        }
      });

    return authority;
  }

  const removing = new Set<string>();
  let stop: (() => void) | undefined;
  let leases = 0;
  let visible = 0;
  let restored = false;

  function lease(screen: boolean) {
    leases++;

    if (screen) visible++;
    let released = false;

    return () => {
      if (released) return;
      released = true;

      if (screen) visible--;

      if (--leases === 0) stop?.();
    };
  }

  return {
    ...model,
    native,
    start(screen = false) {
      if (stop) return lease(screen);

      const unregister = libraryIntents.register({
        download: (intent) => tapAction(intent.media, () => enqueue(intent)),
      });

      const unregisterPresentation = libraryDownloads.register({
        snapshot: () => `${JSON.stringify(model.state.get())}:${presentation.get()}`,
        subscribe: (listener) => {
          const first = model.state.subscribe(listener);
          const second = presentation.subscribe(listener);

          return () => {
            first();
            second();
          };
        },
        read: (media) => {
          const shown = libraryDownload(model.state.get().rows, media, (row, action) => {
            tapAction(media, async () => {
              if (action === "open") {
                try {
                  await downloads().playCopy(row);
                  router.push("/offline/play");
                } catch {
                  // playCopy refreshes the native missing-file state before refusing.
                }
              } else {
                const reason = await downloads().command(row, action);

                if (reason)
                  Alert.alert(
                    t(
                      reason === "playing"
                        ? "Stop playing this copy first."
                        : "The old copy is still closing. Try again.",
                    ),
                  );
              }
            });
          });

          if (!tapErrors.has(identity(media))) return shown;

          return {
            text: t("Couldn't save that change."),
            label: t("Try again"),
            icon: "retry",
            progress: 0,
            activate: () => {
              const retry = tapErrors.get(identity(media));

              if (retry) tapAction(media, retry);
            },
          };
        },
      });

      const unsubscribe = player.state.subscribe(() => void syncPlayer().catch(() => {}));

      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });

      const timer = setInterval(() => {
        void syncPlayer().catch(() => {});

        if (
          AppState.currentState === "active" &&
          (visible > 0 ||
            model.state.get().rows.some((row) => row.state === "queued" || row.state === "running"))
        )
          refresh();
      }, 1500);

      void model
        .refresh(!restored)
        .then(async () => {
          if (!restored) {
            held.clear();
            unconfirmed.clear();
          }

          restored = true;
          await syncPlayer(!!stop);
        })
        .catch(() => {});
      stop = () => {
        unregister();
        unregisterPresentation();
        unsubscribe();
        app.remove();
        clearInterval(timer);
        stop = undefined;
        void syncPlayer(false).catch(() => {});
      };

      return lease(screen);
    },
    async playCopy(row: DownloadRow) {
      if (removing.has(row.id)) throw new Error("removing");
      let path: string;

      try {
        path = await native.path(row.id);
      } catch (cause) {
        await model.refresh();
        throw cause;
      }

      if (removing.has(row.id)) throw new Error("removing");
      player.play({ kind: "file", path, title: row.title });
    },
    async command(row: DownloadRow, action: Action) {
      if (removing.has(row.id)) return null;
      removing.add(row.id);

      let refusal: "playing" | "closing" | null = null;

      try {
        await model.change(
          async () => {
            // Retry repeats the reader checks too, because playback may have changed.
            if (action === "remove" || action === "cancel") {
              const path = await native.filePath(row.id);

              if (path) {
                const current = player.state.get();

                if (
                  current.kind === "playing" &&
                  current.intent.kind === "file" &&
                  current.intent.path === path
                ) {
                  refusal = "playing";

                  return;
                }

                const release = await player.release(
                  (hold) => hold.kind === "file" && hold.path === path,
                );

                if (release.some((r) => r.outcome !== "file-closed")) {
                  refusal = "closing";

                  return;
                }
              }
            }

            await native.command(row.id, action);
          },
          `${row.id}:${action}`,
          async () => {
            const reason = await downloads().command(row, action);

            if (reason)
              Alert.alert(
                t(
                  reason === "playing"
                    ? "Stop playing this copy first."
                    : "The old copy is still closing. Try again.",
                ),
              );
          },
        );

        return refusal;
      } finally {
        removing.delete(row.id);
      }
    },
  };
}

/** The root calls startDownloads at cold launch, outside provider guards.
 * Each registration owns an idempotent lease; the last release stops subscriptions.
 */
export function startDownloads() {
  return downloads().start();
}

export function downloads() {
  return (owner ??= createRuntime());
}
