// A movie's or series' details, in a sheet over the page it was opened from, which stays in view
// behind it: the facts, the actions, the story, the cast with their photos, and a series'
// episodes. Resume is the main action for anything partly watched, and From the beginning plays
// at once, without asking. Save puts the movie or the whole series on the watchlist and takes it
// off again; it goes by the title in the lists, so it works before the details arrive. A title
// with several versions plays the one picked with the arrow beside Play, else the one it was
// opened on, as from the 4K tab, else the one that suits best; the sheet shows that version, so a
// series lists its episodes. The versions can be of several subscriptions: the menu then names
// each one's, and Resume goes by how far the version that plays got in its own subscription,
// never by another's. A series opens on the season being watched, and marks the episode. Each
// episode's row carries everything known about it, TMDB's details once the season shown has its
// answer, and beside it the three dots that mark it watched or unwatched by hand (see
// EpisodeMarks.tsx). Where a series goes on, and how each episode stands, follow one set of rules
// (`@mrstreamer/core/viewing/episodes`), which Continue watching and the player go by too, on
// what the viewing record says: when it can't be read, the sheet says so, names no episode to go
// on with and shows none as watched or not. The title from the lists heads the sheet at once; the
// rest follows when the provider answers, and TMDB's details when they arrive.
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, CircleDashed, Play, RotateCcw } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
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
import { episodeFileVersion } from "@mrstreamer/core/ondemand/details";
import { versionLabels } from "@mrstreamer/core/ondemand/languages";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { continuation, episodeStates } from "@mrstreamer/core/viewing/episodes";
import { openSubscription, useUi, type DetailsTarget } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import {
  queries,
  subscriptionName,
  useSubscriptionNames,
  useSubscriptionPreferences,
  useSubscriptions,
} from "../../lib/queries.ts";
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
import { useSaveToggle, type SaveToggle } from "../../lib/watchlist.ts";
import { SaveButton, SaveError } from "../watchlist/SaveButton.tsx";
import { EpisodeMenu, MarkNotice, useEpisodeMarks } from "./EpisodeMarks.tsx";

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
  // A pick is kept by the subscription of the version picked.
  const picks = useSubscriptionPreferences();
  const picked = title ? pickedVersion(title, picks) : null;
  const automatic = title
    ? automaticVersion(title, progress.data ?? [], target, target.asked)
    : ownedId(target);
  const playing = picked ?? automatic;
  const known = !listed.isPending && (!title || !progress.isPending) && picks !== undefined;
  // Another version's details replace these once they arrive; nothing plays from them meanwhile.
  // A new target mounts a new sheet (see App), so these are only ever the same title's.
  const details = useQuery({
    ...queries.details(target.kind, playing),
    enabled: known,
    placeholderData: keepPreviousData,
  });
  // How a series' episodes stand in the subscription of the version that plays: read beside its
  // details, so the sheet opens on where the series goes on and never on a guess. When it can't
  // be read the sheet opens all the same, and says so in place of where the series goes on.
  const standing = useQuery({
    ...queries.episodes(playing),
    enabled: known && target.kind === "series",
    placeholderData: keepPreviousData,
  });
  // Once it answered, or failed, the sheet stays up while it is read again.
  const ready = target.kind !== "series" || !standing.isPending || standing.isFetched;
  const failure = details.error ? appError(details.error) : null;
  // The version that plays is of a subscription whose password or link the keychain lost.
  const subscriptions = useSubscriptions();
  const locked =
    failure?.kind === "needs-secret"
      ? subscriptions.find((each) => each.id === failure.subscriptionId)
      : undefined;
  const secret = locked?.kind === "m3u" ? "link" : "password";
  // Saving needs the title from the lists alone, so it works while the details are on their way.
  const saving = useSaveToggle(target.kind, target, title !== null);
  return (
    <Sheet onClose={close}>
      {details.data && ready ? (
        <Content
          details={details.data}
          versions={{ title, playing, picked, automatic }}
          switching={details.isPlaceholderData}
          saving={saving}
        />
      ) : title ? (
        <Header title={title} backdropUrl={title.backdropUrl} facts={factsOf(title)}>
          <div className="mt-6">
            <SaveButton state={saving} />
            <SaveError state={saving} />
          </div>
          <p className="mt-6 text-[0.9375rem] text-muted-foreground">
            {locked
              ? `${subscriptionName(locked)} needs its ${secret} again.`
              : failure
                ? describeError(failure)
                : "Loading…"}
          </p>
          {/* The version that plays couldn't be opened: its subscription's row in Settings is
              where its secret is entered again, and another version may play meanwhile, as one
              another subscription lists. */}
          {failure && (locked || title.versions.length > 1) && (
            <div className="mt-4 flex items-center gap-3">
              {locked && (
                <Button variant="primary" onClick={() => openSubscription(locked.id, "secret")}>
                  Enter {secret}
                </Button>
              )}
              {title.versions.length > 1 && (
                <VersionMenu
                  title={title}
                  picked={picked}
                  automatic={automatic}
                  trigger={<Button variant="secondary" />}
                >
                  Other versions
                  <ChevronDown />
                </VersionMenu>
              )}
            </div>
          )}
        </Header>
      ) : (
        <div className="p-10 text-[0.9375rem] text-muted-foreground">
          <Dialog.Title className="sr-only">Details</Dialog.Title>
          {failure ? describeError(failure) : "Loading…"}
        </div>
      )}
    </Sheet>
  );
}

