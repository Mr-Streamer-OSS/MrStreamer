// The start page: the channel you watched last, playing muted in the backdrop with what's on, then
// one row each of what you were watching, favourite and recent channels, new movies, new series
// and your category. Rows show only what exists. Everything scrolls one way, down; each row's All
// opens the whole list in Live TV, Movies or Series.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Play, Volume2, VolumeX } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Listing } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { openDetails, openView, useUi, type ChannelList } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo, hueOf } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { PosterTile, StillTile } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { categoryOf, channelLine, clockTime, progressOf, timeLeft } from "../../lib/format.ts";
import {
  queries,
  useCategoryMap,
  useLastChannel,
  useSubscriptionPreferences,
} from "../../lib/queries.ts";
import { useContinueWatching, useRemoveFromContinue, useResume } from "../../lib/titles.ts";
import { useFit } from "../../lib/use-fit.ts";
import { usePreviewWaits } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { watchChannel } from "../live/GuidePage.tsx";
import { useShowList } from "../live/lists.ts";
import { openCollection } from "../titles/TitlesPage.tsx";

const NO_IDS: readonly OwnedId[] = [];
const NO_CHANNELS: readonly LiveChannel[] = [];
const NO_TITLES: readonly Title[] = [];
/** Tile widths: channels and stills at 16:9, posters at 2:3. */
const TILE_REM = 13;
const POSTER_REM = 8.5;

/** Channels without those for adults, which show only in Live TV. */
function ordinary(channels: readonly LiveChannel[] | undefined): readonly LiveChannel[] {
  return channels?.filter((channel) => !channel.adult) ?? NO_CHANNELS;
}

function notForAdults(channel: LiveChannel | null): LiveChannel | null {
  return channel?.adult ? null : channel;
}

/** Opens a list in Live TV. */
function useBrowse(): (list: ChannelList) => void {
  const showList = useShowList();
  return (list) => {
    showList(list);
    openView("live");
  };
}

