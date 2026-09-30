// The start page: the channel you watched last, playing muted in the large backdrop with what's on,
// then favourites, recently watched and your category, a few rows of each. Everything scrolls one
// way, down; each section's All opens the full list in Live TV.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { Listing } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { openView, useUi, type ChannelList } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo, hueOf } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { categoryOf, channelLine, clockTime, progressOf, timeLeft } from "../../lib/format.ts";
import { queries, useCategoryMap, useLastChannel } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { watchChannel } from "../live/GuidePage.tsx";
import { showList } from "../live/lists.ts";

const NO_IDS: readonly string[] = [];
const NO_CHANNELS: readonly LiveChannel[] = [];
/** Sections show at most this many rows of tiles. */
const ROWS = 2;
const TILE_REM = 13;
const GAP_REM = 1;

/** Opens a list in Live TV. */
function browse(list: ChannelList): void {
  showList(list);
  openView("live");
}

export function HomeScreen({ active }: { active: boolean }) {
  const preferences = useQuery({ ...queries.preferences(), refetchOnMount: "always" });
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const list = useUi((state) => state.list);
  const favouriteIds = preferences.data?.favouriteChannelIds ?? NO_IDS;
  const recentIds = preferences.data?.recentChannelIds ?? NO_IDS;
  const favourites = useQuery(queries.channelsById(favouriteIds)).data ?? NO_CHANNELS;
  const recent = useQuery(queries.channelsById(recentIds)).data ?? NO_CHANNELS;
  const categoryId =
    list.kind === "category" ? list.id : (preferences.data?.lastCategoryId ?? null);
  const category = categoryId ? categoryMap.get(categoryId) : undefined;
  // Your category, or every channel before you have one.
  const categoryList: ChannelList = category
    ? { kind: "category", id: category.id }
    : { kind: "all" };
  const inCategory =
    useQuery({ ...queries.channels(category?.id ?? null), enabled: categories.isSuccess }).data ??
    NO_CHANNELS;
  const status = useQuery(queries.libraryStatus());

  const [grid, columns] = useColumns();
  const perSection = columns * ROWS;
  const shown = {
    favourites: favourites.slice(0, perSection),
    recent: recent.slice(0, perSection),
    category: inCategory.slice(0, perSection),
  };
  const playing = usePlayer((state) => state.channel);
  const streaming = usePlayer(
    (state) => state.phase.kind !== "idle" && state.phase.kind !== "failed",
  );
  const last = useLastChannel();
  const ids = useMemo(
    () => [
      ...new Set(
        [playing, last, ...shown.favourites, ...shown.recent, ...shown.category].flatMap(
          (channel) => (channel ? [channel.id] : []),
        ),
      ),
    ],
    [playing, last, shown.favourites, shown.recent, shown.category],
  );
  const listings = useQuery(queries.listings(ids)).data ?? {};
  // Without a last channel, a favourite on now, or the first in your category, stands still.
  const hero =
    playing ??
    last ??
    shown.favourites.find((channel) => listings[channel.id]?.now) ??
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
        key={channel.id}
        channel={channel}
        listing={listings[channel.id]}
        categories={categoryMap}
      />
    ));
  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <Hero
        channel={hero}
        live={active && hero !== null && hero.id === playing?.id}
        streaming={streaming}
        listing={hero ? listings[hero.id] : undefined}
        categories={categoryMap}
      />
      <div ref={grid} className="space-y-10 px-10 pt-2 pb-16">
        {shown.favourites.length > 0 && (
          <Section
            title="Favourites"
            count={favourites.length}
            onAll={() => browse({ kind: "favourites" })}
          >
            {tiles(shown.favourites)}
          </Section>
        )}
        {shown.recent.length > 0 && (
          <Section
            title="Recently watched"
            count={recent.length}
            onAll={() => browse({ kind: "recent" })}
          >
            {tiles(shown.recent)}
          </Section>
        )}
        {shown.category.length > 0 && (
          <Section
            title={category?.title ?? "All channels"}
            count={category?.channelCount ?? status.data?.channelCount ?? inCategory.length}
            onAll={() => browse(categoryList)}
          >
            {tiles(shown.category)}
          </Section>
        )}
      </div>
    </div>
  );
}

/** How many tiles fit across the sections, measured on the element the returned ref is given. */
function useColumns(): [ref: (element: HTMLDivElement | null) => void, columns: number] {
  const rem = useRem();
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    observer.current = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.current.observe(element);
  }, []);
  // The sections' side padding is 2.5rem each.
  const inner = width - 5 * rem;
  const gap = GAP_REM * rem;
  return [ref, Math.max(1, Math.floor((inner + gap) / (TILE_REM * rem + gap)))];
}

function Hero({
  channel,
  live,
  streaming,
  listing,
  categories,
}: {
  channel: LiveChannel | null;
  /** The backdrop shows this channel's stream. */
  live: boolean;
  /** The stream is up, so it has sound to turn on. */
  streaming: boolean;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
}) {
  const now = useNow();
  const audible = usePlayer((state) => state.audible && !state.muted);
  const hue = channel ? hueOf(channel.title) : 220;
  const current = listing?.now ?? null;
  return (
    <section
      className="relative flex h-[62vh] min-h-[24rem] items-end overflow-hidden px-10 pb-12"
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
        active={live}
        fit="cover"
        className="absolute inset-y-0 right-0 aspect-video h-full max-w-full"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
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
            {live && streaming && (
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
  children,
}: {
  title: string;
  count: number;
  onAll: () => void;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={onAll}
          className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-white"
        >
          All {count.toLocaleString()}
          <ChevronRight className="size-3.5" />
        </button>
      </div>
      <div
        className="grid gap-x-4 gap-y-6"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_REM}rem, 1fr))` }}
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
