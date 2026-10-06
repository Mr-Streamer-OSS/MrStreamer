// A movie's or series' details, in a sheet over the page it was opened from, which stays in view
// behind it: the facts, the actions, the story, the cast with their photos, and a series'
// episodes. Resume is the main action for anything partly watched, and From the beginning plays
// at once, without asking. A title with several versions plays the one picked with the arrow
// beside Play, else the one it was opened on, as from the 4K tab, else the one that suits best;
// the sheet shows that version, so a series lists its episodes. A series opens on the season
// being watched, and marks the episode. Each episode's row carries everything known about it,
// TMDB's details once the season shown has its answer. The title from the lists heads the sheet
// at once; the rest follows when the provider answers, and TMDB's details when they arrive.
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Play, RotateCcw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  Episode,
  EpisodeDetails,
  MovieDetails,
  Person,
  SeriesDetails,
  Title,
  TitleDetails,
} from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { versionLabels } from "@mrstreamer/core/ondemand/languages";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { useUi, type DetailsTarget } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";
import { episodeNow } from "../../player/title-player.ts";
import {
  automaticVersion,
  movieNow,
  pickedVersion,
  resumePoint,
  runtime,
  timeLeftOf,
  playTitle,
  useInContinueWatching,
  usePickVersion,
  useRemoveFromContinue,
} from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";

const close = () => useUi.setState({ details: null });

/** Which version plays, and how the arrow beside Play offers the others. */
interface Versions {
  /** The title from the lists, with every version; null when they don't have it. */
  readonly title: Title | null;
  readonly playing: OwnedId;
  readonly picked: OwnedId | null;
  /** The version Automatic plays, which its line in the menu names. */
  readonly automatic: OwnedId;
}

