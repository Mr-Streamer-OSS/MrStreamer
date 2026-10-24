// Downloads: the queue on top, the copies on this computer below, each a row with what it is,
// how it stands and what can be done with it. The queue goes in its order: its one transfer leads
// with its progress, then the downloads waiting their turn, then the failed ones, which say why,
// with Retry. Up and Down move a waiting one a place among them, kept at once; the transfer and
// every waiting one have Pause, or Resume once paused. A download the viewer paused says so and
// keeps its partial file until resumed, while one whose subscription plays waits for that. Pause
// all in the heading pauses everything that can be, then Resume all lets it all go on. A pause, a
// resume or a move that can't be kept says so on its row, or under the heading, its control there
// to press again. Pressed from the keyboard, the control keeps the keyboard wherever its row goes,
// or the other arrow takes it where the row reached an end. A copy plays offline from here, with
// how far it was watched, and says so once its subscription went. Everything here is read from
// this computer; artwork comes from the copies' own folders.
//   With no subscription saved the page stands alone, opened from Connect: its bar has only
//   Downloads, and Add subscription goes back to the form.
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { Download } from "@mrstreamer/contracts/downloads";
import { formatBytes, formatNumber, t } from "@mrstreamer/core/i18n";
import { openView } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { BarFrame, Brand, PageButton, WindowBar } from "../../components/WindowBar.tsx";
import {
  episodeLine,
  statusLine,
  transferred,
  useDownloads,
  watchOffline,
} from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { runtime, timeLeftOf } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { isFinished } from "@mrstreamer/core/viewing/titles";

/**
 * A row's change kept from the keyboard, and where the keyboard goes once the row shows it: back
 * to its control. `was` is how the row stood as it was pressed: its place among the rows and what
 * its Pause or Resume said.
 */
type Refocus = {
  readonly id: string;
  readonly control: "hold" | -1 | 1;
  readonly was: string;
};

/** `element` when it is a button that can be pressed. */
const pressable = (element: Element | null | undefined) =>
  element instanceof HTMLButtonElement && !element.disabled ? element : null;

/** How `row` stands among the page's rows, as `Refocus.was` keeps it. */
const standing = (row: Element) =>
  `${[...(row.parentElement?.querySelectorAll("[data-download]") ?? [])].indexOf(row)} ${
    row.querySelector("[data-hold]")?.textContent ?? ""
  }`;

