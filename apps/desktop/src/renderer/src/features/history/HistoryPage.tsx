// The viewer's History, opened from Home's heading in Home's place: every film and series version
// this profile played or marked, most recent first, and beside it what played on this computer.
//
// Online entries come from the viewing record (`viewing.history`), one per version in its own
// subscription, with the titles from the lists: an entry the lists no longer have, or one for
// adults, is left out. Each says how far it got or how it was marked, and when, and its three dots
// mark the film or the whole series watched or unwatched with Undo (`useTitleMarks`), or take it
// out of Continue watching. History has nothing to delete for good.
//
// Downloads and recordings keep their own places, per profile, apart from the online record:
// they never share progress with an online entry, nor with each other, and show in a column of
// their own. A recording says when it was last played; a download keeps no such time, so its
// rows go in the downloads list's order and name no time.
import { Menu } from "@base-ui/react/menu";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, Circle, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { HistoryEntry } from "@mrstreamer/contracts/viewing";
import { t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { openDetails, openView } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { useDownloads, watchOffline } from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { queries, useSubscriptionNames } from "../../lib/queries.ts";
import { timeLeftOf, useInContinueWatching, useRemoveFromContinue } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { kindLabel } from "../../lib/watchlist.ts";
import {
  playRecording,
  useRecordingResume,
  useRecordings,
  type RecordingPlace,
} from "../recordings/recordings.ts";
import {
  filmScope,
  MarkItem,
  TitleMarkNotice,
  useTitleMarks,
  type TitleMarks,
} from "../titles/EpisodeMarks.tsx";
import { recordingLine } from "./places.ts";

const NO_ENTRIES: readonly HistoryEntry[] = [];

export function HistoryPage({ onBack }: { onBack: () => void }) {
  const history = useQuery(queries.history());
  const entries = history.data ?? NO_ENTRIES;

  // Undo goes by the marks that still stand, as the record last listed them.
  const marks = useTitleMarks(
    history.data && new Set(entries.flatMap((entry) => (entry.mark ? [entry.mark.revision] : []))),
  );

  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <div className="flex items-center gap-3 px-10 pt-5 pb-1.5">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3.5">
          <ChevronLeft />
          {t("Home")}
        </Button>
        <h1 className="text-2xl font-semibold">{t("History")}</h1>
      </div>
      <TitleMarkNotice marks={marks} className="px-10 pb-2" />
      <div className="grid items-start gap-x-14 gap-y-10 px-10 pt-3 pb-16 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section aria-labelledby="history-online">
          <h2 id="history-online" className="mb-2.5 text-xl font-semibold tracking-tight">
            {t("Movies and series")}
          </h2>
          {history.data ? (
            <OnlineHistory entries={entries} marks={marks} />
          ) : history.error ? (
            <Failure
              text={`${t("Couldn't read what you watched.")} ${describeError(appError(history.error))}`}
              onRetry={() => void history.refetch()}
            />
          ) : (
            <p className="text-[0.9375rem] text-muted-foreground">{t("Loading…")}</p>
          )}
        </section>
        <section aria-labelledby="history-local">
          <h2 id="history-local" className="mb-2.5 text-xl font-semibold tracking-tight">
            {t("On this computer")}
          </h2>
          <LocalHistory />
        </section>
      </div>
    </div>
  );
}

/** An online entry with the title the lists have for it, and the version it is of. */
interface Listed {
  readonly entry: HistoryEntry;
  readonly title: Title;
  readonly version: OwnedId;
}

const versionOf = (entry: HistoryEntry): OwnedId =>
  entry.kind === "movie" ? entry.movie : entry.series;

/** The titles the lists have for the entries' versions, read without the provider. */
function useListed(entries: readonly HistoryEntry[], kind: TitleKind) {
  const versions = entries.flatMap((entry) =>
    (entry.kind === "movie") === (kind === "movie") ? [versionOf(entry)] : [],
  );

  return useQuery({ ...queries.continuing(kind, versions), placeholderData: keepPreviousData });
}

