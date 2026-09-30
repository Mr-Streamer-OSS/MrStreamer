// Movies or Series: lists on the left (continue watching, recently added, then categories under
// their country, like Live TV), and the chosen list as a grid of posters on the right, sorted as
// the viewer likes. A poster opens its details over the grid, which stays where it was.
//   The arrow keys move the selection through the grid, Page Up and Down by a screen, Home and End
//   to the ends; Enter opens the title. The pointer only hovers.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type { Title, TitleCategory, TitleKind, TitleSort } from "@mrstreamer/contracts/ondemand";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { queries } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";

/** Titles asked for together as rows come into view. */
const PAGE = 120;
const POSTER_REM = 9;
const GAP_REM = 1.25;

/** What the grid shows: titles in progress, the newest, or a category. */
type TitleList =
  | { readonly kind: "continue" }
  | { readonly kind: "recent" }
  | { readonly kind: "category"; readonly id: string };

/** The list and order each kind shows, kept while the viewer goes elsewhere and comes back. */
const useBrowse = create<Record<TitleKind, { list: TitleList; sort: TitleSort }>>(() => ({
  movie: { list: { kind: "recent" }, sort: "added" },
  series: { list: { kind: "recent" }, sort: "added" },
}));

const SORTS: readonly { value: TitleSort; label: string }[] = [
  { value: "added", label: "Added" },
  { value: "title", label: "A–Z" },
  { value: "rating", label: "Rating" },
];