export function HomeScreen({ active }: { active: boolean }) {
  const browse = useBrowse();
  // Read afresh each time Home opens: watching a channel changes the last one.
  const left = useSubscriptionPreferences("always");
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const list = useUi((state) => state.list);
  const viewing = useQuery(queries.viewing());
  const favouriteIds = viewing.data?.favourites ?? NO_IDS;
  const recentIds = viewing.data?.recent ?? NO_IDS;
  const favourites = ordinary(useQuery(queries.channelsOf(favouriteIds)).data);
  const recent = ordinary(useQuery(queries.channelsOf(recentIds)).data);
  // The category Live TV shows, or the one the viewer left the subscription at.
  const lastCategory: OwnedId | null =
    list.kind === "category"
      ? list.category
      : left && left.lastCategoryId !== null
        ? { subscriptionId: left.subscriptionId, id: left.lastCategoryId }
        : null;
  const category = lastCategory ? categoryMap.get(ownedKey(lastCategory)) : undefined;
  // Your category, or every channel before you have one.
  const categoryList: ChannelList = category
    ? { kind: "category", category: ownedId(category) }
    : { kind: "all" };
  const inCategory = ordinary(
    useQuery({ ...queries.channels(category ?? null), enabled: categories.isSuccess }).data,
  );
  const status = useQuery(queries.libraryStatus());

  const [grid, fit] = useFit();
  const columns = fit(TILE_REM);
  const posters = fit(POSTER_REM);
  const shown = {
    favourites: favourites.slice(0, columns),
    recent: recent.slice(0, columns),
    category: inCategory.slice(0, columns),
  };
  const newMovies = useNewest("movie", posters);
  const newSeries = useNewest("series", posters);
  const continuing = useContinueWatching();
  const resume = useResume();
  const removal = useRemoveFromContinue();
  const playing = notForAdults(usePlayer((state) => state.channel));
  const streaming = usePlayer(
    (state) => state.phase.kind !== "idle" && state.phase.kind !== "failed",
  );
  const last = notForAdults(useLastChannel());
  // Each channel shown, once.
  const listed = useMemo(
    () => [
      ...new Map(
        [playing, last, ...shown.favourites, ...shown.recent, ...shown.category].flatMap(
          (channel) => (channel ? [[ownedKey(channel), channel] as const] : []),
        ),
      ).values(),
    ],
    [playing, last, shown.favourites, shown.recent, shown.category],
  );
  const listings = useQuery(queries.listings(listed)).data ?? {};
  // Without a last channel, a favourite on now, or the first in your category, stands still.
  const hero =
    playing ??
    last ??
    shown.favourites.find((channel) => listings[ownedKey(channel)]?.now) ??
    shown.favourites[0] ??
    shown.category[0] ??
    null;

  const notice = catalogueState(categories);
  if (notice) {
    return (
      <div className="flex h-full flex-col">
        <WindowBar className="bg-black" />
        <div className="flex flex-1 items-center justify-center pb-14">
          <CatalogueNotice state={notice} />
        </div>
      </div>
    );
  }
  const tiles = (channels: readonly LiveChannel[]) =>
    channels.map((channel) => (
      <Tile
        key={ownedKey(channel)}
        channel={channel}
        listing={listings[ownedKey(channel)]}
        categories={categoryMap}
      />
    ));
  const titles = (list: readonly Title[]) =>
    list.map((title) => (
      <PosterTile
        key={ownedKey(title)}
        title={title}
        onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
      />
    ));
  const entries = continuing.entries.slice(0, columns);
  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <Hero
        channel={hero}
        live={active && sameOwned(hero, playing)}
        streaming={streaming}
        listing={hero ? listings[ownedKey(hero)] : undefined}
        categories={categoryMap}
        onBrowse={browse}
      />
      <div ref={grid} className="space-y-9 px-10 pt-2 pb-16">
        {entries.length > 0 && (
          <div>
            <Section title="Continue watching" tileRem={TILE_REM}>
              {entries.map((entry) => (
                <StillTile
                  key={entry.key}
                  artworkUrl={entry.artworkUrl}
                  name={entry.title.title}
                  line={entry.line}
                  done={entry.done}
                  onPlay={() => resume(entry)}
                  onRemove={() => removal.mutate(entry.title)}
                />
              ))}
            </Section>
            {removal.error && (
              <p className="mt-3 text-sm text-destructive">
                {describeError(appError(removal.error))}
              </p>
            )}
          </div>
        )}
        {shown.favourites.length > 0 && (
          <Section
            title="Favourites"
            count={favourites.length}
            onAll={() => browse({ kind: "favourites" })}
            tileRem={TILE_REM}
          >
            {tiles(shown.favourites)}
          </Section>
        )}
        {shown.recent.length > 0 && (
          <Section
            title="Recently watched"
            count={recent.length}
            onAll={() => browse({ kind: "recent" })}
            tileRem={TILE_REM}
          >
            {tiles(shown.recent)}
          </Section>
        )}
        {newMovies.length > 0 && (
          <Section
            title="New movies"
            onAll={() => openCollection("movie", "new-month")}
            tileRem={POSTER_REM}
          >
            {titles(newMovies)}
          </Section>
        )}
        {newSeries.length > 0 && (
          <Section
            title="New series"
            onAll={() => openCollection("series", "new-month")}
            tileRem={POSTER_REM}
          >
            {titles(newSeries)}
          </Section>
        )}
        {shown.category.length > 0 && (
          <Section
            title={category?.title ?? "All channels"}
            count={category?.channelCount ?? status.data?.channelCount ?? inCategory.length}
            onAll={() => browse(categoryList)}
            tileRem={TILE_REM}
          >
            {tiles(shown.category)}
          </Section>
        )}
      </div>
    </div>
  );
}

/** The newest titles of a kind in the viewer's language, without those for adults. */
function useNewest(kind: TitleKind, count: number): readonly Title[] {
  const page = useQuery(queries.collection(kind, "new-month", undefined, 0, Math.max(count, 1)));
  return page.data?.titles.slice(0, count) ?? NO_TITLES;
}