function OnlineHistory({
  entries,
  marks,
}: {
  entries: readonly HistoryEntry[];
  marks: TitleMarks;
}) {
  const movies = useListed(entries, "movie");
  const series = useListed(entries, "series");
  const removal = useRemoveFromContinue();
  const nameOf = useSubscriptionNames();
  const now = useNow();

  const byVersion = new Map(
    [...(movies.data ?? []), ...(series.data ?? [])].flatMap((title) =>
      title.versions.map((version) => [`${title.kind}:${ownedKey(version)}`, title] as const),
    ),
  );

  const listed: readonly Listed[] = entries.flatMap((entry) => {
    const version = versionOf(entry);
    const title = byVersion.get(`${entry.kind}:${ownedKey(version)}`);

    return title && !title.adult ? [{ entry, title, version }] : [];
  });

  const failed = movies.error ?? series.error;
  const loading = movies.isLoading || series.isLoading;

  return (
    <>
      {listed.map((row) => (
        <HistoryRow
          key={`${row.entry.kind}:${ownedKey(row.version)}`}
          row={row}
          marks={marks}
          now={now}
          // Whose it is, once the title's versions are of several subscriptions.
          source={
            new Set(row.title.versions.map((each) => each.subscriptionId)).size > 1
              ? nameOf(row.version.subscriptionId)
              : null
          }
          onRemove={() => removal.mutate(historyTitle(row))}
        />
      ))}
      {failed && (
        <Failure
          text={describeError(appError(failed))}
          onRetry={() => {
            void movies.refetch();
            void series.refetch();
          }}
        />
      )}
      {removal.error && (
        <p className="mt-3 text-sm text-destructive">{describeError(appError(removal.error))}</p>
      )}
      {listed.length === 0 && !failed && !loading && (
        <p className="text-[0.9375rem] text-muted-foreground">{t("Nothing watched yet.")}</p>
      )}
    </>
  );
}

/** How an online entry stands: its line's last part, and how far its bar goes, if it has one. */
function standingOf(entry: HistoryEntry): {
  readonly text: string | null;
  readonly done: number | null;
} {
  if (entry.kind === "movie") {
    // Under a mark that stands, how far it played says nothing.
    if (entry.mark)
      return {
        text: entry.mark.watched ? t("marked watched") : t("marked unwatched"),
        done: null,
      };

    const { progress } = entry;

    if (!progress) return { text: null, done: null };

    return progress.finished
      ? { text: t("watched"), done: 1 }
      : { text: timeLeftOf(progress), done: progress.position / progress.duration };
  }

  const { mark, progress } = entry;

  // The later of the last mark and the last play says where the series stands.
  if (mark && (!progress || mark.at >= progress.at)) {
    const episode = episodeLabel(mark.season, mark.episode);

    return {
      text: mark.watched
        ? t("{episode} marked watched", { episode })
        : t("{episode} marked unwatched", { episode }),
      done: null,
    };
  }

  if (!progress || progress.title.kind !== "episode") return { text: null, done: null };
  const episode = episodeLabel(progress.title.season, progress.title.episode);

  return {
    text: [episode, progress.finished ? t("watched") : timeLeftOf(progress)]
      .filter(Boolean)
      .join(" · "),
    done: progress.finished ? 1 : progress.position / progress.duration,
  };
}

/** History actions address the exact version represented by this row. */
function historyTitle({ title, version }: Listed) {
  return {
    ...title,
    versions: title.versions.filter((each) => ownedKey(each) === ownedKey(version)),
  };
}

/**
 * An online entry: the row opens its details, and the three dots beside it mark it or take it out
 * of Continue watching. A film is marked in its own subscription's versions, a series as a whole
 * in the version the entry is of.
 */
function HistoryRow({
  row: { entry, title, version },
  marks,
  now,
  source,
  onRemove,
}: {
  row: Listed;
  marks: TitleMarks;
  now: number;
  source: string | null;
  onRemove: () => void;
}) {
  const listed = useInContinueWatching(historyTitle({ entry, title, version }));
  const { text, done } = standingOf(entry);

  // A film's watched state is its mark's, else its play's; a series' needs its episodes, which
  // History doesn't read, so both marks are offered and an unchanged one says so.
  const watched =
    entry.kind === "movie" ? (entry.mark?.watched ?? entry.progress?.finished === true) : null;

  const mark = (next: boolean) =>
    marks.mark(
      entry.kind === "movie"
        ? filmScope(title.versions, version)
        : { kind: "series", series: version },
      next,
      { name: title.title, episodes: entry.kind === "series" },
    );

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-white/8 hover:bg-white/5">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => openDetails({ kind: title.kind, ...version })}
        className="grid min-h-16 w-full min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_7rem] items-center gap-3.5 py-1.5 pl-1 text-left outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative block aspect-[2/3] overflow-hidden rounded-[4px]">
          <Artwork url={title.posterUrl} name={title.title} size="thumb" plain />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[0.9375rem] font-medium">{title.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[kindLabel(title.kind), entry.kind === "movie" ? title.year : null, source, text]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span>{done !== null && <Progress value={done} />}</span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {dayTime(entry.at, now)}
        </span>
      </button>
      <span className="w-8 pr-1">
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("More for {title}", { title: title.title })}
                aria-busy={marks.busy || undefined}
                className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
              />
            }
          >
            <Ellipsis />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
              <Menu.Popup
                className={cn(menuSurface, "w-max min-w-[15rem] max-w-[26rem] text-[0.9375rem]")}
              >
                <MarkItem disabled={marks.busy || watched === true} onPick={() => mark(true)}>
                  <Check className="size-4 flex-none" />
                  {t("Mark watched")}
                </MarkItem>
                <MarkItem disabled={marks.busy || watched === false} onPick={() => mark(false)}>
                  <Circle className="size-4 flex-none" />
                  {t("Mark unwatched")}
                </MarkItem>
                {listed && (
                  <MarkItem onPick={onRemove}>
                    <span className="size-4 flex-none" />
                    {t("Remove from Continue watching")}
                  </MarkItem>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </span>
    </div>
  );
}