export function BrowsePage({ kind, active }: { kind: TitleKind; active: boolean }) {
  const { list, sort } = useBrowse((state) => state[kind]);
  const choose = (next: Partial<{ list: TitleList; sort: TitleSort }>) =>
    useBrowse.setState((state) => ({ [kind]: { ...state[kind], ...next } }));
  const categories = useQuery(queries.titleCategories(kind));
  const status = useQuery(queries.onDemandStatus());
  const listed = useTitles(kind, list, sort);
  const title =
    list.kind === "continue"
      ? "Continue watching"
      : list.kind === "recent"
        ? kind === "movie"
          ? "Recently added"
          : "Recently updated"
        : (categories.data?.find((category) => category.id === list.id)?.title ?? "");

  // A category can disappear after a refresh or a new login.
  useEffect(() => {
    if (
      list.kind === "category" &&
      categories.data &&
      !categories.data.some((each) => each.id === list.id)
    ) {
      useBrowse.setState((state) => ({ [kind]: { ...state[kind], list: { kind: "recent" } } }));
    }
  }, [list, categories.data, kind]);

  const failure = categories.error ?? listed.error;
  return (
    <div className="flex h-full flex-col">
      <WindowBar className="bg-black" />
      <div className="flex min-h-0 flex-1">
        <Lists
          kind={kind}
          categories={categories.data ?? []}
          selected={list}
          onPick={(next) => choose({ list: next })}
        />
        <main className="flex min-w-0 flex-1 flex-col pt-4 pl-8">
          <div className="mb-4 flex items-baseline gap-3 pr-8">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <span className="text-sm text-muted-foreground tabular-nums">
              {listed.total === null ? "" : listed.total.toLocaleString()}
            </span>
            {list.kind !== "continue" && (
              <div className="ml-auto flex rounded-full bg-white/8 p-0.5">
                {SORTS.map((entry) => (
                  <button
                    key={entry.value}
                    aria-pressed={entry.value === sort}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose({ sort: entry.value })}
                    className={cn(
                      "rounded-full px-3 py-1 text-[0.8125rem]",
                      entry.value === sort
                        ? "bg-white font-semibold text-black"
                        : "text-muted-foreground hover:text-white",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {failure ? (
            <p className="text-sm text-destructive">{describeError(appError(failure))}</p>
          ) : status.data && status.data.fetchedAt === null && listed.total === null ? (
            <p className="text-[0.9375rem] text-muted-foreground">
              Loading {kind === "movie" ? "movies" : "series"}…
            </p>
          ) : listed.total === 0 ? (
            <p className="text-[0.9375rem] text-muted-foreground">
              {list.kind === "continue" ? "Nothing in progress." : "Nothing here."}
            </p>
          ) : (
            <Grid
              key={`${kind}:${list.kind === "category" ? list.id : list.kind}:${sort}`}
              total={listed.total ?? 0}
              titleAt={listed.titleAt}
              onVisible={listed.load}
              active={active}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * A list's titles, fetched a page at a time as the grid asks. `titleAt` answers for loaded
 * positions; `load` asks for the pages around the positions in view.
 */
function useTitles(kind: TitleKind, list: TitleList, sort: TitleSort) {
  const [pages, setPages] = useState<ReadonlySet<number>>(() => new Set([0]));
  const listKey = `${kind}:${list.kind === "category" ? list.id : list.kind}:${sort}`;
  useEffect(() => setPages(new Set([0])), [listKey]);
  const viewing = useQuery({ ...queries.viewing(), enabled: list.kind === "continue" });
  const inProgress = useMemo(() => {
    const ids = (viewing.data?.continueWatching ?? []).flatMap((entry) => {
      if (kind === "movie") return entry.title.kind === "movie" ? [entry.title.id] : [];
      return entry.title.kind === "episode" ? [entry.title.seriesId] : [];
    });
    return [...new Set(ids)];
  }, [viewing.data, kind]);
  const continuing = useQuery({
    ...queries.titlesById(kind, inProgress),
    enabled: list.kind === "continue" && inProgress.length > 0,
  });
  const categoryId = list.kind === "category" ? list.id : null;
  const loaded = useQueries({
    queries: [...pages].map((page) => ({
      ...queries.titles(kind, categoryId, sort, page * PAGE, PAGE),
      enabled: list.kind !== "continue",
    })),
  });
  const load = useCallback((first: number, last: number) => {
    // Nothing in view yet, before the grid has measured its rows.
    if (last < first || last < 0) return;
    const wanted = [Math.floor(Math.max(0, first) / PAGE), Math.floor(last / PAGE)];
    setPages((current) =>
      wanted.every((page) => current.has(page)) ? current : new Set([...current, ...wanted]),
    );
  }, []);
  if (list.kind === "continue") {
    const titles = inProgress.length === 0 ? [] : continuing.data;
    return {
      total: titles ? titles.length : null,
      titleAt: (index: number) => titles?.[index],
      load,
      error: continuing.error ?? viewing.error,
    };
  }
  const byPage = new Map([...pages].map((page, index) => [page, loaded[index]?.data]));
  const first = byPage.get(0);
  return {
    total: first ? first.total : null,
    titleAt: (index: number) => byPage.get(Math.floor(index / PAGE))?.titles[index % PAGE],
    load,
    error: loaded.find((each) => each.error)?.error ?? null,
  };
}

/** Continue watching, recently added, then categories, grouped under their country. */
function Lists({
  kind,
  categories,
  selected,
  onPick,
}: {
  kind: TitleKind;
  categories: readonly TitleCategory[];
  selected: TitleList;
  onPick: (list: TitleList) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const current =
      selected.kind === "category" ? categories.find((each) => each.id === selected.id) : null;
    return new Set(current?.group ? [current.group] : []);
  });
  const toggle = (group: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const groups = useMemo(() => {
    const byGroup = new Map<string, TitleCategory[]>();
    const order: ({ group: string } | { category: TitleCategory })[] = [];
    for (const category of categories) {
      if (category.group === null) {
        order.push({ category });
        continue;
      }
      const members = byGroup.get(category.group);
      if (members) members.push(category);
      else {
        byGroup.set(category.group, [category]);
        order.push({ group: category.group });
      }
    }
    return { byGroup, order };
  }, [categories]);
  const row = (active: boolean, nested = false) =>
    cn(
      "flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-white/8",
      nested && "pl-6 text-foreground/75",
      active && "bg-white/10 text-white",
    );
  const category = (each: TitleCategory, nested: boolean) => (
    <button
      key={each.id}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick({ kind: "category", id: each.id })}
      className={row(selected.kind === "category" && selected.id === each.id, nested)}
    >
      <span className="min-w-0 flex-1 truncate">{each.title}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {each.count.toLocaleString()}
      </span>
    </button>
  );
  return (
    <nav className="w-64 flex-none overflow-y-auto overscroll-contain border-r border-border px-3 pt-4 pb-6">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick({ kind: "continue" })}
        className={cn(row(selected.kind === "continue"), "font-medium")}
      >
        Continue watching
      </button>
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick({ kind: "recent" })}
        className={cn(row(selected.kind === "recent"), "font-medium")}
      >
        {kind === "movie" ? "Recently added" : "Recently updated"}
      </button>
      <div className="mt-3" />
      {groups.order.map((entry) => {
        if ("category" in entry) return category(entry.category, false);
        const members = groups.byGroup.get(entry.group) ?? [];
        const expanded = open.has(entry.group);
        return (
          <div key={`g:${entry.group}`}>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(entry.group)}
              className={cn(row(false), "font-medium")}
            >
              <span className="min-w-0 flex-1 truncate">{entry.group}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {members.reduce((sum, member) => sum + member.count, 0).toLocaleString()}
              </span>
              <ChevronRight
                className={cn("size-3.5 text-muted-foreground", expanded && "rotate-90")}
              />
            </button>
            {expanded && members.map((member) => category(member, true))}
          </div>
        );
      })}
    </nav>
  );
}

/** The posters in rows that fit the width, drawing only the rows in view. */
function Grid({
  total,
  titleAt,
  onVisible,
  active,
}: {
  total: number;
  titleAt: (index: number) => Title | undefined;
  onVisible: (first: number, last: number) => void;
  active: boolean;
}) {
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
    onVisible(firstRow * columns, Math.min(total - 1, (lastRow + 1) * columns - 1));
  }, [firstRow, lastRow, columns, total, onVisible]);

  const keyboard = useKeyboardMode();
  const [selected, setSelected] = useState(0);
  const state = useRef({ selected, columns, total, titleAt, rowsInView: items.length });
  state.current = { selected, columns, total, titleAt, rowsInView: items.length };
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.details || ui.playingTitle) return;
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
          if (title) openDetails({ kind: title.kind, id: title.id });
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
              return (
                <Poster
                  key={index}
                  title={title}
                  selected={keyboard && active && index === selected}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Poster({ title, selected }: { title: Title | undefined; selected: boolean }) {
  if (!title) {
    return (
      <div>
        <div className="aspect-[2/3] rounded-xl bg-white/4" />
      </div>
    );
  }
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openDetails({ kind: title.kind, id: title.id })}
      className="group min-w-0 text-left"
      title={title.name}
    >
      <span
        className={cn(
          "block aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]",
          selected && "ring-2 ring-white",
        )}
      >
        <Artwork url={title.posterUrl} name={title.title} />
      </span>
      <span className="mt-2 block truncate text-[0.875rem] font-medium">{title.title}</span>
      <span className="block truncate text-xs text-muted-foreground">
        {[title.year, title.rating ? `★ ${title.rating.toFixed(1)}` : null, ...title.tags]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </button>
  );
}
