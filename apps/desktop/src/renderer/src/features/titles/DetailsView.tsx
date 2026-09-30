// A movie's or series' details, in a sheet over the page it was opened from, which stays in view
// behind it. Resume is the main action for anything partly watched, and From the beginning plays
// at once, without asking. A series opens on the season being watched, and marks the episode.
import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Check, Play, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type {
  Episode,
  MovieDetails,
  SeriesDetails,
  TitleDetails,
} from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { useUi, type DetailsTarget } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";
import {
  episodeLabel,
  episodeNow,
  movieNow,
  nextEpisode,
  removeFromContinue,
  resumePoint,
  runtime,
  timeLeftOf,
  usePlayTitle,
} from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";

const close = () => useUi.setState({ details: null });

export function DetailsView({ target }: { target: DetailsTarget }) {
  const details = useQuery(queries.details(target.kind, target.id));
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-20 bg-black/65 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-x-[max(1.5rem,calc((100vw-68rem)/2))] top-[3.75rem] bottom-0 z-20 overflow-y-auto overscroll-contain rounded-t-3xl bg-[#0b0b0c] shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0">
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 hover:bg-black/80"
          >
            <X className="size-4" />
          </Dialog.Close>
          {details.data ? (
            <Content details={details.data} />
          ) : (
            <div className="p-10 text-[0.9375rem] text-muted-foreground">
              <Dialog.Title className="sr-only">Details</Dialog.Title>
              {details.error ? describeError(appError(details.error)) : "Loading…"}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Content({ details }: { details: TitleDetails }) {
  const { title } = details;
  const facts = [
    title.year,
    details.kind === "movie" && details.duration ? runtime(details.duration) : null,
    details.kind === "series" && details.seasons.length > 0
      ? `${details.seasons.length} ${details.seasons.length === 1 ? "season" : "seasons"}`
      : null,
    details.genres.slice(0, 3).join(", ") || null,
    title.rating ? `★ ${title.rating.toFixed(1)}` : null,
    ...title.tags,
  ].filter(Boolean);
  return (
    <>
      <div className="relative h-[clamp(12rem,32vh,22rem)] overflow-hidden rounded-t-3xl">
        <Artwork url={details.backdropUrl ?? title.posterUrl} name={title.title} plain />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0c] via-[#0b0b0c]/40 to-transparent" />
      </div>
      <div className="relative -mt-20 px-10 pb-12">
        <Dialog.Title className="text-4xl font-semibold tracking-tight text-balance">
          {title.title}
        </Dialog.Title>
        {details.originalTitle && (
          <div className="mt-1 text-[0.9375rem] text-muted-foreground">{details.originalTitle}</div>
        )}
        <div className="mt-2 text-[0.9375rem] text-muted-foreground">{facts.join(" · ")}</div>
        {details.kind === "movie" ? (
          <MovieActions details={details} />
        ) : (
          <SeriesActions details={details} />
        )}
        {details.plot && (
          <p className="mt-6 max-w-[48rem] text-[0.9375rem] leading-relaxed text-foreground/85">
            {details.plot}
          </p>
        )}
        {(details.cast.length > 0 || details.directors.length > 0) && (
          <div className="mt-3 max-w-[48rem] text-[0.8125rem] text-muted-foreground">
            {[details.cast.slice(0, 5).join(", "), details.directors.slice(0, 2).join(", ")]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
        {details.kind === "series" && <Episodes details={details} />}
      </div>
    </>
  );
}

function MovieActions({ details }: { details: MovieDetails }) {
  const progress = useQuery(queries.progress({ movieIds: [details.title.id] }));
  const play = usePlayTitle();
  const current = progress.data?.[0];
  const partly = current && !current.finished && current.position > 0;
  const now = movieNow(details.title, details.backdropUrl);
  return (
    <Actions
      progress={partly ? current : undefined}
      primaryLabel={partly ? "Resume" : "Play"}
      onPrimary={() => play(now, resumePoint(partly ? current : undefined))}
      onBeginning={partly ? () => play(now, 0) : null}
      onRemove={partly ? () => removeFromContinue(now.title) : null}
    />
  );
}

/** Where a series goes on: the episode watched last, its next one once finished, or the first. */
function resumeTarget(
  details: SeriesDetails,
  progress: readonly TitleProgress[],
): { episode: Episode; progress: TitleProgress | undefined } | null {
  const episodes = details.seasons.flatMap((season) => season.episodes);
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  const watched = latest && episodes.find((episode) => episode.id === latest.title.id);
  if (latest && watched) {
    if (!latest.finished) return { episode: watched, progress: latest };
    const next = nextEpisode(details, { season: watched.season, episode: watched.number });
    if (next) return { episode: next, progress: undefined };
  }
  // The first episode of the first numbered season, before specials.
  const first = details.seasons.find((season) => season.number > 0) ?? details.seasons[0];
  const episode = first?.episodes[0];
  return episode ? { episode, progress: undefined } : null;
}

function SeriesActions({ details }: { details: SeriesDetails }) {
  const progress = useQuery(queries.progress({ seriesId: details.title.id }));
  const play = usePlayTitle();
  const target = resumeTarget(details, progress.data ?? []);
  if (!target) {
    return <p className="mt-6 text-[0.9375rem] text-muted-foreground">No episodes yet.</p>;
  }
  const { episode } = target;
  const partly = target.progress && target.progress.position > 0 ? target.progress : undefined;
  const label = `${partly ? "Resume" : "Play"} ${episodeLabel(episode.season, episode.number)}`;
  const now = episodeNow(details, episode);
  const started = (progress.data?.length ?? 0) > 0;
  return (
    <Actions
      progress={partly}
      primaryLabel={label}
      onPrimary={() => play(now, resumePoint(partly))}
      onBeginning={partly ? () => play(now, 0) : null}
      onRemove={started ? () => removeFromContinue(now.title) : null}
    />
  );
}

function Actions({
  progress,
  primaryLabel,
  onPrimary,
  onBeginning,
  onRemove,
}: {
  progress: TitleProgress | undefined;
  primaryLabel: string;
  onPrimary: () => void;
  onBeginning: (() => void) | null;
  onRemove: (() => void) | null;
}) {
  return (
    <div className="mt-6">
      {progress && (
        <div className="mb-4 flex items-center gap-3">
          <Progress value={progress.position / progress.duration} className="w-56" />
          <span className="text-[0.8125rem] text-muted-foreground">{timeLeftOf(progress)}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onPrimary}>
          <Play className="fill-current" />
          {primaryLabel}
        </Button>
        {onBeginning && (
          <Button variant="secondary" size="lg" onClick={onBeginning}>
            <RotateCcw />
            From the beginning
          </Button>
        )}
        {onRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Remove from Continue watching
          </Button>
        )}
      </div>
    </div>
  );
}

function Episodes({ details }: { details: SeriesDetails }) {
  const progress = useQuery(queries.progress({ seriesId: details.title.id }));
  const play = usePlayTitle();
  const byEpisode = new Map((progress.data ?? []).map((entry) => [entry.title.id, entry]));
  const target = resumeTarget(details, progress.data ?? []);
  const [season, setSeason] = useState(
    () => target?.episode.season ?? details.seasons[0]?.number ?? 1,
  );
  const shown = details.seasons.find((each) => each.number === season) ?? details.seasons[0];
  if (!shown) return null;
  return (
    <section className="mt-10">
      {details.seasons.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-6 gap-y-2 border-b border-border">
          {details.seasons.map((each) => (
            <button
              key={each.number}
              aria-pressed={each.number === shown.number}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSeason(each.number)}
              className={cn(
                "-mb-px border-b-2 pb-2 text-[0.9375rem]",
                each.number === shown.number
                  ? "border-white font-semibold text-white"
                  : "border-transparent text-muted-foreground hover:text-white",
              )}
            >
              {each.name}
            </button>
          ))}
        </div>
      )}
      <div>
        {shown.episodes.map((episode) => {
          const done = byEpisode.get(episode.id);
          const current = target?.episode.id === episode.id;
          const partly = done && !done.finished && done.position > 0 ? done : undefined;
          return (
            <button
              key={episode.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => play(episodeNow(details, episode), resumePoint(partly))}
              className={cn(
                "grid w-full grid-cols-[2.5rem_11rem_minmax(0,1fr)_auto] items-center gap-4 rounded-xl px-2 py-3 text-left hover:bg-white/5",
                current && "bg-white/[0.04]",
              )}
            >
              <span className="text-center text-lg text-muted-foreground tabular-nums">
                {episode.number}
              </span>
              <span className="relative block aspect-video overflow-hidden rounded-lg">
                <Artwork url={episode.stillUrl} name={episode.title} className="text-[0.625rem]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[0.9375rem] font-medium">{episode.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[episode.duration ? runtime(episode.duration) : null, episode.airDate]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {partly && (
                  <Progress value={partly.position / partly.duration} className="mt-2 w-40" />
                )}
                {episode.plot && (
                  <span className="mt-1 line-clamp-2 block text-[0.8125rem] text-muted-foreground">
                    {episode.plot}
                  </span>
                )}
              </span>
              <span className="w-6 text-muted-foreground">
                {done?.finished && <Check className="size-4" aria-label="Watched" />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
