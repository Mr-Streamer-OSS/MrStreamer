// Downloads: the queue on top, the copies on this computer below, each a row with what it is,
// how it stands and what can be done with it. The queue goes in its order: its one transfer leads
// with its progress, then the downloads waiting their turn, then the failed ones, which say why,
// with Retry. Up and Down move a waiting one a place among them, kept at once; the transfer and
// every waiting one have Pause, or Resume once paused. A download the viewer paused says so and
// keeps its partial file until resumed, while one whose subscription plays waits for that. Pause
// all in the heading pauses everything that can be, then Resume all lets it all go on. A pause, a
// resume or a move that can't be kept says so on its row, or under the heading, its control there
// to press again. A button of a row keeps the keyboard wherever the list moves its row, and where
// the row reached an end the other arrow takes it. A copy plays offline from here, with
// how far it was watched, and says so once its subscription went. Two or more copies of one series
// go together under its name, which folds them away, season by season in the series' order, with
// the episodes between them that aren't on this computer (see @mrstreamer/core/downloads/series).
// Everything here is read from this computer; artwork comes from the copies' own folders.
//   Under the heading, the household folder new downloads go to, with Change folder. Each row,
// and each series, has a round box to select it; with any selected, a bar offers what fits them:
// Pause, Resume, Retry, Move to the folder for finished copies, and Delete, which asks again with
// its count on a second press. Each answer is per download, a move's too: a row that failed says
// why, stays selected and Try again runs the action again on those. A copy moving says so on its
// row, with Cancel move, which keeps its original before commit or the committed moved copy after
// commit, and stops the remaining selection.
//   With no subscription saved the page stands alone, opened from Connect: its bar has only
//   Downloads, and Recordings once any is kept, Add subscription, which goes back to the form,
//   and the profile avatar.
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, Minus, Pause, Play } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Download,
  DownloadBulkAction,
  DownloadBulkResult,
  DownloadFolder,
} from "@mrstreamer/contracts/downloads";
import type { AppError } from "@mrstreamer/contracts/errors";
import { copyShelf, type ShelfSeries } from "@mrstreamer/core/downloads/series";
import { formatBytes, formatNumber, t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { browsingNow, openView, useUi } from "../../app/ui-store.ts";
import { useKeptScroll } from "../../lib/use-kept-scroll.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { BarFrame, Brand, PageButton, WindowBar } from "../../components/WindowBar.tsx";
import { statusLine, transferred, useDownloads, watchOffline } from "../../lib/downloads.ts";
import { ProfileMenu } from "../profiles/ProfileMenu.tsx";
import { useAnyRecording } from "../recordings/recordings.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { runtime, timeLeftOf } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { episodeLine } from "../../player/title-player.ts";
import { isFinished } from "@mrstreamer/core/viewing/titles";

/**
 * Hands the keyboard on where drawing the list turned off the arrow that had it, `had` being where
 * it was as the list came: the row's other arrow takes it. React gives a button the keyboard back
 * when the list moves its row, but can't give it to an arrow turned off at an end. Anything else,
 * as a button that went with its row or a keyboard the viewer had elsewhere, is left alone.
 */
function handOn(had: Element | null) {
  if (!(had instanceof HTMLButtonElement) || !had.disabled || !had.isConnected) return;
  const by = Number(had.dataset["move"]);
  const now = document.activeElement;

  if (!by || (now !== had && now !== null && now !== document.body)) return;
  const other = had.closest("[data-download]")?.querySelector(`[data-move="${-by}"]`);

  if (other instanceof HTMLButtonElement && !other.disabled) other.focus();
}

/** The latest action's answer: how many of how many went, and why each other one didn't. */
interface Outcome {
  readonly action: DownloadBulkAction;
  readonly total: number;
  readonly done: number;
  readonly failed: ReadonlyMap<string, AppError>;
}

/** Which of `items` each action applies to: only these are sent, so its count is honest. */
function applicable(items: readonly Download[], action: DownloadBulkAction): string[] {
  return items.flatMap(({ id, status }) =>
    (
      action === "pause"
        ? status.kind === "transferring" || status.kind === "queued" || status.kind === "waiting"
        : action === "resume"
          ? status.kind === "paused"
          : action === "retry"
            ? status.kind === "failed"
            : action === "move"
              ? status.kind === "complete"
              : true
    )
      ? [id]
      : [],
  );
}

/** The last name in a folder's path, as a button names where it moves copies. */
function folderName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

export function DownloadsPage({ standalone = false }: { standalone?: boolean }) {
  const list = useDownloads();
  const items = list.data?.items ?? [];
  const queue = items.filter((item) => !onComputer(item));
  const shelf = useMemo(() => (list.data ? copyShelf(list.data) : []), [list.data]);
  // Main lists the ones waiting together, after the transfer.
  const line = queue.filter(waiting);

  const pausable = queue.some(
    (item) =>
      item.status.kind === "transferring" || (waiting(item) && item.status.kind !== "paused"),
  );

  const paused = queue.some((item) => item.status.kind === "paused");

  const all = useMutation({
    mutationFn: (pause: boolean) =>
      pause ? call("downloads.pauseAll") : call("downloads.resumeAll"),
  });

  const storage = list.data?.storage;
  // How far the page was scrolled when the viewer last left it, kept again as it goes. The picks
  // stay behind: a bulk action is chosen anew for what the page shows.
  const scroller = useRef<HTMLDivElement>(null);
  const [kept] = useState(() => useUi.getState().browsing.downloads.top);
  const keep = useMemo(() => browsingNow("downloads"), []);
  useKeptScroll(scroller, {
    from: kept,
    keep: (top) => keep(() => ({ top })),
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const chosen = items.filter((item) => selected.has(item.id));
  const admission = useRef(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const select = (ids: readonly string[], on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);

      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }

      return next;
    });

  // Main answers for each download; a call that fails whole fails each of them.
  const run = useMutation({
    mutationFn: ({
      action,
      ids,
    }: {
      action: DownloadBulkAction;
      ids: readonly string[];
      generation: number;
    }) =>
      call("downloads.bulk", { ids: [...ids], action }).catch((cause): DownloadBulkResult => ({
        succeeded: [],
        failed: ids.map((id) => ({ id, error: appError(cause) })),
      })),
    onSuccess: ({ succeeded, failed }, { action, ids, generation: started }) => {
      if (started !== generation.current) return;
      setOutcome({
        action,
        total: ids.length,
        done: succeeded.length,
        failed: new Map(failed.map(({ id, error }) => [id, error])),
      });
    },
    onSettled: () => {
      admission.current = false;
    },
  });

  // Pressed again while one is under way, an action does nothing; it stays pressable.
  const start = (action: DownloadBulkAction, ids: readonly string[]) => {
    if (admission.current || ids.length === 0) return;
    admission.current = true;
    setOutcome(null);
    run.mutate({ action, ids, generation: generation.current });
  };

  const finish = () => {
    setSelected(new Set());
    setOutcome(null);
    generation.current++;
  };

  const picking: Picking = {
    selected,
    select,
    moving: new Set(storage?.moving),
    failed: outcome?.failed ?? new Map(),
    folder: storage ? folderName(storage.path) : "",
  };

  // Where the keyboard is as this list is drawn, for `handOn` once it is.
  const had = document.activeElement;
  useLayoutEffect(() => {
    handOn(had);

    // The bar went with the keyboard on it, by Done or deleting the last selected: the heading
    // takes it, so the keyboard stays on the page.
    if (
      had instanceof HTMLElement &&
      had.closest("[data-selection]") &&
      !had.isConnected &&
      (document.activeElement === null || document.activeElement === document.body)
    )
      heading.current?.focus();
  });

  const summary = list.data
    ? [
        list.data.bytes > 0
          ? t("{size} on this computer", { size: formatBytes(list.data.bytes) })
          : null,
        list.data.free !== null ? t("{size} free", { size: formatBytes(list.data.free) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="flex h-full flex-col">
      {standalone ? <OfflineBar /> : <WindowBar className="bg-black" />}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-10">
        <div className="mb-3 flex items-baseline gap-3">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            {t("Downloads")}
          </h1>
          {items.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatNumber(items.length)}
            </span>
          )}
          <span className="ml-auto text-[0.8125rem] text-muted-foreground tabular-nums">
            {summary}
          </span>
          {(pausable || paused) && (
            <Button
              size="sm"
              className="self-center"
              onClick={() => {
                // Pressed again while it is under way, it does nothing: it stays pressable.
                if (!all.isPending) all.mutate(pausable);
              }}
            >
              {pausable ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              {pausable ? t("Pause all") : t("Resume all")}
            </Button>
          )}
        </div>
        {all.error && (
          <p role="alert" className="mb-2 text-[0.8125rem] text-destructive">
            {t("Couldn't save. Try again.")}
          </p>
        )}
        {storage && <Folder storage={storage} />}
        {chosen.length > 0 && (
          <SelectionBar
            chosen={chosen}
            pending={run.isPending}
            folder={storage ? folderName(storage.path) : null}
            start={start}
            finish={finish}
          />
        )}
        <div role="status" className="empty:hidden mb-3 flex items-center gap-3 text-[0.8125rem]">
          {outcome && (
            <>
              <span className={cn(outcome.failed.size > 0 && "text-destructive")}>
                {t("{done} of {total} done", {
                  done: outcome.done,
                  total: outcome.total,
                })}
              </span>
              {outcome.failed.size > 0 && (
                <Button
                  size="sm"
                  onClick={() =>
                    start(
                      outcome.action,
                      items.flatMap(({ id }) => (outcome.failed.has(id) ? [id] : [])),
                    )
                  }
                >
                  {t("Try again")}
                </Button>
              )}
            </>
          )}
        </div>
        {list.error ? (
          <p className="text-sm text-destructive">{describeError(appError(list.error))}</p>
        ) : list.data && items.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t("Nothing downloaded yet. Download a movie or an episode from its details.")}
          </p>
        ) : null}
        {queue.length > 0 && (
          <section aria-label={t("Queue")}>
            <h2 className="mt-2 mb-1 text-[0.9375rem] font-semibold">{t("Queue")}</h2>
            {queue.map((item) => (
              <Row
                key={item.id}
                item={item}
                picking={picking}
                first={line[0] === item}
                last={line.at(-1) === item}
              />
            ))}
          </section>
        )}
        {shelf.length > 0 && (
          <section aria-label={t("On this computer")}>
            <h2
              className={cn(
                "mb-1 text-[0.9375rem] font-semibold",
                queue.length > 0 ? "mt-6" : "mt-2",
              )}
            >
              {t("On this computer")}
            </h2>
            {shelf.map((item) =>
              item.kind === "copy" ? (
                <Row key={item.copy.id} item={item.copy} picking={picking} />
              ) : (
                <SeriesCopies key={item.key} series={item} picking={picking} />
              ),
            )}
          </section>
        )}
        {list.data && list.data.ended > 0 && (
          <p className="mt-4 text-[0.8125rem] text-muted-foreground">
            {t("Unfinished downloads ended with their subscription.")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The bar of Downloads or Recordings standing alone: each while it keeps anything, or is on screen,
 * and the way back to adding a subscription.
 */
export function OfflineBar() {
  const view = useUi((state) => state.view);
  const downloads = (useDownloads().data?.items.length ?? 0) > 0 || view === "downloads";
  // Also while the list is read, or can't be, so Recordings' Retry stays in reach.
  const recordings = useAnyRecording() || view === "recordings";

  return (
    <BarFrame className="bg-black">
      <Brand />
      {downloads && (
        <PageButton view="downloads" current={view === "downloads"}>
          {t("Downloads")}
        </PageButton>
      )}
      {recordings && (
        <PageButton view="recordings" current={view === "recordings"}>
          {t("Recordings")}
        </PageButton>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => openView("home")}>
          {t("Add subscription")}
        </Button>
        <ProfileMenu />
      </div>
    </BarFrame>
  );
}

/** A copy, finished or with its file gone, rather than something in the queue. */
function onComputer(item: Download): boolean {
  return item.status.kind === "complete" || item.status.kind === "missing";
}

/** Waiting its turn in the queue, paused or not: what Up and Down move. */
function waiting(item: Download): boolean {
  return (
    item.status.kind === "queued" || item.status.kind === "waiting" || item.status.kind === "paused"
  );
}

/**
 * Two or more copies of one series together: a row with its name, its subscription, how many of its
 * episodes and seasons are on this computer and their size, then season by season each copy in the
 * series' order, with the episodes between them that aren't here. The arrow folds the episodes
 * away, and back, in place.
 */
function SeriesCopies({ series, picking }: { series: ShelfSeries; picking: Picking }) {
  const [open, setOpen] = useState(true);
  const [newest] = series.copies;

  if (!newest) return null;

  const seasons = new Set(
    series.copies.flatMap(({ title }) => (title.kind === "episode" ? [title.season] : [])),
  );

  const size = series.copies.reduce((sum, copy) => sum + (copy.size ?? 0), 0);
  const ids = series.copies.map(({ id }) => id);
  const picked = ids.filter((id) => picking.selected.has(id)).length;

  const facts = [
    newest.subscription?.name ?? t("Subscription removed, copy kept"),
    t("{count} episodes", { count: series.copies.length }),
    t("{count} seasons", { count: seasons.size }),
    size > 0 ? formatBytes(size) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="group"
      aria-label={newest.name}
      data-series={series.key}
      className="border-b border-white/8 last:border-b-0 [&>:last-child]:border-b-0"
    >
      <div className="grid grid-cols-[1.375rem_2.5rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-white/8 py-3">
        <Pick
          label={t("Select {name}", { name: newest.name })}
          checked={picked === ids.length}
          mixed={picked > 0 && picked < ids.length}
          onChange={(on) => picking.select(ids, on)}
        />
        <span className="block aspect-[2/3] overflow-hidden rounded-md">
          <Artwork url={newest.posterUrl} name={newest.name} size="thumb" plain />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium">{newest.name}</div>
          <div className="truncate text-xs text-muted-foreground">{facts}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={newest.name}
          aria-expanded={open}
          className={cn(open && "text-foreground")}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown className={cn(!open && "-rotate-90")} />
        </Button>
      </div>
      {open &&
        series.seasons.map((season) => (
          <Fragment key={season.key}>
            <div className="mt-2.5 ml-[5.875rem] text-[0.8125rem] font-semibold">
              {season.number === 0
                ? t("Specials")
                : t("Season {number}", { number: String(season.number) })}
            </div>
            {season.entries.map((entry) =>
              entry.kind === "copy" ? (
                <Row key={entry.copy.id} item={entry.copy} picking={picking} inSeries />
              ) : (
                <Gap
                  key={`gap:${entry.episodes[0]}`}
                  season={season.number}
                  episodes={entry.episodes}
                />
              ),
            )}
          </Fragment>
        ))}
    </div>
  );
}

/** Episodes the series lists between two of its copies, none of which is on this computer. */
function Gap({ season, episodes }: { season: number; episodes: readonly number[] }) {
  const [first = 0] = episodes;
  const last = episodes.at(-1) ?? first;

  return (
    <div className="ml-[5.875rem] grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-4 border-b border-white/8 py-1.5 text-xs text-muted-foreground last:border-b-0">
      <span />
      <span className="truncate">
        {episodes.length > 1
          ? t("{from} to {to} aren't on this computer", {
              from: episodeLabel(season, first),
              to: episodeLabel(season, last),
            })
          : t("{episode} isn't on this computer", { episode: episodeLabel(season, first) })}
      </span>
    </div>
  );
}

function Row({
  item,
  picking,
  first = false,
  last = false,
  inSeries = false,
}: {
  item: Download;
  picking: Picking;
  /** Whether it is the first, or last, of the downloads waiting their turn. */
  first?: boolean;
  last?: boolean;
  /** A copy among its series' copies, which name the series: it says its number and its name. */
  inSeries?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => call("downloads.remove", { id: item.id }) });
  const retry = useMutation({ mutationFn: () => call("downloads.retry", { id: item.id }) });

  const hold = useMutation({
    mutationFn: (pause: boolean) =>
      pause ? call("downloads.pause", { id: item.id }) : call("downloads.resume", { id: item.id }),
  });

  const move = useMutation({
    mutationFn: (by: -1 | 1) => call("downloads.move", { id: item.id, by }),
  });

  const cancelMove = useMutation({
    mutationFn: () => call("downloads.cancelMove", { id: item.id }),
  });

  // Pressed again while it is under way, a change does nothing; it isn't disabled meanwhile,
  // which would leave the keyboard on a button that can't be pressed.
  const holding = (pause: boolean) => () => {
    if (hold.isPending) return;
    move.reset();
    hold.mutate(pause);
  };

  const moving = (by: -1 | 1) => () => {
    if (move.isPending) return;
    hold.reset();
    move.mutate(by);
  };

  const { status, title } = item;
  const episode = episodeLine(item);
  const label = title.kind === "episode" ? episodeLabel(title.season, title.episode) : null;
  const numbered = inSeries && title.kind === "episode";

  const name =
    numbered && label
      ? (item.episodeName ?? label)
      : episode
        ? `${item.name} · ${episode}`
        : item.name;

  const copy = onComputer(item);

  const seen =
    status.kind === "complete" &&
    !!item.progress &&
    isFinished(item.progress.position, item.progress.duration);

  const facts = (
    numbered
      ? [item.duration ? runtime(item.duration) : null, seen ? t("Watched") : null]
      : [
          title.kind === "movie" ? item.year : null,
          copy && item.duration ? runtime(item.duration) : null,
          !copy ? item.subscription?.name : null,
          item.size ? formatBytes(item.size) : null,
          copy && !item.subscription ? t("Subscription removed, copy kept") : null,
        ]
  )
    .filter(Boolean)
    .join(" · ");

  const done = transferred(item);

  const watched =
    status.kind === "complete" &&
    item.progress &&
    !isFinished(item.progress.position, item.progress.duration)
      ? item.progress
      : null;

  const relocating = picking.moving.has(item.id);
  const line = relocating ? t("Moving to {folder}", { folder: picking.folder }) : statusLine(item);
  const failed = !relocating && (status.kind === "failed" || status.kind === "missing");
  const failure = picking.failed.get(item.id);
  const error = remove.error ?? retry.error ?? cancelMove.error;
  const unkept = hold.error ?? move.error;

  return (
    <div
      data-download={item.id}
      className={cn(
        "grid items-center gap-4 border-b border-white/8 last:border-b-0",
        numbered
          ? "grid-cols-[1.375rem_2.5rem_1.75rem_minmax(0,1fr)_auto] py-1.5"
          : "grid-cols-[1.375rem_2.5rem_minmax(0,1fr)_auto] py-3",
      )}
    >
      <Pick
        label={t("Select {name}", { name: numbered ? `${item.name} · ${name}` : name })}
        checked={picking.selected.has(item.id)}
        onChange={(on) => picking.select([item.id], on)}
      />
      {numbered && title.kind === "episode" ? (
        <span className="col-start-3 text-right text-xs text-muted-foreground tabular-nums">
          {title.episode}
        </span>
      ) : (
        <span className="block aspect-[2/3] overflow-hidden rounded-md">
          <Artwork url={item.posterUrl} name={item.name} size="thumb" plain />
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-[0.9375rem] font-medium">{name}</div>
        {facts && <div className="truncate text-xs text-muted-foreground">{facts}</div>}
        {(line || watched) && (
          <div
            className={cn(
              "mt-1 flex items-center gap-2 text-[0.8125rem] tabular-nums",
              failed ? "text-destructive" : status.kind === "queued" ? "text-muted-foreground" : "",
            )}
          >
            {done !== null && <Progress value={done} className="w-28" />}
            {watched && (
              <>
                <Progress value={watched.position / watched.duration} className="w-20" />
                <span className="text-muted-foreground">
                  {timeLeftOf({ ...watched, finished: false })}
                </span>
              </>
            )}
            {line && <span className="min-w-0 truncate">{line}</span>}
          </div>
        )}
        {(failure ?? error) && (
          <div className="mt-1 text-xs text-destructive">
            {describeError(failure ?? appError(error))}
          </div>
        )}
        {unkept && (
          <div role="alert" className="mt-1 text-xs text-destructive">
            {t("Couldn't save. Try again.")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {waiting(item) && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Move {name} up", { name })}
              data-move={-1}
              disabled={first}
              onClick={moving(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Move {name} down", { name })}
              data-move={1}
              disabled={last}
              onClick={moving(1)}
            >
              <ArrowDown />
            </Button>
          </>
        )}
        {(waiting(item) || status.kind === "transferring") && (
          <Button size="sm" data-hold onClick={holding(status.kind !== "paused")}>
            {status.kind === "paused" ? (
              <Play className="fill-current" />
            ) : (
              <Pause className="fill-current" />
            )}
            {status.kind === "paused" ? t("Resume download") : t("Pause download")}
          </Button>
        )}
        {status.kind === "complete" && (
          <Button
            variant="primary"
            size="sm"
            aria-label={
              numbered && label ? t("Watch {title} offline", { title: label }) : undefined
            }
            onClick={() => watchOffline(item)}
          >
            <Play className="fill-current" />
            {t("Watch offline")}
          </Button>
        )}
        {status.kind === "failed" && (
          <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {t("Retry")}
          </Button>
        )}
        {relocating && (
          <Button
            size="sm"
            onClick={() => {
              if (!cancelMove.isPending) cancelMove.mutate();
            }}
          >
            {t("Cancel move")}
          </Button>
        )}
        {relocating ? null : copy || status.kind === "failed" ? (
          <Button
            variant={confirming ? "destructive" : "ghost"}
            size="sm"
            disabled={remove.isPending}
            onBlur={() => setConfirming(false)}
            onClick={() => {
              // A copy goes only on a second press: it took a while to download.
              if (copy && !confirming) return setConfirming(true);
              remove.mutate();
            }}
          >
            {confirming ? t("Delete copy") : t("Delete")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t("Cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What a row needs of the page's selection: whether it is picked, moving or failed last time. */
interface Picking {
  readonly selected: ReadonlySet<string>;
  readonly select: (ids: readonly string[], on: boolean) => void;
  readonly moving: ReadonlySet<string>;
  readonly failed: ReadonlyMap<string, AppError>;
  /** The last name of the folder copies move to, as a moving row says. */
  readonly folder: string;
}

/** The round box that selects a row, or every copy of a series, `mixed` while only some are. */
function Pick({
  label,
  checked,
  mixed = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  onChange: (on: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  });

  return (
    <span className="relative grid size-[22px] place-items-center">
      <input
        ref={box}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer size-[22px] appearance-none rounded-full border-[1.5px] border-white/60 bg-black/30 outline-none checked:border-foreground checked:bg-foreground indeterminate:border-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Check
        strokeWidth={3}
        className="pointer-events-none absolute size-[13px] text-black opacity-0 peer-checked:opacity-100"
      />
      <Minus
        strokeWidth={3}
        className="pointer-events-none absolute size-[13px] opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  );
}

/**
 * The household folder new downloads go to, and Change folder, which opens the system's folder
 * picker in main. Closing the picker changes nothing; a folder that can't be used says why.
 */
function Folder({ storage }: { storage: DownloadFolder }) {
  const choose = useMutation({ mutationFn: () => call("downloads.chooseFolder") });

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
        <span className="min-w-0 truncate" title={storage.path}>
          {t("New downloads go to {folder}", { folder: storage.path })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="-my-1"
          onClick={() => {
            if (!choose.isPending) choose.mutate();
          }}
        >
          {t("Change folder")}
        </Button>
      </div>
      {choose.error && (
        <p role="alert" className="-mt-2 mb-3 text-[0.8125rem] text-destructive">
          {describeError(appError(choose.error))}
        </p>
      )}
    </>
  );
}

/**
 * With any download selected: how many, then each action that fits some of them, sent only for
 * those. Delete asks again with its count on a second press, and forgets once the keyboard leaves
 * it or Escape is pressed. Done clears the selection.
 */
function SelectionBar({
  pending,
  chosen,
  folder,
  start,
  finish,
}: {
  pending: boolean;
  chosen: readonly Download[];
  /** The last name of the household folder, or null where this computer has none to move to. */
  folder: string | null;
  start: (action: DownloadBulkAction, ids: readonly string[]) => void;
  finish: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const button = (action: DownloadBulkAction, label: string) => {
    const ids = applicable(chosen, action);

    return (
      ids.length > 0 && (
        <Button
          key={action}
          size="sm"
          className="h-auto min-h-8 max-w-full py-1 whitespace-normal wrap-anywhere text-left"
          disabled={pending}
          onClick={() => start(action, ids)}
          title={label}
        >
          {label}
        </Button>
      )
    );
  };

  return (
    <div
      role="group"
      aria-label={t("{count} selected", { count: chosen.length })}
      data-selection
      className="mb-3 flex min-h-11 flex-wrap items-center gap-2 py-1.5"
    >
      <span className="text-[0.8125rem] font-semibold tabular-nums">
        {t("{count} selected", { count: chosen.length })}
      </span>
      <span className="grow" />
      {button("pause", t("Pause download"))}
      {button("resume", t("Resume download"))}
      {button("retry", t("Retry"))}
      {folder !== null && button("move", t("Move to {folder}", { folder }))}
      <Button
        size="sm"
        variant={confirming ? "destructive" : "secondary"}
        disabled={pending}
        onBlur={() => setConfirming(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && confirming) {
            event.preventDefault();
            setConfirming(false);
          }
        }}
        onClick={() => {
          if (!confirming) return setConfirming(true);
          setConfirming(false);
          start("remove", applicable(chosen, "remove"));
        }}
      >
        {confirming ? t("Delete {count} downloads", { count: chosen.length }) : t("Delete")}
      </Button>
      <Button variant="ghost" size="sm" onClick={finish}>
        {t("Done")}
      </Button>
    </div>
  );
}