export function DownloadsPage({ standalone = false }: { standalone?: boolean }) {
  const list = useDownloads();
  const items = list.data?.items ?? [];
  const queue = items.filter((item) => !onComputer(item));
  const copies = items.filter(onComputer);
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
  const page = useRef<HTMLDivElement>(null);
  const refocus = useRef<Refocus | null>(null);
  // Main's answer and its list come in either order: whichever comes last finds the row moved.
  const refocusNow = useCallback(() => {
    const wanted = refocus.current;
    if (!wanted) return;
    const row = [...(page.current?.querySelectorAll<HTMLElement>("[data-download]") ?? [])].find(
      (each) => each.dataset["download"] === wanted.id,
    );
    if (row && standing(row) === wanted.was) return;
    refocus.current = null;
    // Only while the keyboard has nowhere else to be: the viewer may have gone on meanwhile.
    const focused = document.activeElement;
    if (!row || (focused && focused !== document.body && !row.contains(focused))) return;
    const target =
      wanted.control === "hold"
        ? pressable(row.querySelector("[data-hold]"))
        : (pressable(row.querySelector(`[data-move="${wanted.control}"]`)) ??
          pressable(row.querySelector(`[data-move="${-wanted.control}"]`)));
    target?.focus();
  }, []);
  useEffect(refocusNow, [list.data, refocusNow]);
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
      <div ref={page} className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-10">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Downloads")}</h1>
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
                first={line[0] === item}
                last={line.at(-1) === item}
                onKept={(wanted) => {
                  refocus.current = wanted;
                  refocusNow();
                }}
              />
            ))}
          </section>
        )}
        {copies.length > 0 && (
          <section aria-label={t("On this computer")}>
            <h2
              className={cn(
                "mb-1 text-[0.9375rem] font-semibold",
                queue.length > 0 ? "mt-6" : "mt-2",
              )}
            >
              {t("On this computer")}
            </h2>
            {copies.map((item) => (
              <Row key={item.id} item={item} />
            ))}
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

/** The bar of the page standing alone: Downloads, and the way back to adding a subscription. */
function OfflineBar() {
  return (
    <BarFrame className="bg-black">
      <Brand />
      <PageButton view="downloads" current>
        {t("Downloads")}
      </PageButton>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => openView("home")}>
          {t("Add subscription")}
        </Button>
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
 * How its row stood when `event` pressed a control the keyboard is on, which it then gets back;
 * null when the pointer pressed it.
 */
const fromKeyboard = (event: MouseEvent<HTMLElement>) => {
  const row = event.currentTarget.closest("[data-download]");
  return event.currentTarget === document.activeElement && row ? standing(row) : null;
};

function Row({
  item,
  first = false,
  last = false,
  onKept = () => {},
}: {
  item: Download;
  /** Whether it is the first, or last, of the downloads waiting their turn. */
  first?: boolean;
  last?: boolean;
  /** Once a pause, resume or move pressed from the keyboard was kept. */
  onKept?: (refocus: Refocus) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => call("downloads.remove", { id: item.id }) });
  const retry = useMutation({ mutationFn: () => call("downloads.retry", { id: item.id }) });
  // Kept from the keyboard, each hands the page where the keyboard goes, with how the row stood.
  const hold = useMutation({
    mutationFn: ({ pause }: { readonly pause: boolean; readonly was: string | null }) =>
      pause ? call("downloads.pause", { id: item.id }) : call("downloads.resume", { id: item.id }),
    onSuccess: (_, { was }) => {
      if (was !== null) onKept({ id: item.id, control: "hold", was });
    },
  });
  const move = useMutation({
    mutationFn: ({ by }: { readonly by: -1 | 1; readonly was: string | null }) =>
      call("downloads.move", { id: item.id, by }),
    onSuccess: (_, { by, was }) => {
      if (was !== null) onKept({ id: item.id, control: by, was });
    },
  });
  // Pressed again while it is under way, a change does nothing; it isn't disabled meanwhile,
  // which would leave the keyboard on a button that can't be pressed.
  const holding = (pause: boolean) => (event: MouseEvent<HTMLElement>) => {
    if (hold.isPending) return;
    move.reset();
    hold.mutate({ pause, was: fromKeyboard(event) });
  };
  const moving = (by: -1 | 1) => (event: MouseEvent<HTMLElement>) => {
    if (move.isPending) return;
    hold.reset();
    move.mutate({ by, was: fromKeyboard(event) });
  };
  const { status } = item;
  const episode = episodeLine(item);
  const name = episode ? `${item.name} · ${episode}` : item.name;
  const copy = onComputer(item);
  const facts = [
    item.title.kind === "movie" ? item.year : null,
    copy && item.duration ? runtime(item.duration) : null,
    !copy ? item.subscription?.name : null,
    item.size ? formatBytes(item.size) : null,
    copy && !item.subscription ? t("Subscription removed, copy kept") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const done = transferred(item);
  const watched =
    status.kind === "complete" &&
    item.progress &&
    !isFinished(item.progress.position, item.progress.duration)
      ? item.progress
      : null;
  const line = statusLine(item);
  const failed = status.kind === "failed" || status.kind === "missing";
  const error = remove.error ?? retry.error;
  const unkept = hold.error ?? move.error;
  return (
    <div
      data-download={item.id}
      className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-white/8 py-3 last:border-b-0"
    >
      <span className="block aspect-[2/3] overflow-hidden rounded-md">
        <Artwork url={item.posterUrl} name={item.name} size="thumb" plain />
      </span>
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
        {error && (
          <div className="mt-1 text-xs text-destructive">{describeError(appError(error))}</div>
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
          <Button variant="primary" size="sm" onClick={() => watchOffline(item)}>
            <Play className="fill-current" />
            {t("Watch offline")}
          </Button>
        )}
        {status.kind === "failed" && (
          <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {t("Retry")}
          </Button>
        )}
        {copy || status.kind === "failed" ? (
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