function Content({
  details,
  versions,
  switching,
  saving,
}: {
  details: TitleDetails;
  versions: Versions;
  /** Another version's details are on their way. */
  switching: boolean;
  saving: SaveToggle;
}) {
  return (
    <Header
      title={details.title}
      backdropUrl={details.backdropUrl}
      facts={factsOf(details.title, details)}
    >
      {details.kind === "movie" ? (
        <MovieActions details={details} versions={versions} switching={switching} saving={saving} />
      ) : (
        <SeriesActions
          details={details}
          versions={versions}
          switching={switching}
          saving={saving}
        />
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
  saving,
}: {
  details: MovieDetails;
  versions: Versions;
  switching: boolean;
  saving: SaveToggle;
}) {
  const progress = useQuery(queries.progress({ movies: details.title.versions }));
  // Progress counts across a subscription's versions: Resume carries on from there in the
  // version that plays.
  const current = ownProgress(progress.data, versions.playing).toSorted((a, b) => b.at - a.at)[0];
  const partly = current && !current.finished && current.position > 0;
  const now = movieNow({ ...details.title, ...versions.playing }, details.backdropUrl);
  const removal = useRemoveFromContinue();
  const listed = useInContinueWatching(details.title);
  return (
    <Actions
      versions={versions}
      switching={switching}
      saving={saving}
      progress={partly ? current : undefined}
      primaryLabel={partly ? "Resume" : "Play"}
      onPrimary={() => playTitle(now, resumePoint(partly ? current : undefined))}
      onBeginning={partly ? () => playTitle(now, 0) : null}
      onRemove={listed ? () => removal.mutate(details.title) : null}
      removeError={removal.error}
    />
  );
}

const NO_PROGRESS: readonly TitleProgress[] = [];

/**
 * How far the versions of `version`'s own subscription got. Another subscription's file is
 * another file, with its own length and its own episodes: where it stopped says nothing of where
 * this one resumes.
 */
function ownProgress(
  progress: readonly TitleProgress[] | undefined,
  version: { readonly subscriptionId: string },
): readonly TitleProgress[] {
  if (!progress) return NO_PROGRESS;
  return progress.filter((entry) => entry.title.subscriptionId === version.subscriptionId);
}

/**
 * How the episodes of the series version these details are of stand, in its own subscription,
 * as the main process last read them: what it read before stays when a later read fails.
 * `error` says why there is nothing to go by. No episode counts as unwatched on that.
 */
function useStanding(details: SeriesDetails) {
  // The sheet asked as it opened: a read that failed is tried again when the viewer says so, or
  // the record changes, and not by each part of the sheet that shows up.
  const read = useQuery({ ...queries.episodes(ownedId(details.title)), retryOnMount: false });
  return {
    standing: read.data,
    error: read.data || !read.error ? null : appError(read.error),
    retry: () => void read.refetch(),
  };
}

function SeriesActions({
  details,
  versions,
  switching,
  saving,
}: {
  details: SeriesDetails;
  versions: Versions;
  switching: boolean;
  saving: SaveToggle;
}) {
  const { standing, error, retry } = useStanding(details);
  const removal = useRemoveFromContinue();
  const listed = useInContinueWatching(details.title);
  if (!standing) {
    // Where the series goes on can't be said: nothing offers to play or resume on a guess. The
    // episodes below still play, each from its beginning.
    return (
      <div className="mt-6">
        <SaveButton state={saving} />
        <SaveError state={saving} />
        {error && (
          <p role="alert" className="mt-6 text-[0.9375rem] text-destructive">
            Couldn't read what you watched. {describeError(error)}{" "}
            <button onClick={retry} className="text-white underline underline-offset-4">
              Try again
            </button>
          </p>
        )}
      </div>
    );
  }
  const target = continuation(details, standing.progress, standing.marks);
  if (!target) {
    // Nothing to play yet, and still a series to save for when there is.
    return (
      <div className="mt-6">
        <SaveButton state={saving} />
        <SaveError state={saving} />
        <p className="mt-6 text-[0.9375rem] text-muted-foreground">No episodes yet.</p>
      </div>
    );
  }
  const { episode, resume: partly, replay } = target;
  // Replay once every numbered episode is watched: the first of them, from its beginning.
  const verb = replay ? "Replay" : partly ? "Resume" : "Play";
  const label = `${verb} ${episodeLabel(episode.season, episode.number)}`;
  const now = episodeNow(details, episode);
  return (
    <Actions
      versions={versions}
      switching={switching}
      saving={saving}
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
  saving,
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
  saving: SaveToggle;
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
  const named = useVersionNames(title);
  const said = named(playing);
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
            <VersionMenu title={title} picked={versions.picked} automatic={automatic}>
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
        <SaveButton state={saving} />
        {onRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Remove from Continue watching
          </Button>
        )}
      </div>
      {/* What plays: "English sound · 4K", and whose it is once several subscriptions list the
          title. A version without marks says nothing more. */}
      {said && (several || said.label !== "Standard" || said.source) && (
        <div className="mt-3 text-[0.8125rem] text-muted-foreground">
          {[several || said.label !== "Standard" ? said.label : null, said.source]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      <SaveError state={saving} />
      {removeError && (
        <p className="mt-3 text-sm text-destructive">{describeError(appError(removeError))}</p>
      )}
    </div>
  );
}

/**
 * What each version of `title` is called: what it sounds like and subtitles, and the name of its
 * subscription once the versions are of more than one. Versions that read the same are numbered
 * within their own subscription, whose name tells them apart from another's.
 */
function useVersionNames(
  title: Title | null,
): (version: OwnedId) => { readonly label: string; readonly source: string | null } | null {
  const nameOf = useSubscriptionNames();
  const all = title?.versions ?? [];
  const owners = [...new Set(all.map((version) => version.subscriptionId))];
  const labels = new Map(
    owners.flatMap((subscriptionId) => {
      const own = all.filter((version) => version.subscriptionId === subscriptionId);
      const read = versionLabels(own, title?.originalLanguage ?? null);
      return own.map((version, at) => [ownedKey(version), read[at] ?? "Standard"] as const);
    }),
  );
  return (version) => {
    const label = labels.get(ownedKey(version));
    if (label === undefined) return null;
    return { label, source: owners.length > 1 ? nameOf(version.subscriptionId) : null };
  };
}

/** The menu's value for Automatic. A version's is its `ownedKey`, which always holds a colon. */
const AUTOMATIC = "automatic";

/**
 * The arrow beside Play: Automatic, or one version, remembered for the title. Each version says
 * what it sounds like, and at the right whose it is when they come from several subscriptions.
 */
function VersionMenu({
  title,
  picked,
  automatic,
  trigger,
  children,
}: {
  title: Title;
  picked: OwnedId | null;
  /** The version Automatic plays, which its line names. */
  automatic: OwnedId;
  /** The button that opens it, when not the arrow joined to Play. */
  trigger?: ReactElement<Record<string, unknown>>;
  children: ReactNode;
}) {
  const pick = usePickVersion();
  const named = useVersionNames(title);
  const plays = named(automatic);
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          trigger ?? (
            <Button
              variant="primary"
              size="lg"
              aria-label="Versions"
              className="rounded-l-none border-l border-black/20 px-3"
            />
          )
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
                {plays && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {[plays.label, plays.source].filter(Boolean).join(", ")}
                  </span>
                )}
              </VersionItem>
              {title.versions.map((version) => {
                const said = named(version);
                return (
                  <VersionItem key={ownedKey(version)} value={ownedKey(version)}>
                    <span className="flex items-baseline gap-4">
                      <span className="min-w-0 flex-1">{said?.label}</span>
                      {said?.source && (
                        <span className="flex-none text-[0.8125rem] text-muted-foreground">
                          {said.source}
                        </span>
                      )}
                    </span>
                  </VersionItem>
                );
              })}
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
      <span className="min-w-0 flex-1">{children}</span>
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
  // How far the episodes got in this version's own subscription, and the ones marked there:
  // another subscription's are other files. While that can't be read, a row says nothing of how
  // its episode stands and offers no mark.
  const { standing } = useStanding(details);
  const stateOf = standing && episodeStates(standing.progress, standing.marks);
  const target = standing ? continuation(details, standing.progress, standing.marks) : null;
  const marking = useEpisodeMarks(ownedId(details.title), standing);
  // Whose record a mark goes to, said once the title's versions are of several subscriptions.
  const source = useVersionNames(details.title)(details.title)?.source ?? null;
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
  // A mark can move the series on to another season. The season in view stays, so the row just
  // marked keeps its place, with its dots and the keyboard's focus on them.
  const marks = {
    ...marking,
    mark: (episode: Episode, watched: boolean) => {
      setSeason(shown.number);
      marking.mark(episode, watched);
    },
  };
  return (
    <section className="mt-10">
      {details.seasons.length > 1 && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border">
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
          {source && <span className="ml-auto pb-2 text-xs text-muted-foreground">{source}</span>}
        </div>
      )}
      <MarkNotice marks={marks} source={source} />
      <div>
        {episodes.map((episode) => {
          const state = stateOf?.(episode);
          const current =
            target?.episode &&
            sameOwned(target.episode, episodeFileVersion(episode, target.episode.id));
          const partly = state?.kind === "partial" ? state.progress : undefined;
          const saving = marks.busy && marks.change?.episode.id === episode.id;
          const facts = [
            episode.airDate ? airDate(episode.airDate) : null,
            timeLeftOf(partly) ?? (episode.duration ? runtime(episode.duration) : null),
            saving ? "Saving…" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const credits = creditsOf(episode);
          return (
            // The row plays, and the dots beside it mark: two buttons side by side, neither
            // inside the other. Rows hold their top as they grow, so what is in view stays put.
            <div
              key={episode.id}
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 rounded-xl px-2 py-3 hover:bg-white/5",
                current && "bg-white/[0.04]",
              )}
            >
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  playTitle(
                    episodeNow(details, episodeFileVersion(episode, partly?.title.id)),
                    resumePoint(partly),
                  )
                }
                className="grid w-full min-w-0 grid-cols-[2.5rem_12.5rem_minmax(0,1fr)] items-start gap-4 text-left"
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
              </button>
              <span className="flex flex-col items-center gap-1.5 text-muted-foreground">
                {episode.versions && episode.versions.length > 1 && (
                  <EpisodeVersionMenu
                    episode={episode}
                    details={details}
                    progress={standing?.progress ?? []}
                  />
                )}
                {/* While a mark is stored the row claims neither state. */}
                {saving ? (
                  <CircleDashed className="size-4 opacity-50" aria-hidden />
                ) : (
                  state?.kind === "watched" && <Check className="size-4" aria-label="Watched" />
                )}
                {state && (
                  <EpisodeMenu episode={episode} state={state.kind} source={source} marks={marks} />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Every imported episode file remains selectable, with progress owned by that exact id. */
function EpisodeVersionMenu({
  episode,
  details,
  progress,
}: {
  episode: Episode;
  details: SeriesDetails;
  progress: readonly TitleProgress[];
}) {
  const versions = episode.versions ?? [];
  const labels = versionLabels(versions, details.title.originalLanguage);
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Versions for ${episodeLabel(episode.season, episode.number)}`}
          />
        }
      >
        {versions.length} versions
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Menu.Popup className="max-h-[60vh] min-w-60 overflow-y-auto bg-black p-2 text-white ring-1 ring-white/15">
            {versions.map((version, index) => (
              <Menu.Item
                key={version.id}
                title={version.name}
                className="block w-full px-2 py-2 text-left text-sm outline-none data-highlighted:bg-white/10"
                onClick={() => {
                  const own = progress.find(
                    (entry) =>
                      entry.title.id === version.id &&
                      entry.title.subscriptionId === episode.subscriptionId,
                  );
                  playTitle(
                    episodeNow(details, episodeFileVersion(episode, version.id)),
                    resumePoint(own),
                  );
                }}
              >
                Play {labels[index]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