export function DetailsView({ target }: { target: DetailsTarget }) {
  // Which version plays comes from the lists, the progress and the picks, all read without the
  // network, so only that version's details are asked for.
  const listed = useQuery(queries.titles(target.kind, [target]));
  const title = listed.data?.[0] ?? null;
  const versions = title?.versions ?? [];
  const progress = useQuery({
    ...queries.progress(target.kind === "movie" ? { movies: versions } : { series: versions }),
    enabled: versions.length > 0,
  });
  // The picks of the subscription the title was opened from.
  const picks = useQuery(queries.subscriptionPreferences(target.subscriptionId));
  const picked = title ? pickedVersion(title, picks.data) : null;
  const automatic = title
    ? automaticVersion(title, progress.data ?? [], target, target.asked)
    : ownedId(target);
  const playing = picked ?? automatic;
  const known = !listed.isPending && (!title || !progress.isPending) && !picks.isPending;
  // Another version's details replace these once they arrive; nothing plays from them meanwhile.
  // A new target mounts a new sheet (see App), so these are only ever the same title's.
  const details = useQuery({
    ...queries.details(target.kind, playing),
    enabled: known,
    placeholderData: keepPreviousData,
  });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-20 bg-black/65 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-x-[max(1.5rem,calc((100vw-68rem)/2))] top-[3.75rem] bottom-[var(--receiver-bar,0px)] z-20 overflow-y-auto overscroll-contain rounded-t-3xl bg-[#0b0b0c] shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0">
          {details.data ? (
            <Content
              details={details.data}
              versions={{ title, playing, picked, automatic }}
              switching={details.isPlaceholderData}
            />
          ) : title ? (
            <Header title={title} backdropUrl={title.backdropUrl} facts={factsOf(title)}>
              <p className="mt-6 text-[0.9375rem] text-muted-foreground">
                {details.error ? describeError(appError(details.error)) : "Loading…"}
              </p>
            </Header>
          ) : (
            <div className="p-10 text-[0.9375rem] text-muted-foreground">
              <Dialog.Title className="sr-only">Details</Dialog.Title>
              {details.error ? describeError(appError(details.error)) : "Loading…"}
            </div>
          )}
          {/* After the content, so focus starts on its main action rather than on Close. */}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 hover:bg-black/80"
          >
            <X className="size-4" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Content({
  details,
  versions,
  switching,
}: {
  details: TitleDetails;
  versions: Versions;
  /** Another version's details are on their way. */
  switching: boolean;
}) {
  return (
    <Header
      title={details.title}
      backdropUrl={details.backdropUrl}
      facts={factsOf(details.title, details)}
    >
      {details.kind === "movie" ? (
        <MovieActions details={details} versions={versions} switching={switching} />
      ) : (
        <SeriesActions details={details} versions={versions} switching={switching} />
      )}
      {details.plot && (
        <p className="mt-6 max-w-[48rem] text-[0.9375rem] leading-relaxed text-foreground/85">
          {details.plot}
        </p>
      )}
      <Credits details={details} />
      {details.kind === "series" && (
        <div inert={switching || undefined}>
          <Episodes details={details} />
        </div>
      )}
    </Header>
  );
}

/** "Original title …", the year, the length or seasons, genres and rating, as far as known. */
function factsOf(title: Title, details?: TitleDetails): string {
  return [
    details?.originalTitle ? `Original title ${details.originalTitle}` : null,
    title.year,
    details?.kind === "movie" && details.duration ? runtime(details.duration) : null,
    details?.kind === "series" && details.seasons.length > 0
      ? `${details.seasons.length} ${details.seasons.length === 1 ? "season" : "seasons"}`
      : null,
    (details ?? title).genres.slice(0, 3).join(", ") || null,
    title.rating ? `★ ${title.rating.toFixed(1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The backdrop, name and facts, with what follows them. */
function Header({
  title,
  backdropUrl,
  facts,
  children,
}: {
  title: Title;
  backdropUrl: string | null;
  facts: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="relative h-[clamp(12rem,32vh,22rem)] overflow-hidden rounded-t-3xl">
        <Artwork url={backdropUrl ?? title.posterUrl} name={title.title} size="full" plain />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0c] via-[#0b0b0c]/40 to-transparent" />
      </div>
      <div className="relative -mt-20 px-10 pb-12">
        <Dialog.Title className="text-4xl font-semibold tracking-tight text-balance">
          {title.title}
        </Dialog.Title>
        <div className="mt-2 text-[0.9375rem] text-muted-foreground">{facts}</div>
        {children}
      </div>
    </>
  );
}

/** Who is in it, with their photos and parts, and who directed or created it. */
function Credits({ details }: { details: TitleDetails }) {
  const cast = details.cast.slice(0, 8);
  const makers = details.directors.slice(0, 2);
  if (cast.length === 0 && makers.length === 0) return null;
  return (
    <div className="mt-6 flex gap-5 overflow-x-auto pb-1">
      {cast.map((person) => (
        <CastMember key={`${person.name}:${person.role ?? ""}`} person={person} />
      ))}
      {makers.length > 0 && (
        <div className="w-28 flex-none self-center text-[0.8125rem]">
          <div className="text-muted-foreground">
            {details.kind === "movie" ? "Directed by" : "Created by"}
          </div>
          {makers.map((name) => (
            <div key={name} className="truncate font-medium">
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CastMember({ person }: { person: Person }) {
  // A photo that doesn't load leaves the initials.
  const [failed, setFailed] = useState(false);
  const photo = failed ? null : person.photoUrl;
  return (
    <div className="w-[5.5rem] flex-none text-center">
      <div className="mx-auto size-16 overflow-hidden rounded-full bg-white/8 ring-1 ring-white/10">
        {photo ? (
          <img
            src={photo}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <span className="grid size-full place-items-center text-sm font-semibold text-white/80">
            {initials(person.name)}
          </span>
        )}
      </div>
      <div className="mt-2 truncate text-[0.8125rem] font-medium">{person.name}</div>
      {person.role && <div className="truncate text-xs text-muted-foreground">{person.role}</div>}
    </div>
  );
}

/** "AL" for Ada Lovelace. */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

function MovieActions({
  details,
  versions,
  switching,
}: {
  details: MovieDetails;
  versions: Versions;
  switching: boolean;
}) {
  const progress = useQuery(queries.progress({ movies: details.title.versions }));
  // Progress counts across versions: Resume carries on from there in the version that plays.
  const current = progress.data?.toSorted((a, b) => b.at - a.at)[0];
  const partly = current && !current.finished && current.position > 0;
  const now = movieNow({ ...details.title, ...versions.playing }, details.backdropUrl);
  const removal = useRemoveFromContinue();
  const listed = useInContinueWatching(details.title);
  return (
    <Actions
      versions={versions}
      switching={switching}
      progress={partly ? current : undefined}
      primaryLabel={partly ? "Resume" : "Play"}
      onPrimary={() => playTitle(now, resumePoint(partly ? current : undefined))}
      onBeginning={partly ? () => playTitle(now, 0) : null}
      onRemove={listed ? () => removal.mutate(details.title) : null}
      removeError={removal.error}
    />
  );
}

/**
 * An episode of these details matching a progress entry: the same one, or the same season and
 * number in another version of the series.
 */
function episodeOf(episodes: readonly Episode[], progress: TitleProgress): Episode | undefined {
  const { title } = progress;
  if (title.kind !== "episode") return undefined;
  return (
    episodes.find((episode) => sameOwned(episode, title)) ??
    episodes.find((episode) => episode.season === title.season && episode.number === title.episode)
  );
}

/** Where a series goes on: the episode watched last, its next one once finished, or the first. */
function resumeTarget(
  details: SeriesDetails,
  progress: readonly TitleProgress[],
): { episode: Episode; progress: TitleProgress | undefined } | null {
  const episodes = details.seasons.flatMap((season) => season.episodes);
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  const watched = latest && episodeOf(episodes, latest);
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

function SeriesActions({
  details,
  versions,
  switching,
}: {
  details: SeriesDetails;
  versions: Versions;
  switching: boolean;
}) {
  const progress = useQuery(queries.progress({ series: details.title.versions }));
  const removal = useRemoveFromContinue();
  const listed = useInContinueWatching(details.title);
  const target = resumeTarget(details, progress.data ?? []);
  if (!target) {
    return <p className="mt-6 text-[0.9375rem] text-muted-foreground">No episodes yet.</p>;
  }
  const { episode } = target;
  const partly = target.progress && target.progress.position > 0 ? target.progress : undefined;
  const label = `${partly ? "Resume" : "Play"} ${episodeLabel(episode.season, episode.number)}`;
  const now = episodeNow(details, episode);
  return (
    <Actions
      versions={versions}
      switching={switching}
      progress={partly}
      primaryLabel={label}
      onPrimary={() => playTitle(now, resumePoint(partly))}
      onBeginning={partly ? () => playTitle(now, 0) : null}
      onRemove={listed ? () => removal.mutate(details.title) : null}
      removeError={removal.error}
    />
  );
}

function Actions({
  versions,
  switching,
  progress,
  primaryLabel,
  onPrimary,
  onBeginning,
  onRemove,
  removeError,
}: {
  versions: Versions;
  /** Another version's details are on their way: nothing plays until they're here. */
  switching: boolean;
  progress: TitleProgress | undefined;
  primaryLabel: string;
  onPrimary: () => void;
  onBeginning: (() => void) | null;
  /** Shown while Continue watching holds the title. */
  onRemove: (() => void) | null;
  /** Why the last removal failed. */
  removeError: Error | null;
}) {
  const { title, playing, automatic } = versions;
  const all = title?.versions ?? [];
  const labels = versionLabels(all, title?.originalLanguage ?? null);
  const labelOf = (named: OwnedId) => labels[all.findIndex((version) => sameOwned(version, named))];
  const label = labelOf(playing);
  const several = title !== null && all.length > 1;
  return (
    <div className="mt-6">
      {progress && (
        <div className="mb-4 flex items-center gap-3">
          <Progress value={progress.position / progress.duration} className="w-56" />
          <span className="text-[0.8125rem] text-muted-foreground">{timeLeftOf(progress)}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex">
          {/* Focused as the details arrive, so Enter plays. */}
          <Button
            variant="primary"
            size="lg"
            autoFocus
            disabled={switching}
            onClick={onPrimary}
            className={cn(several && "rounded-r-none pr-5")}
          >
            <Play className="fill-current" />
            {primaryLabel}
          </Button>
          {several && (
            <VersionMenu
              title={title}
              picked={versions.picked}
              labels={labels}
              automatic={labelOf(automatic) ?? null}
            >
              <ChevronDown />
            </VersionMenu>
          )}
        </div>
        {onBeginning && (
          <Button variant="secondary" size="lg" disabled={switching} onClick={onBeginning}>
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
      {/* What plays: "English sound · 4K". A version without marks says nothing. */}
      {label && (several || label !== "Standard") && (
        <div className="mt-3 text-[0.8125rem] text-muted-foreground">{label}</div>
      )}
      {removeError && (
        <p className="mt-3 text-sm text-destructive">{describeError(appError(removeError))}</p>
      )}
    </div>
  );
}

/** The menu's value for Automatic. A version's is its `ownedKey`, which always holds a colon. */
const AUTOMATIC = "automatic";

/** The arrow beside Play: Automatic, or one version, remembered for the title. */
function VersionMenu({
  title,
  picked,
  labels,
  automatic,
  children,
}: {
  title: Title;
  picked: OwnedId | null;
  labels: readonly string[];
  /** What Automatic plays. */
  automatic: string | null;
  children: ReactNode;
}) {
  const pick = usePickVersion();
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="primary"
            size="lg"
            aria-label="Versions"
            className="rounded-l-none border-l border-black/20 px-3"
          />
        }
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
          <Menu.Popup className="max-h-[60vh] w-max min-w-[18rem] max-w-[26rem] overflow-y-auto rounded-2xl bg-popover p-2 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Menu.RadioGroup
              value={picked ? ownedKey(picked) : AUTOMATIC}
              onValueChange={(value: string) =>
                pick(title, title.versions.find((version) => ownedKey(version) === value) ?? null)
              }
            >
              <VersionItem value={AUTOMATIC}>
                Automatic
                {automatic && <span className="text-muted-foreground"> · {automatic}</span>}
              </VersionItem>
              {title.versions.map((version, index) => (
                <VersionItem key={ownedKey(version)} value={ownedKey(version)}>
                  {labels[index]}
                </VersionItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function VersionItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Menu.RadioItem
      value={value}
      closeOnClick
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-foreground/80 outline-none data-checked:text-white data-highlighted:bg-white/6"
    >
      <span className="grid size-1.5 flex-none">
        <Menu.RadioItemIndicator className="size-1.5 rounded-full bg-white" />
      </span>
      <span className="min-w-0">{children}</span>
    </Menu.RadioItem>
  );
}

/** Guest stars an episode's row names. */
const GUESTS_SHOWN = 2;

const airDay = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "5 Mar 2024" from "2024-03-05"; a date written another way stays as it is. */
function airDate(text: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return day ? airDay.format(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) : text;
}

/** "Directed by Lotte Smit · With Ana Costa, Eva Vos", or "" when TMDB named no one. */
function creditsOf(episode: Partial<EpisodeDetails>): string {
  const directors = episode.directors ?? [];
  const guests = (episode.cast ?? []).slice(0, GUESTS_SHOWN).map((person) => person.name);
  return [
    directors.length > 0 ? `Directed by ${directors.join(", ")}` : null,
    guests.length > 0 ? `With ${guests.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Episodes({ details }: { details: SeriesDetails }) {
  const progress = useQuery(queries.progress({ series: details.title.versions }));
  const byEpisode = new Map((progress.data ?? []).map((entry) => [ownedKey(entry.title), entry]));
  // Another version's episodes count by season and number; the latest wins.
  const byNumber = new Map(
    (progress.data ?? [])
      .toSorted((a, b) => a.at - b.at)
      .flatMap((entry) =>
        entry.title.kind === "episode"
          ? [[`${entry.title.season}:${entry.title.episode}`, entry] as const]
          : [],
      ),
  );
  const target = resumeTarget(details, progress.data ?? []);
  // The season picked here, else the one being watched once progress has loaded.
  const [picked, setSeason] = useState<number | null>(null);
  const season = picked ?? target?.episode.season ?? details.seasons[0]?.number ?? 1;
  const shown = details.seasons.find((each) => each.number === season) ?? details.seasons[0];
  // TMDB's details for the season shown, asked for as it shows. The provider's episodes stand
  // until they come, and the rows grow once, together.
  const enriched = useQuery({
    ...queries.season(details.title, shown?.number ?? season),
    enabled: shown !== undefined,
  });
  if (!shown) return null;
  const episodes: readonly (Episode & Partial<EpisodeDetails>)[] = enriched.data ?? shown.episodes;
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
        {episodes.map((episode) => {
          const done =
            byEpisode.get(ownedKey(episode)) ?? byNumber.get(`${episode.season}:${episode.number}`);
          const current = sameOwned(target?.episode, episode);
          const partly = done && !done.finished && done.position > 0 ? done : undefined;
          const facts = [
            episode.airDate ? airDate(episode.airDate) : null,
            timeLeftOf(partly) ?? (episode.duration ? runtime(episode.duration) : null),
          ]
            .filter(Boolean)
            .join(" · ");
          const credits = creditsOf(episode);
          return (
            <button
              key={episode.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => playTitle(episodeNow(details, episode), resumePoint(partly))}
              // Rows hold their top as they grow, so what is in view stays put.
              className={cn(
                "grid w-full grid-cols-[2.5rem_12.5rem_minmax(0,1fr)_auto] items-start gap-4 rounded-xl px-2 py-3 text-left hover:bg-white/5",
                current && "bg-white/[0.04]",
              )}
            >
              <span className="text-center text-lg text-muted-foreground tabular-nums">
                {episode.number}
              </span>
              <span className="relative block aspect-video overflow-hidden rounded-lg">
                <Artwork
                  url={episode.stillUrl}
                  name={episode.title}
                  size="wide"
                  className="text-[0.625rem]"
                />
              </span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">
                    {episode.title}
                  </span>
                  {episode.rating != null && (
                    <span className="flex-none text-[0.8125rem] text-muted-foreground">
                      ★ {episode.rating.toFixed(1)}
                    </span>
                  )}
                </span>
                {facts && (
                  <span className="block truncate text-xs text-muted-foreground">{facts}</span>
                )}
                {partly && (
                  <Progress value={partly.position / partly.duration} className="mt-2 w-40" />
                )}
                {episode.plot && (
                  <span className="mt-1 line-clamp-3 block text-[0.8125rem] text-foreground/85">
                    {episode.plot}
                  </span>
                )}
                {credits && (
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {credits}
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
