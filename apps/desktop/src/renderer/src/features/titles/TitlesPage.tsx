// Movies or Series: tabs under the title bar, like Hulu and Apple TV. For you leads with a
// featured title, what's being watched, titles like the last one and the collections that suit
// the viewer's language; New gathers what was added; Genres and Services are pages of tiles; 4K
// and All are grids. A row's All, a genre or a service opens its collection, with Back to the tab.
// Genres and services come from TMDB, so they fill in as its metadata arrives.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Play } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import type {
  CollectionId,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { isTyping } from "../../app/platform.ts";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { Artwork, PosterTile, StillTile } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";
import { movieNow, playTitle, removeFromContinue, useContinueWatching } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { CollectionGrid, useCollection } from "./CollectionGrid.tsx";

type Tab = "for-you" | "new" | "genres" | "services" | "4k" | "all";

/** Where each kind was, kept while the viewer goes elsewhere and comes back. */
const usePlace = create<
  Record<TitleKind, { tab: Tab; collection: CollectionId | null; sort: CollectionSort }>
>(() => ({
  movie: { tab: "for-you", collection: null, sort: "added" },
  series: { tab: "for-you", collection: null, sort: "added" },
}));

const POSTER_REM = 8.5;
const STILL_REM = 13;

export function TitlesPage({ kind, active }: { kind: TitleKind; active: boolean }) {
  const place = usePlace((state) => state[kind]);
  const go = (next: Partial<typeof place>) =>
    usePlace.setState((state) => ({ [kind]: { ...state[kind], ...next } }));
  const status = useQuery(queries.onDemandStatus());
  const fourK = useQuery(queries.collection(kind, "4k", undefined, 0, 1));
  const label = kind === "movie" ? "Movies" : "Series";
  const tabs: readonly { value: Tab; label: string }[] = [
    { value: "for-you", label: "For you" },
    { value: "new", label: "New" },
    { value: "genres", label: "Genres" },
    { value: "services", label: "Services" },
    ...(fourK.data?.total ? [{ value: "4k" as const, label: "4K" }] : []),
    { value: "all", label: kind === "movie" ? "All movies" : "All series" },
  ];

  // Escape leaves an open collection for its tab, one layer at a time.
  useEffect(() => {
    if (!active || !place.collection) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || isTyping(event)) return;
      const ui = useUi.getState();
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.details || ui.playingTitle) return;
      usePlace.setState((state) => ({ [kind]: { ...state[kind], collection: null } }));
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, place.collection, kind]);

  const open = (collection: CollectionId) => go({ collection, sort: "added" });
  const loading = status.data && status.data.fetchedAt === null;
  return (
    <div className="flex h-full flex-col">
      <WindowBar
        className="bg-black"
        {...(place.collection ? { back: { label, onBack: () => go({ collection: null }) } } : {})}
      />
      {place.collection ? (
        <Collection
          kind={kind}
          id={place.collection}
          sort={place.sort}
          onSort={(sort) => go({ sort })}
          active={active}
        />
      ) : (
        <>
          <nav className="flex flex-none gap-6 px-10 pt-2 pb-4 text-[0.9375rem]">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                aria-pressed={tab.value === place.tab}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => go({ tab: tab.value })}
                className={cn(
                  "border-b-2 pb-1",
                  tab.value === place.tab
                    ? "border-white font-semibold text-white"
                    : "border-transparent text-muted-foreground hover:text-white",
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          {loading ? (
            <p className="px-10 text-[0.9375rem] text-muted-foreground">
              Loading {kind === "movie" ? "movies" : "series"}…
            </p>
          ) : place.tab === "for-you" || place.tab === "new" ? (
            <Rows kind={kind} tab={place.tab} onOpen={open} />
          ) : place.tab === "genres" || place.tab === "services" ? (
            <Tiles kind={kind} of={place.tab} onOpen={open} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col pl-10">
              {place.tab === "all" && (
                <Sorts value={place.sort} onChange={(sort) => go({ sort })} />
              )}
              <CollectionGrid
                kind={kind}
                id={place.tab}
                {...(place.tab === "all" ? { sort: place.sort } : {})}
                active={active}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SORTS: readonly { value: CollectionSort; label: string }[] = [
  { value: "added", label: "Newest" },
  { value: "popular", label: "Popular" },
  { value: "rating", label: "Top rated" },
  { value: "title", label: "A–Z" },
];

function Sorts({
  value,
  onChange,
}: {
  value: CollectionSort;
  onChange: (sort: CollectionSort) => void;
}) {
  return (
    <div className="mb-4 flex gap-5 text-[0.8125rem]">
      {SORTS.map((entry) => (
        <button
          key={entry.value}
          aria-pressed={entry.value === value}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange(entry.value)}
          className={
            entry.value === value
              ? "font-semibold text-white"
              : "text-muted-foreground hover:text-white"
          }
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** A collection opened from a row, a genre or a service: its name, its order, its grid. */
function Collection({
  kind,
  id,
  sort,
  onSort,
  active,
}: {
  kind: TitleKind;
  id: CollectionId;
  sort: CollectionSort;
  onSort: (sort: CollectionSort) => void;
  active: boolean;
}) {
  const listed = useCollection(kind, id, sort);
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-2 pl-10">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{listed.name}</h1>
        <span className="text-sm text-muted-foreground tabular-nums">
          {listed.total?.toLocaleString()}
        </span>
      </div>
      <Sorts value={sort} onChange={onSort} />
      <CollectionGrid kind={kind} id={id} sort={sort} active={active} />
    </div>
  );
}

/** For you, or New: rows of collections; For you leads with a featured title. */
function Rows({
  kind,
  tab,
  onOpen,
}: {
  kind: TitleKind;
  tab: "for-you" | "new";
  onOpen: (id: CollectionId) => void;
}) {
  const continuing = useContinueWatching();
  const mine = continuing.entries.filter((entry) => entry.title.kind === kind);
  // Titles like the one watched last, by the version that was watched.
  const last = mine[0]?.progress.title;
  const like = !last ? null : last.kind === "movie" ? last.id : last.seriesId;
  const rows = useQuery(queries.rows(kind, tab, tab === "for-you" ? like : null));
  if (rows.error) {
    return <p className="px-10 text-sm text-destructive">{describeError(appError(rows.error))}</p>;
  }
  const featured = tab === "for-you" ? featuredOf(rows.data ?? []) : null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pb-16">
      {featured && <Featured title={featured} />}
      <div className="space-y-9">
        {tab === "for-you" && mine.length > 0 && (
          <Section title="Continue watching" tileRem={STILL_REM}>
            {mine.map((entry) => (
              <StillTile
                key={entry.key}
                artworkUrl={entry.artworkUrl}
                name={entry.now.name}
                line={entry.line}
                done={entry.done}
                onPlay={() => playTitle(entry.now, entry.from)}
                onRemove={() => removeFromContinue(entry.progress.title)}
              />
            ))}
          </Section>
        )}
        {(rows.data ?? []).map((row) => (
          <Section
            key={row.id}
            title={row.name}
            count={row.total}
            onAll={() => onOpen(row.id)}
            tileRem={POSTER_REM}
          >
            {row.titles.map((title) => (
              <PosterTile
                key={title.id}
                title={title}
                onOpen={() => openDetails({ kind: title.kind, id: title.id })}
              />
            ))}
          </Section>
        ))}
      </div>
    </div>
  );
}

/**
 * The title For you leads with: one of the ten most popular with a picture, a different one each
 * day, so it changes without moving while the viewer looks.
 */
function featuredOf(rows: readonly CollectionRow[]): Title | null {
  const popular = rows.find((row) => row.id === "popular")?.titles ?? rows[0]?.titles ?? [];
  const pictured = popular.filter((title) => title.backdropUrl).slice(0, 10);
  const day = Math.floor(Date.now() / 86_400_000);
  return pictured[day % Math.max(pictured.length, 1)] ?? null;
}

function Featured({ title }: { title: Title }) {
  const facts = [
    title.year,
    ...title.genres.slice(0, 2),
    title.rating ? `★ ${title.rating.toFixed(1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="relative mb-9 aspect-[21/8] max-h-[26rem] w-full overflow-hidden rounded-2xl">
      <Artwork url={title.backdropUrl} name={title.title} size="full" plain />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/40 to-transparent" />
      <div className="absolute bottom-8 left-8 max-w-[40rem]">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">{title.title}</h1>
        <div className="mt-2 text-[0.9375rem] text-foreground/85">{facts}</div>
        <div className="mt-6 flex gap-3">
          {title.kind === "movie" && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => playTitle(movieNow(title, title.backdropUrl), 0)}
            >
              <Play className="fill-current" />
              Play
            </Button>
          )}
          <Button
            variant={title.kind === "movie" ? "secondary" : "primary"}
            size="lg"
            onClick={() => openDetails({ kind: title.kind, id: title.id })}
          >
            {title.kind === "movie" ? "Details" : "Episodes"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Genres or streaming services as a page of picture tiles. */
function Tiles({
  kind,
  of,
  onOpen,
}: {
  kind: TitleKind;
  of: "genres" | "services";
  onOpen: (id: CollectionId) => void;
}) {
  const tiles = useQuery(queries.tiles(kind, of));
  const status = useQuery(queries.onDemandStatus());
  const metadata = status.data?.metadata;
  if (tiles.error) {
    return <p className="px-10 text-sm text-destructive">{describeError(appError(tiles.error))}</p>;
  }
  const empty = tiles.data && tiles.data.length === 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pb-16">
      {empty ? (
        <p className="text-[0.9375rem] text-muted-foreground">
          {!metadata
            ? `${of === "genres" ? "Genres" : "Services"} need a TMDB key, in Settings.`
            : metadata.refused
              ? "TMDB refused the key. Check it in Settings."
              : `${of === "genres" ? "Genres" : "Services"} appear as details arrive from TMDB.`}
        </p>
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))" }}
        >
          {(tiles.data ?? []).map((tile) => (
            <CollectionTileButton key={tile.id} tile={tile} onOpen={() => onOpen(tile.id)} />
          ))}
        </div>
      )}
      {of === "services" && !empty && (
        <p className="mt-8 text-xs text-muted-foreground">Where titles stream, from JustWatch.</p>
      )}
    </div>
  );
}

function CollectionTileButton({ tile, onOpen }: { tile: CollectionTile; onOpen: () => void }) {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="group relative block aspect-video overflow-hidden rounded-xl text-left ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 hover:ring-2 hover:ring-white/40 active:scale-[0.98]"
    >
      <Artwork url={tile.artworkUrl} name={tile.name} size="wide" plain />
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      <span className="absolute bottom-3 left-4">
        <span className="block text-lg font-semibold">{tile.name}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {tile.count.toLocaleString()}
        </span>
      </span>
    </button>
  );
}

/** A row: a heading with All, and as many tiles as fit across, in one line. */
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
      {/* One line of tiles: the rest of the row is behind All. */}
      <div
        className="grid gap-x-4 overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${tileRem}rem, 1fr))`,
          gridTemplateRows: "auto",
          gridAutoRows: "0px",
        }}
      >
        {children}
      </div>
    </section>
  );
}
