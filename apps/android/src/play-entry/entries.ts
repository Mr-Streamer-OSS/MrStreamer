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
  refused(): void;
  progress(title: Title): Promise<readonly TitleProgress[]>;
  subscribe(listener: () => void): () => void;
}) {
  let active = true;
  let request = 0;
  let stopNext: (() => void) | undefined;

  const attempt = () => {
    const state = options.player.state.get();

    return state.kind === "playing" ? state.attempt : null;
  };

  const play = async (intent: PlayIntent, media?: MediaIdentity) => {
    const run = ++request;
    const before = attempt();
    const stands = () => active && request === run && attempt() === before;

    let admitted = intent;

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
        const details = await model.details({ ...title, ...version });

        if (!stands()) return;

        if (details.providerFailed || model.reader(intent.sourceId) !== reader)
          throw new Error("Details unavailable");

        const exact =
          intent.media === "movie"
            ? version.id === intent.id &&
              (version.container?.trim() || details.containers.get(intent.id))
            : details.value?.kind === "series" &&
              details.value.seasons.some((s) => s.episodes.some((e) => e.id === intent.id)) &&
              details.containers.get(intent.id);

        if (exact !== intent.container) throw new Error("File unavailable");
        const progress = await options.progress({ ...title, ...version, versions: [version] });

        if (!stands() || model.reader(intent.sourceId) !== reader) return;
        const sourceId = intent.sourceId;

        const position = (id: string) =>
          resumePoint(
            progress.find((p) => p.title.subscriptionId === sourceId && p.title.id === id),
          ) * 1000;

        admitted = { ...intent, resumeAt: intent.resumeAt ?? position(intent.id) };
        stopNext?.();
        stopNext = options.player.media.registerNext((current) => {
          if (
            !active ||
            model.reader(current.sourceId) !== reader ||
            current.sourceId !== media.sourceId
          )
            return undefined;
          const next = nextEpisodeIn(details, current);

          return next
            ? { ...next, intent: { ...next.intent, resumeAt: position(next.intent.id) } }
            : undefined;
        });
      }

      if (!stands()) return;
      options.player.play(admitted);
      options.open(admitted);
    } catch {
      if (stands()) options.refused();
    }
  };

  // A source change or cleanup withdraws pending admissions and the registered Next.
  const withdraw = () => {
    ++request;
    stopNext?.();
    stopNext = undefined;
  };

  const stopAuthority = options.subscribe(withdraw);
  const unregister = options.intents.register({ play });

  return () => {
    active = false;
    withdraw();
    unregister();
    stopAuthority();
  };
}