/**
 * Recordings and downloads this viewer played on this computer, each with its own place. A
 * failed read says so with Try again, never as nothing played.
 */
function LocalHistory() {
  const now = useNow();
  const places = useRecordingResume();
  const list = useRecordings().data;
  const downloads = useDownloads();

  const recordings = (places.data?.items ?? [])
    .filter(({ progress }) => progress.position > 0)
    .map(({ recording: kept, progress }) => ({
      // As the recordings list has it now, else as this viewer's places last named it.
      recording: list?.find((each) => each.id === kept.id) ?? kept,
      place: progress,
    }))
    .toSorted((a, b) => (b.place.at ?? -Infinity) - (a.place.at ?? -Infinity));

  const copies = (downloads.data?.items ?? []).filter(
    (item): item is Download & { progress: NonNullable<Download["progress"]> } =>
      item.progress !== null && item.progress.position > 0,
  );

  const empty =
    places.isSuccess && downloads.isSuccess && recordings.length === 0 && copies.length === 0;

  return (
    <>
      {recordings.length > 0 && (
        <LocalGroup title={t("Recordings")}>
          {recordings.map(({ recording, place }) => (
            <RecordingRow key={recording.id} recording={recording} place={place} now={now} />
          ))}
        </LocalGroup>
      )}
      {places.isError && (
        <Failure
          text={t("Your place in some recordings couldn't be read.")}
          onRetry={() => void places.refetch()}
        />
      )}
      {copies.length > 0 && (
        <LocalGroup title={t("Downloads")}>
          {copies.map((copy) => (
            <DownloadRow key={copy.id} copy={copy} />
          ))}
        </LocalGroup>
      )}
      {downloads.error && (
        <Failure
          text={describeError(appError(downloads.error))}
          onRetry={() => void downloads.refetch()}
        />
      )}
      {empty && (
        <p className="text-[0.9375rem] text-muted-foreground">
          {t("Nothing played from downloads or recordings yet.")}
        </p>
      )}
    </>
  );
}

function LocalGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="px-1 pt-1.5 pb-2 text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** A local row: a wide picture, the name and its line, and when, where that is known. */
function LocalRow({
  artworkUrl,
  name,
  line,
  when,
  onPlay,
}: {
  artworkUrl: string | null;
  name: string;
  line: string;
  when: string | null;
  onPlay: () => void;
}) {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPlay}
      className="grid min-h-14 w-full min-w-0 grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-white/8 py-1.5 pl-1 pr-1 text-left outline-none hover:bg-white/5 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative block aspect-video overflow-hidden rounded-[4px]">
        <Artwork url={artworkUrl} name={name} size="thumb" className="text-[0.625rem]" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[0.9375rem] font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{line}</span>
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">{when}</span>
    </button>
  );
}

/** A recording, as Continue watching words it, played from this viewer's place. */
function RecordingRow({
  recording,
  place,
  now,
}: {
  recording: Recording;
  place: RecordingPlace;
  now: number;
}) {
  const { line, gone } = recordingLine(recording, place, now);

  return (
    <LocalRow
      artworkUrl={null}
      name={recording.title}
      line={[line, recording.channelName].join(" · ")}
      when={place.at === null ? null : dayTime(place.at, now)}
      onPlay={gone ? () => openView("recordings") : () => playRecording(recording)}
    />
  );
}

/**
 * A downloaded copy this viewer played part or all of. It keeps no time it was played, so it
 * names none; a copy that isn't complete opens Downloads.
 */
function DownloadRow({
  copy,
}: {
  copy: Download & { progress: NonNullable<Download["progress"]> };
}) {
  const { position, duration } = copy.progress;
  const finished = isFinished(position, duration);
  const state = finished ? t("watched") : timeLeftOf({ position, duration, finished });

  const line =
    copy.title.kind === "episode"
      ? [
          [episodeLabel(copy.title.season, copy.title.episode), copy.episodeName]
            .filter(Boolean)
            .join(" "),
          state,
        ]
      : [kindLabel("movie"), copy.year, state];

  return (
    <LocalRow
      artworkUrl={copy.wideUrl ?? copy.posterUrl}
      name={copy.name}
      line={line.filter(Boolean).join(" · ")}
      when={null}
      onPlay={
        copy.status.kind === "complete" ? () => watchOffline(copy) : () => openView("downloads")
      }
    />
  );
}

/** What couldn't be read, with Try again. */
function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p role="alert" className="mt-3 flex flex-wrap items-baseline gap-x-3 text-sm text-destructive">
      {text}
      <button
        onClick={onRetry}
        className="text-foreground underline underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("Try again")}
      </button>
    </p>
  );
}
