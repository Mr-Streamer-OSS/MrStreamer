// Download in a title's details: beside a movie's Play and Watchlist, and as an icon on each
// episode's row. One control says how the download of that exact version stands and does the one
// thing that fits: Download, Cancel while it is queued or transfers, Retry after it failed, and
// Watch offline once it is on this computer, with Delete in the menu beside it. There is no
// season-wide download.
import { Menu } from "@base-ui/react/menu";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownToLine, Check, ChevronDown, Play, RotateCw } from "lucide-react";
import type { Download, DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { formatPercent, t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { describeFailure, transferred, useDownloadOf, watchOffline } from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";

/** What happens to a version's download from its details, and why the last of it failed. */
function useDownload(title: TitleRef) {
  const download = useDownloadOf(title.subscriptionId, title);
  const add = useMutation({ mutationFn: () => call("downloads.add", { title }) });
  const remove = useMutation({
    mutationFn: (id: string) => call("downloads.remove", { id }),
  });
  const retry = useMutation({ mutationFn: (id: string) => call("downloads.retry", { id }) });
  const error = add.error ?? remove.error ?? retry.error;
  return {
    download,
    busy: add.isPending || remove.isPending || retry.isPending,
    add: () => add.mutate(),
    remove: (id: string) => remove.mutate(id),
    retry: (id: string) => retry.mutate(id),
    error: error ? describeError(appError(error)) : null,
  };
}

/** A failure in a word or two, for a button; the Downloads page says it whole. */
function shortly(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "disk-full":
      return t("Disk full");
    case "folder":
      return t("Can't write");
    case "stream":
      return failure.failure.kind === "refused" ? t("Refused") : t("Stopped");
    case "app":
      return t("Stopped");
  }
}

/** A movie's Download, beside Play and Watchlist. */
export function MovieDownload({ title }: { title: TitleRef }) {
  const { download, busy, add, remove, retry, error } = useDownload(title);
  return (
    <>
      <MovieState download={download} busy={busy} add={add} remove={remove} retry={retry} />
      {error && <p className="basis-full text-sm text-destructive">{error}</p>}
    </>
  );
}

function MovieState({
  download,
  busy,
  add,
  remove,
  retry,
}: {
  download: Download | null;
  busy: boolean;
  add: () => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}) {
  if (!download) {
    return (
      <Button variant="secondary" size="lg" disabled={busy} onClick={add}>
        <ArrowDownToLine />
        {t("Download")}
      </Button>
    );
  }
  const { status, id } = download;
  switch (status.kind) {
    case "queued":
    case "waiting":
      return (
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          aria-label={
            status.kind === "queued"
              ? t("Queued, cancel download")
              : t("Waiting for playback, cancel download")
          }
          onClick={() => remove(id)}
        >
          {status.kind === "queued" ? t("Queued") : t("Waiting for playback")} · {t("Cancel")}
        </Button>
      );
    case "transferring": {
      const done = transferred(download);
      const percent = done === null ? null : formatPercent(Math.floor(done * 100) / 100);
      return (
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          aria-label={
            percent === null
              ? t("Downloading, cancel download")
              : t("Downloading {percent}, cancel download", { percent })
          }
          onClick={() => remove(id)}
          className="tabular-nums"
        >
          {done !== null && <Progress value={done} className="w-12" />}
          {percent ?? t("Downloading")}
        </Button>
      );
    }
    case "failed":
      return (
        <Button
          variant="destructive"
          size="lg"
          disabled={busy}
          aria-label={t("{reason} Retry download", { reason: describeFailure(status.failure) })}
          onClick={() => retry(id)}
        >
          <RotateCw />
          {shortly(status.failure)} · {t("Retry")}
        </Button>
      );
    case "missing":
      return (
        <Button variant="destructive" size="lg" disabled={busy} onClick={() => remove(id)}>
          {t("File missing")} · {t("Delete")}
        </Button>
      );
    case "complete":
      return (
        <span className="flex">
          <Button
            variant="secondary"
            size="lg"
            onClick={() => watchOffline(download)}
            className="rounded-r-none pr-5"
          >
            <Play className="fill-current" />
            {t("Watch offline")}
          </Button>
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="secondary"
                  size="lg"
                  aria-label={t("Download options")}
                  className="rounded-l-none border-l border-black/40 px-3"
                />
              }
            >
              <ChevronDown />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
                <Menu.Popup className="bg-black p-2 text-[0.875rem] text-white ring-1 ring-white/15 outline-none">
                  <Menu.Item
                    closeOnClick
                    onClick={() => remove(id)}
                    className="px-2 py-2 outline-none data-highlighted:bg-white/10"
                  >
                    {t("Delete download")}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </span>
      );
  }
}

/** An episode row's download: an icon to start it, then how it stands. */
export function EpisodeDownload({ title }: { title: Extract<TitleRef, { kind: "episode" }> }) {
  const { download, busy, add, remove, retry, error } = useDownload(title);
  const label = episodeLabel(title.season, title.episode);
  const shared = {
    variant: "ghost",
    size: "sm",
    disabled: busy,
    title: error ?? undefined,
  } as const;
  if (!download) {
    return (
      <Button
        {...shared}
        size="icon-sm"
        aria-label={t("Download {title}", { title: label })}
        onClick={add}
      >
        <ArrowDownToLine />
      </Button>
    );
  }
  const { status, id } = download;
  switch (status.kind) {
    case "complete":
      return (
        <Button
          {...shared}
          aria-label={t("Watch {title} offline", { title: label })}
          onClick={() => watchOffline(download)}
        >
          <Check />
          {t("Downloaded")}
        </Button>
      );
    case "queued":
    case "waiting":
      return (
        <Button
          {...shared}
          aria-label={t("Cancel download of {title}", { title: label })}
          onClick={() => remove(id)}
        >
          {status.kind === "queued" ? t("Queued") : t("Waiting")}
        </Button>
      );
    case "transferring": {
      const done = transferred(download);
      return (
        <Button
          {...shared}
          aria-label={t("Cancel download of {title}", { title: label })}
          onClick={() => remove(id)}
          className="tabular-nums"
        >
          {done !== null && <Progress value={done} className="w-9" />}
          {done === null ? "…" : formatPercent(Math.floor(done * 100) / 100)}
        </Button>
      );
    }
    case "failed":
      return (
        <Button
          {...shared}
          aria-label={t("{reason} Retry download of {title}", {
            reason: describeFailure(status.failure),
            title: label,
          })}
          onClick={() => retry(id)}
          className="text-destructive"
        >
          <RotateCw />
          {t("Retry")}
        </Button>
      );
    case "missing":
      return (
        <Button
          {...shared}
          aria-label={t("Download of {title} missing, delete it", { title: label })}
          onClick={() => remove(id)}
          className="text-destructive"
        >
          {t("Missing")}
        </Button>
      );
  }
}
