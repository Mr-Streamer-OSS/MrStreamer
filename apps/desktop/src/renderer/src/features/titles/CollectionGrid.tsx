// A collection as a grid of posters, in rows that fit the width, fetched a page at a time and
// drawn only where in view; search results use the same grid. A poster opens its details over
// the grid, which stays where it was.
//   The arrow keys move the selection through the grid, Page Up and Down by a screen, Home and End
//   to the ends; Enter opens the title. The pointer only hovers.
import { useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CollectionId,
  CollectionSort,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { queries } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";

/** Titles asked for together as rows come into view. */
const PAGE = 120;
const FIRST_PAGE: ReadonlySet<number> = new Set([0]);
const POSTER_REM = 9;
const GAP_REM = 1.25;

/**
 * A collection's titles, fetched a page at a time as the grid asks. `titleAt` answers for loaded
 * positions; `load` asks for the pages around the positions in view.
 */
export function useCollection(kind: TitleKind, id: CollectionId, sort?: CollectionSort) {
  const listKey = `${kind}:${id}:${sort ?? ""}`;
  // The pages asked for, of this list only: another list starts again from the first.
  const [asked, setAsked] = useState<{ key: string; pages: ReadonlySet<number> }>(() => ({
    key: listKey,
    pages: FIRST_PAGE,
  }));
  const pages = asked.key === listKey ? asked.pages : FIRST_PAGE;
  const loaded = useQueries({
    queries: [...pages].map((page) => queries.collection(kind, id, sort, page * PAGE, PAGE)),
  });
  const load = useCallback(
    (first: number, last: number) => {
      // Nothing in view yet, before the grid has measured its rows.
      if (last < first || last < 0) return;
      const from = Math.floor(Math.max(0, first) / PAGE);
      const wanted = Array.from({ length: Math.floor(last / PAGE) - from + 1 }, (_, i) => from + i);
      setAsked((current) => {
        const had = current.key === listKey ? current.pages : FIRST_PAGE;
        return wanted.every((page) => had.has(page)) && current.key === listKey
          ? current
          : { key: listKey, pages: new Set([...had, ...wanted]) };
      });
    },
    [listKey],
  );
  const byPage = new Map([...pages].map((page, index) => [page, loaded[index]?.data]));
  const first = byPage.get(0);
  return {
    name: first?.name ?? null,
    total: first ? first.total : null,
    titleAt: (index: number) => byPage.get(Math.floor(index / PAGE))?.titles[index % PAGE],
    load,
    error: loaded.find((each) => each.error)?.error ?? null,
  };
}

/** The grid for a collection, or why there is none. */
export function CollectionGrid({
  kind,
  id,
  sort,
  active,
}: {
  kind: TitleKind;
  id: CollectionId;
  sort?: CollectionSort;
  active: boolean;
}) {
  const listed = useCollection(kind, id, sort);
  if (listed.error) {
    return <p className="text-sm text-destructive">{describeError(appError(listed.error))}</p>;
  }
  if (listed.total === 0) {
    return <p className="text-[0.9375rem] text-muted-foreground">Nothing here yet.</p>;
  }
  return (
    <Grid
      key={`${kind}:${id}:${sort ?? ""}`}
      total={listed.total ?? 0}
      titleAt={listed.titleAt}
      onVisible={listed.load}
      active={active}
      asked={id === "4k"}
    />
  );
}

/** What a poster says under its name: the year, the first genre and the rating. */
function describe(title: Title): string {
  return [title.year, title.genres[0], title.rating ? `★ ${title.rating.toFixed(1)}` : null]
    .filter(Boolean)
    .join(" · ");
}

const nothing = () => {};

/** Titles already at hand, such as search results, as the same grid. */
export function TitleGrid({
  titles,
  active,
  caption,
}: {
  titles: readonly Title[];
  active: boolean;
  caption?: (title: Title) => string;
}) {
  return (
    <Grid
      total={titles.length}
      titleAt={(index) => titles[index]}
      onVisible={nothing}
      active={active}
      {...(caption ? { caption } : {})}
    />
  );
}

/** The posters in rows that fit the width, drawing only the rows in view. */
function Grid({
  total,
  titleAt,
  onVisible,
  active,
  caption = describe,
  asked = false,
}: {
  total: number;
  titleAt: (index: number) => Title | undefined;
  onVisible: (first: number, last: number) => void;
  active: boolean;
  caption?: (title: Title) => string;
  /** Each poster is the version the grid asks for, as the 4K tab's are their 4K versions. */
  asked?: boolean;
}) {
  const open = (title: Title) => openDetails({ kind: title.kind, ...ownedId(title), asked });
  const box = useRef<HTMLDivElement>(null);
  const rem = useRem();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gap = GAP_REM * rem;
  const inner = Math.max(0, width - 2 * rem);
  const columns = Math.max(1, Math.floor((inner + gap) / (POSTER_REM * rem + gap)));
  const tileWidth = (inner - gap * (columns - 1)) / columns;
  // A poster, its name and one line, then the gap before the next row.
  const rowHeight = tileWidth * 1.5 + 2.75 * rem + gap;
  const rows = Math.ceil(total / columns);
  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => box.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });
  useEffect(() => virtual.measure(), [rowHeight, virtual]);
  const items = virtual.getVirtualItems();
  const firstRow = items[0]?.index ?? 0;
  const lastRow = items.at(-1)?.index ?? 0;
  useEffect(() => {
    // The next rows' posters load before they scroll into view.
    onVisible(firstRow * columns, Math.min(total - 1, (lastRow + 3) * columns - 1));
  }, [firstRow, lastRow, columns, total, onVisible]);

  const keyboard = useKeyboardMode();
  const [chosen, setSelected] = useState(0);
  // Within the list, when it shrank since.
  const selected = Math.min(chosen, Math.max(total - 1, 0));
  const state = useRef({ selected, columns, total, titleAt, rowsInView: items.length });
  state.current = { selected, columns, total, titleAt, rowsInView: items.length };
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.details || ui.playingTitle) return;
      // Enter on a focused button, such as a tab, is the button's.
      if (event.key === "Enter" && event.target instanceof HTMLButtonElement) return;
      const now = state.current;
      const move = (delta: number) => {
        const next = Math.min(Math.max(now.selected + delta, 0), Math.max(now.total - 1, 0));
        setSelected(next);
        virtual.scrollToIndex(Math.floor(next / now.columns), { align: "auto" });
      };
      switch (event.key) {
        case "ArrowRight":
          move(1);
          break;
        case "ArrowLeft":
          move(-1);
          break;
        case "ArrowDown":
          move(now.columns);
          break;
        case "ArrowUp":
          move(-now.columns);
          break;
        case "PageDown":
          move(now.columns * Math.max(1, now.rowsInView - 2));
          break;
        case "PageUp":
          move(-now.columns * Math.max(1, now.rowsInView - 2));
          break;
        case "Home":
          move(-now.selected);
          break;
        case "End":
          move(now.total);
          break;
        case "Enter": {
          const title = now.titleAt(now.selected);
          if (title) open(title);
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, virtual]);

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-8 pb-10">
      <div className="relative" style={{ height: virtual.getTotalSize() }}>
        {items.map((row) => (
          <div
            key={row.key}
            className="absolute inset-x-0 grid"
            style={{
              top: row.start,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              columnGap: gap,
            }}
          >
            {Array.from({ length: columns }, (_, column) => {
              const index = row.index * columns + column;
              if (index >= total) return null;
              const title = titleAt(index);
              return title ? (
                <GridPoster
                  key={index}
                  title={title}
                  caption={caption(title)}
                  selected={keyboard && active && index === selected}
                  onOpen={() => open(title)}
                />
              ) : (
                <div key={index}>
                  <div className="aspect-[2/3] rounded-xl bg-white/4" />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function GridPoster({
  title,
  caption,
  selected,
  onOpen,
}: {
  title: Title;
  caption: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="group min-w-0 text-left"
      title={title.name}
    >
      <span
        className={cn(
          "block aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]",
          selected && "ring-2 ring-white",
        )}
      >
        <Artwork url={title.posterUrl} name={title.title} size="card" />
      </span>
      <span className="mt-2 block truncate text-[0.875rem] font-medium">{title.title}</span>
      <span className="block truncate text-xs text-muted-foreground">{caption}</span>
    </button>
  );
}