function Hero({
  channel,
  live,
  streaming,
  listing,
  categories,
  onBrowse: browse,
}: {
  channel: LiveChannel | null;
  /** The backdrop shows this channel's stream. */
  live: boolean;
  /** The stream is up, so it has sound to turn on. */
  streaming: boolean;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
  /** Opens a list in Live TV. */
  onBrowse: (list: ChannelList) => void;
}) {
  const now = useNow();
  const audible = usePlayer((state) => state.audible && !state.muted);
  // A receiver on the network is connected, so the backdrop stands still and says why.
  const waits = usePreviewWaits();
  const hue = channel ? hueOf(channel.title) : 220;
  const current = listing?.now ?? null;
  return (
    <section
      className="relative flex h-[54vh] min-h-[22rem] items-end overflow-hidden px-10 pb-10"
      style={{
        // The backdrop runs under the window bar.
        marginTop: -WINDOW_BAR.height,
        background: `radial-gradient(ellipse 70% 90% at 78% 35%, hsl(${hue} 45% 20%), transparent 70%), #000`,
      }}
    >
      {channel && (
        <ChannelLogo
          channel={channel}
          plain
          className="pointer-events-none absolute top-[24%] right-[12%] h-[28%] w-[22%] text-8xl opacity-90"
        />
      )}
      <Picture
        active={live && !waits}
        fit="cover"
        className="absolute inset-y-0 right-0 aspect-video h-full max-w-full"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
      {channel && waits && (
        <p className="absolute top-[56%] right-[12%] w-[22%] text-center text-sm text-muted-foreground">
          {waits}
        </p>
      )}
      {channel && (
        <div className="relative max-w-[46rem]">
          <h1 className="text-6xl font-semibold tracking-tight text-balance">
            {current?.title ?? channel.title}
          </h1>
          <div className="mt-3 flex items-center gap-2 text-[0.9375rem] text-foreground/85">
            <ChannelLogo channel={channel} className="h-6 w-9" />
            {current
              ? `${channel.title} · Until ${clockTime(current.stop, now)} · ${timeLeft(current, now)}`
              : [channelLine(channel, categories), ...channel.tags].filter(Boolean).join(" · ")}
          </div>
          {current && <Progress value={progressOf(current, now)} className="mt-3 w-72" />}
          <div className="mt-8 flex items-center gap-3">
            <Button variant="primary" size="lg" onClick={() => watchChannel(channel)}>
              <Play className="fill-current" />
              Watch
            </Button>
            <Button variant="secondary" size="lg" onClick={() => browse({ kind: "all" })}>
              All channels
            </Button>
            {live && streaming && !waits && (
              <Button
                variant="secondary"
                size="icon-lg"
                aria-label={audible ? "Mute" : "Unmute"}
                onClick={() => player.toggleMute()}
              >
                {audible ? <Volume2 /> : <VolumeX />}
              </Button>
            )}
          </div>
        </div>
      )}
      {!channel && (
        <div className="relative">
          <Button variant="primary" size="lg" onClick={() => browse({ kind: "all" })}>
            All channels
          </Button>
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  count,
  onAll,
  tileRem,
  children,
}: {
  title: string;
  count?: number;
  onAll?: () => void;
  /** The narrowest a tile gets; as many fit across as the window allows, in one row. */
  tileRem: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3.5 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {onAll && (
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAll}
            className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-white"
          >
            All{count === undefined ? "" : ` ${count.toLocaleString()}`}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
      <div
        className="grid gap-x-4"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileRem}rem, 1fr))` }}
      >
        {children}
      </div>
    </section>
  );
}

/** A channel, programme first: what's on with its progress, or the channel and its category. */
function Tile({
  channel,
  listing,
  categories,
}: {
  channel: LiveChannel;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
}) {
  const now = useNow();
  const hue = hueOf(channel.title);
  const current = listing?.now ?? null;
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => watchChannel(channel)}
      className="group min-w-0 text-left"
    >
      <div
        className="relative grid aspect-video place-items-center rounded-2xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 30% 16%), hsl(${hue} 25% 8%))` }}
      >
        <ChannelLogo channel={channel} plain className="h-[42%] w-[62%] text-2xl" />
        {current && (
          <Progress value={progressOf(current, now)} className="absolute inset-x-3 bottom-2.5" />
        )}
      </div>
      <div className="mt-2.5 truncate text-[0.9375rem] font-medium">
        {current?.title ?? channel.title}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {current
          ? `${channel.title} · ${timeLeft(current, now)}`
          : categoryOf(channel, categories) || channel.tags.join(" · ")}
      </div>
    </button>
  );
}
