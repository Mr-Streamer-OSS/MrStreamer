// Downloads: the queue on top, the copies on this computer below, each a row with what it is,
// how it stands and what can be done with it. The queue's one transfer shows its progress, a
// download whose subscription plays waits for it, and one that failed says why, with Retry. A
// copy plays offline from here, with how far it was watched, and says so once its subscription
// went. Everything here is read from this computer; artwork comes from the copies' own folders.
//   With no subscription saved the page stands alone, opened from Connect: its bar has only
//   Downloads, and Add subscription goes back to the form.
import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState } from "react";
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

export function DownloadsPage({ standalone = false }: { standalone?: boolean }) {
  const list = useDownloads();
  const items = list.data?.items ?? [];
  const queue = items.filter((item) => !onComputer(item));
  const copies = items.filter(onComputer);
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
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-10">
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
              <Row key={item.id} item={item} />
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

function Row({ item }: { item: Download }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => call("downloads.remove", { id: item.id }) });
  const retry = useMutation({ mutationFn: () => call("downloads.retry", { id: item.id }) });
  const { status } = item;
  const episode = episodeLine(item);
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
  return (
    <div
      data-download={item.id}
      className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-white/8 py-3 last:border-b-0"
    >
      <span className="block aspect-[2/3] overflow-hidden rounded-md">
        <Artwork url={item.posterUrl} name={item.name} size="thumb" plain />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[0.9375rem] font-medium">
          {episode ? `${item.name} · ${episode}` : item.name}
        </div>
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
      </div>
      <div className="flex items-center gap-2">
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
          <Button size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t("Cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
