import type { Title } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { resumePoint } from "@mrstreamer/core/viewing/continue";
import type { LibraryModel } from "../library/model.ts";
import type { MediaIdentity, intentRegistry } from "../library/intents.ts";
import type { PlayIntent } from "../player/intent.ts";
import type { PlayerOwner } from "../player/player.ts";
import { nextEpisode as nextEpisodeIn } from "../player/next-episode.ts";

/** App-owned admission for Library actions. Async details cannot outlive another play or cleanup. */
export function startEntries(options: {
  intents: ReturnType<typeof intentRegistry>;
  player: PlayerOwner;
  library(): LibraryModel;
  open(intent: PlayIntent): void;
  refused(reason: "details" | "file" | "history", retry: () => void, beginning?: () => void): void;
  progress(title: Title): Promise<readonly TitleProgress[]>;
  subscribe(listener: () => void): () => void;
}) {
  let active = true;
  let request = 0;
  let stopNext: (() => void) | undefined;

  let authority: (() => boolean) | undefined;
  let nextAuthority: (() => boolean) | undefined;
  let lastAttempt: string | null = null;

  const observePlayer = () => {
    const state = options.player.state.get();

    if (state.kind === "playing") lastAttempt = state.attempt;
  };

  observePlayer();
  const stopPlayer = options.player.state.subscribe(observePlayer);

  const play = async (intent: PlayIntent, media?: MediaIdentity) => {
    const run = ++request;
    const before = lastAttempt;
    const stands = () => active && request === run && lastAttempt === before;

    authority = undefined;
    let admitted = intent;
    let playingAttempt: string | null = null;
    let failure: "details" | "file" | "history" = "file";

    try {
      if (intent.kind === "title") {
        if (
          !media ||
          media.sourceId !== intent.sourceId ||
          media.version.subscriptionId !== intent.sourceId ||
          (media.kind === "movie"
            ? intent.media !== "movie"
            : intent.media !== "episode" || media.episodeId !== intent.id)
        )
          throw new Error("Missing version");
        const model = options.library();
        const reader = model.reader(intent.sourceId);
        const title = model.title(media.kind === "movie" ? "movie" : "series", media.titleKey);

        const version = title?.versions.find(
          (v) => v.subscriptionId === intent.sourceId && v.id === media.version.id,
        );

        if (!title || !version || !reader) throw new Error("Version unavailable");
        authority = () => options.library().reader(intent.sourceId) === reader;
        failure = "details";
        const details = await model.details({ ...title, ...version });

        if (!stands()) return;

        if (details.providerFailed || model.reader(intent.sourceId) !== reader)
          throw new Error("Details unavailable");

        failure = "file";

        const exact =
          intent.media === "movie"
            ? version.id === intent.id &&
              (version.container?.trim() || details.containers.get(intent.id))
            : details.value?.kind === "series" &&
              details.value.seasons.some((s) =>
                s.episodes.some(
                  (e) => e.id === intent.id || e.versions?.some((v) => v.id === intent.id),
                ),
              ) &&
              details.containers.get(intent.id);

        if (exact !== intent.container) throw new Error("File unavailable");
        failure = "history";

        const selected = { ...title, ...version, versions: [version] };
        let progress: readonly TitleProgress[] | undefined;

        if (intent.resumeAt === undefined) progress = await options.progress(selected);

        if (!stands() || model.reader(intent.sourceId) !== reader) return;
        const sourceId = intent.sourceId;

        const position = (id: string) =>
          resumePoint(
            progress?.find((p) => p.title.subscriptionId === sourceId && p.title.id === id),
          ) * 1000;

        admitted = { ...intent, resumeAt: intent.resumeAt ?? position(intent.id) };
        stopNext?.();
        nextAuthority = authority;
        const currentAuthority = authority;

        const publishNext = () => {
          stopNext?.();
          stopNext = options.player.media.registerNext((current) => {
            if (
              !active ||
              !progress ||
              model.reader(current.sourceId) !== reader ||
              current.sourceId !== media.sourceId
            )
              return undefined;
            const next = nextEpisodeIn(details, current);

            return next
              ? { ...next, intent: { ...next.intent, resumeAt: position(next.intent.id) } }
              : undefined;
          });
        };

        publishNext();

        // Known current positions play immediately. Next stays unavailable until history succeeds.
        if (!progress && intent.media === "episode") {
          const historyStands = () =>
            active &&
            request === run &&
            nextAuthority === currentAuthority &&
            currentAuthority() &&
            lastAttempt === playingAttempt;

          void Promise.resolve().then(async () => {
            try {
              const saved = await options.progress(selected);

              if (!historyStands()) return;
              progress = saved;
              publishNext();
            } catch {
              // A failed read cannot supply a zero-position successor. A later Play retries it.
            }
          });
        }
      }

      if (!stands()) return;

      if (intent.kind !== "title") {
        stopNext?.();
        stopNext = undefined;
        nextAuthority = undefined;
      }

      options.player.play(admitted);
      playingAttempt = lastAttempt;
      authority = undefined;
      options.open(admitted);
    } catch {
      if (stands())
        options.refused(
          failure,
          () => {
            void play(intent, media);
          },
          failure === "history" && intent.kind === "title"
            ? () => {
                void play({ ...intent, resumeAt: 0 }, media);
              }
            : undefined,
        );
    }
  };

  // Only the admitted reader changing withdraws pending Play and Next; catalogue ticks do not.
  const withdraw = () => {
    ++request;
    stopNext?.();
    stopNext = undefined;
  };

  const stopAuthority = options.subscribe(() => {
    if (authority && !authority()) ++request;

    if (nextAuthority && !nextAuthority()) {
      stopNext?.();
      stopNext = undefined;
      nextAuthority = undefined;
    }
  });

  const unregister = options.intents.register({ play });

  return () => {
    active = false;
    withdraw();
    unregister();
    stopAuthority();
    stopPlayer();
  };
}
