// Recordings: a shelf down the side and what it holds beside it. The side has Find a recording,
// Overview, Recorded, Scheduled and Rules with their counts, then the groups: recordings of one
// programme a rule follows, or of one repeating schedule, by name, and Other for the rest, with
// what the recordings take and the room left at its foot and Storage opening their settings.
// Overview is what records now, what is scheduled, by when it records next, the rules, then what
// was recorded, newest first; a group is its recordings, each named by its day. Find a recording
// looks through every recording's title and channel name.
//   Each recording's row says what it is, its channel and when, a bar of the minutes captured
// against those planned, red where a schedule's start or a gap in between was missed, how far
// this viewer got in it, how it ended and why, and its size. One that records, or waits paused for
// the rest of its time, has Play or Resume and Stop, an ended one Play or Resume and, in its menu,
// Delete. One a schedule missed, or whose file is gone, has no file: it says why, and Remove.
// Where each viewer got to is theirs; while it can't be read, the page says so with Try again,
// and Play starts where main says. A schedule's row says how often it records, how its next time
// stands, and offers Edit, the schedule's controls in a popover, and Cancel schedule in its menu;
// one a rule made has no Edit, as the rule sets its padding, and cancelling it lets that one
// airing go. Rules are each a programme followed on its channels: what it records, its padding and
// priority, Edit in a popover and Stop following in its menu.
// An action that fails says so in place of the reason.
// Narrower windows put the size, or a schedule's repeat, in the row's second line and the outcome
// under the bar. A recording's outcome and why wrap rather than cut off: two lines fit its row,
// and a longer one makes the row taller.
//   With no subscription saved the page stands alone, opened from Connect: what was recorded,
// with nothing scheduled and no way to record, in the bar Downloads shares (DownloadsPage.tsx).
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Play, Repeat2, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import {
  RECORDING_PRIORITY_DEFAULT,
  type Recording,
  type RecordingRule,
  type RecordingStorage,
  type ScheduledRecording,
} from "@mrstreamer/contracts/recordings";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatBytes, formatDate, formatList, formatNumber, t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { WindowBar } from "../../components/WindowBar.tsx";
import { OfflineBar } from "../downloads/DownloadsPage.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import {
  coverage,
  coverageStart,
  formatLimit,
  isLive,
  matchesRecording,
  outcome,
  placeText,
  playRecording,
  recordingGroups,
  resumes,
  useRecordingResume,
  useRecordings,
  useRecordingStorage,
  type RecordingPlace,
} from "./recordings.ts";
import { RulePanel, SchedulePanel } from "./SchedulePanel.tsx";
import {
  basisOfSchedule,
  holdersText,
  repeatText,
  rulesQuery,
  useRules,
  useSchedules,
} from "./schedules.ts";

/** What the page shows beside the side: a list of its own, or one group by its key. */
type Shelf = "overview" | "recorded" | "scheduled" | "rules" | "other" | `group:${string}`;

export function RecordingsPage({ standalone = false }: { standalone?: boolean }) {
  const list = useRecordings();
  const schedules = useSchedules();
  const ruleList = useRules();
  const resume = useRecordingResume();
  const storage = useRecordingStorage().data;
  const [shelf, setShelf] = useState<Shelf>("overview");
  const [query, setQuery] = useState("");
  // Standing alone, what was recorded: nothing records or is scheduled without a subscription.
  const recordings = (list.data ?? []).filter((each) => !standalone || !isLive(each));
  const scheduled = standalone ? [] : (schedules.data ?? []);
  const rules = standalone ? [] : (ruleList.data ?? []);
  const { groups, other } = recordingGroups(recordings, rules, scheduled);
  const searching = query.trim() !== "";
  const group = groups.find((each) => `group:${each.key}` === shelf) ?? null;
  // A group whose last recording went shows Overview again.
  const showing: Shelf = shelf.startsWith("group:") && !group ? "overview" : shelf;

  const shown = searching
    ? recordings.filter((each) => matchesRecording(each, query))
    : group
      ? group.recordings
      : showing === "other"
        ? other
        : showing === "overview" || showing === "recorded"
          ? recordings
          : [];

  const now = showing === "recorded" && !searching ? [] : shown.filter(isLive);
  const recorded = shown.filter((each) => !isLive(each));
  const listsPlans = !searching && showing === "overview";
  const schedulesShown = listsPlans || showing === "scheduled" ? scheduled : [];
  const rulesShown = listsPlans || showing === "rules" ? rules : [];

  // Logos, from the channels as the lists have them now; a channel gone leaves its slot empty.
  const channelRead = useQuery(
    queries.channelsOf([
      ...recordings.map((each) => each.channel),
      ...scheduled.map((each) => each.plan.channel),
      ...rules.flatMap((each) => each.plan.channels),
    ]),
  );

  const channels = channelRead.data ?? [];

  // Undefined while the channels are read, null once they are and it isn't among them.
  const logoOf = (owned: OwnedId) =>
    channelRead.isSuccess
      ? (channels.find((channel) => sameOwned(channel, owned)) ?? null)
      : undefined;

  const count = recordings.length + scheduled.length + rules.length;
  const error = list.error ?? (standalone ? null : (schedules.error ?? ruleList.error));
  // The rules read keeps startup failures until the next start; refetching cannot reload it.
  const restartRequired = !standalone && ruleList.isError;

  const recordedCount = recordings.filter((each) => !isLive(each)).length;

  const show = (id: Shelf) => {
    setQuery("");
    setShelf(id);
  };

  const heading = searching
    ? { title: t("Recordings"), count: shown.length }
    : group
      ? { title: group.name, count: group.recordings.length }
      : showing === "recorded"
        ? { title: t("Recorded"), count: recordedCount }
        : showing === "scheduled"
          ? { title: t("Scheduled"), count: scheduled.length }
          : showing === "rules"
            ? { title: t("Rules"), count: rules.length }
            : showing === "other"
              ? { title: t("Other"), count: other.length }
              : { title: t("Recordings"), count };

  // Standing alone, nothing is scheduled and nothing follows a rule.
  const shelves: { id: Shelf; label: string; count: number | null }[] = [
    { id: "overview", label: t("Overview"), count: null },
    { id: "recorded", label: t("Recorded"), count: recordedCount },
    ...(standalone
      ? []
      : [
          { id: "scheduled" as const, label: t("Scheduled"), count: scheduled.length },
          { id: "rules" as const, label: t("Rules"), count: rules.length },
        ]),
  ];

  const groupShelves = [
    ...groups.map((each) => ({
      id: `group:${each.key}` as const,
      label: each.name,
      count: each.recordings.length,
    })),
    ...(groups.length > 0 && other.length > 0
      ? [{ id: "other" as const, label: t("Other"), count: other.length }]
      : []),
  ];

  // Where this viewer got to, and why that can't be said while the read fails.
  const places = resume.data?.places;

  const placesNote = resume.isError ? (
    <span role="alert" className="flex items-center gap-3 text-xs text-destructive">
      {t("Your place in some recordings couldn't be read.")}
      <button
        onClick={() => void resume.refetch()}
        className="text-foreground underline underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("Try again")}
      </button>
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">{t("Progress is yours")}</span>
  );

  const row = (each: Recording) => (
    <Row
      key={each.id}
      recording={each}
      channel={logoOf(each.channel)}
      place={places?.get(each.id)}
      byDay={group !== null && !searching}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {standalone ? <OfflineBar /> : <WindowBar className="bg-black" />}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("Recordings")}
          className="flex w-50 flex-none flex-col gap-0.5 overflow-y-auto border-r border-border p-3 xl:w-62"
        >
          <label className="mb-2 flex h-9 flex-none items-center gap-2 rounded-full bg-accent px-3.5 text-[0.8125rem] focus-within:ring-2 focus-within:ring-ring">
            <Search aria-hidden className="size-3.5 flex-none text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder={t("Find a recording")}
              aria-label={t("Find a recording")}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          {shelves.map((each) => (
            <ShelfButton
              key={each.id}
              label={each.label}
              count={each.count}
              current={!searching && showing === each.id}
              onClick={() => show(each.id)}
            />
          ))}
          {groupShelves.length > 0 && (
            <span aria-hidden className="my-2.5 h-px flex-none bg-border" />
          )}
          {groupShelves.map((each) => (
            <ShelfButton
              key={each.id}
              label={each.label}
              count={each.count}
              current={!searching && showing === each.id}
              onClick={() => show(each.id)}
            />
          ))}
          <span className="flex-1" />
          {storage && <StorageLine storage={storage} settings={!standalone} />}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pt-[1.375rem] pb-10 xl:px-9">
          <div className="flex items-baseline gap-2.5 pb-3.5">
            <h1 className="truncate text-[1.625rem] leading-8 font-bold tracking-tight">
              {heading.title}
            </h1>
            {heading.count > 0 && (
              <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
                {formatNumber(heading.count)}
              </span>
            )}
            {group?.rule && !searching && (
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {t("Follows {title} on {channels}", {
                  title: group.rule.plan.title,
                  channels: formatList(
                    channels
                      .filter((channel) =>
                        group.rule?.plan.channels.some((owned) => sameOwned(channel, owned)),
                      )
                      .map((channel) => channel.title),
                  ),
                })}
              </span>
            )}
          </div>
          {error ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 pb-2 text-sm">
              <span className="text-destructive">{describeError(appError(error))}</span>
              <Button
                hidden={restartRequired && !list.isError && !schedules.isError}
                size="sm"
                onClick={() => {
                  if (list.error) void list.refetch();

                  if (schedules.error && !standalone) void schedules.refetch();
                }}
              >
                {t("Retry")}
              </Button>
              {restartRequired && (
                <span>{t("Restart Mr. Streamer to reload recording rules.")}</span>
              )}
            </div>
          ) : searching && shown.length === 0 ? (
            <p className="text-[0.9375rem] text-muted-foreground">
              {t("No recordings match {query}.", { query: query.trim() })}
            </p>
          ) : list.data && (standalone || (schedules.data && ruleList.data)) && count === 0 ? (
            <p className="text-[0.9375rem] text-muted-foreground">
              {t("Nothing recorded yet. Record a channel from Live TV.")}
            </p>
          ) : null}
          <Section label={t("Now")} count={now.length} first>
            {now.map(row)}
          </Section>
          <Section
            label={t("Scheduled")}
            count={schedulesShown.length}
            first={now.length === 0}
            bare={showing === "scheduled"}
          >
            {schedulesShown.map((each) => (
              <ScheduleRow key={each.id} schedule={each} channel={logoOf(each.plan.channel)} />
            ))}
          </Section>
          <Section
            label={t("Rules")}
            count={rulesShown.length}
            first={now.length === 0 && schedulesShown.length === 0}
            bare={showing === "rules"}
          >
            {rulesShown.map((each) => (
              <RuleRow
                key={each.id}
                rule={each}
                channels={channels.filter((channel) =>
                  each.plan.channels.some((owned) => sameOwned(channel, owned)),
                )}
              />
            ))}
          </Section>
          {recorded.length === 0 && now.length > 0 && resume.isError && placesNote}
          <Section
            label={t("Recorded")}
            count={recorded.length}
            first={now.length === 0 && schedulesShown.length === 0 && rulesShown.length === 0}
            aside={placesNote}
          >
            {recorded.map(row)}
          </Section>
          {now.length + recorded.length > 0 && (
            <p className="pt-4 text-[0.8125rem] text-muted-foreground">
              {t(
                "Recordings stay until you delete them. Partial ones play, skipping what was missed.",
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One place on the side: its name and how many it holds, marked while it shows. */
function ShelfButton({
  label,
  count,
  current,
  onClick,
}: {
  label: string;
  count: number | null;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-[2.125rem] flex-none items-center gap-2 rounded-lg px-3 text-left text-[0.8125rem] outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring",
        current && "bg-accent hover:bg-accent",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null && count > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">{formatNumber(count)}</span>
      )}
    </button>
  );
}

/**
 * "38.4 GB used · 312 GB free · keeps 5 GB free" and Storage, which opens Recordings in Settings;
 * narrow windows keep the room left alone. Standing alone there is no Settings to open.
 */
function StorageLine({ storage, settings }: { storage: RecordingStorage; settings: boolean }) {
  const used =
    storage.space === null
      ? t("{size} used", { size: formatBytes(storage.used) })
      : t("{size} of {limit} used", {
          size: formatBytes(storage.used),
          limit: formatLimit(storage.space),
        });

  return (
    <span className="flex flex-none flex-wrap items-baseline gap-x-3 px-3 pt-2 text-xs text-muted-foreground tabular-nums">
      <span>
        <span className="hidden xl:inline">{used} · </span>
        {storage.free !== null && t("{size} free", { size: formatBytes(storage.free) })}
      </span>
      {settings && (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ settings: "recordings", searchOpen: false })}
          title={t("keeps {size} free", { size: formatLimit(storage.keepFree) })}
          className="text-foreground underline underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("Storage")}
        </button>
      )}
    </span>
  );
}

/**
 * A titled list of rows; nothing while it has none. `bare` leaves the title to the page's heading,
 * for the assistive name alone. `aside` goes at the title's end.
 */
function Section({
  label,
  count,
  first,
  bare = false,
  aside,
  children,
}: {
  label: string;
  count: number;
  first: boolean;
  bare?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  if (count === 0) return null;

  return (
    <section aria-label={label}>
      <div
        className={cn(
          "flex items-baseline gap-2 pb-1.5",
          bare && "sr-only",
          first ? "pt-1" : "pt-[1.375rem]",
        )}
      >
        <h2 className="text-[0.8125rem] font-semibold">{label}</h2>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

/** A row's logo: the channel's, a dashed slot once the lists no longer have it, else nothing yet. */
function LogoSlot({ channel }: { channel: LiveChannel | null | undefined }) {
  return (
    <span className="flex h-7 w-10 flex-none">
      {channel ? (
        <ChannelLogo channel={channel} className="h-7 w-10 rounded-[5px]" />
      ) : channel === null ? (
        <span
          aria-hidden
          className="size-full rounded-[5px] border border-dashed border-white/15"
        />
      ) : null}
    </span>
  );
}

/**
 * One recording. Wide windows lay it out in columns: logo, title, the bar with its minutes and how
 * far this viewer got, the outcome, size and actions. Narrow ones fold the size into the second
 * line and the outcome, with its minutes, under the bar. In a group, each is named by its day.
 */
function Row({
  recording,
  channel,
  place,
  byDay,
}: {
  recording: Recording;
  channel: LiveChannel | null | undefined;
  place: RecordingPlace | undefined;
  byDay: boolean;
}) {
  const now = useNow();
  const active = isLive(recording);
  // Waiting for the rest of its time: its dot is hollow, as nothing is captured now.
  const paused = recording.status.kind === "paused";
  // Missed by a schedule: no file, so nothing plays and there is no size.
  const missed = recording.status.kind === "missed";
  const missing = recording.status.kind === "missing" || missed;
  const { captured, planned, bar } = coverage(recording, now);
  const minutes = t("{captured} of {planned} min", { captured, planned });
  const where = placeText(recording, place);
  const { word, reason } = outcome(recording, now);
  // Kept by the recording, not the row: a Stop moves it from Now to Recorded, into a new row, before
  // a failure to write that down answers.
  const mutationKey = ["recordings", "action", recording.id];

  const action = useMutation({
    mutationKey,
    mutationFn: (kind: "stop" | "remove") =>
      call(kind === "stop" ? "recordings.stop" : "recordings.remove", { id: recording.id }),
  });

  const last = useMutationState({ filters: { mutationKey }, select: (each) => each.state }).at(-1);

  // A Stop that failed only to write down its end was still taken: once the recording is no longer
  // live, its outcome says so, and that its end isn't saved yet, until the retry saves it.
  const failure =
    last?.status === "error" && (active || last.variables !== "stop")
      ? describeError(appError(last.error))
      : null;

  const size = missing ? null : formatBytes(recording.bytes);
  const start = coverageStart(recording);

  const when = t("{start} to {end}", {
    // From where its coverage bar starts; a group's rows name the day above it.
    start: byDay ? formatDate(start, "time") : dayTime(start, now),
    end: formatDate(recording.stop, "time"),
  });

  const name = byDay ? formatDate(start, "weekdayDay") : recording.title;
  const resuming = resumes(recording, place);

  return (
    <li className="flex min-h-[3.875rem] items-center gap-3.5 border-b border-border py-2 xl:min-h-[3.75rem] xl:gap-4">
      <LogoSlot channel={channel} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 xl:w-64 xl:flex-none">
        <span
          className={cn("truncate text-[0.875rem] font-medium", missing && "text-muted-foreground")}
        >
          {name}
        </span>
        <span className="line-clamp-2 text-xs break-words text-muted-foreground">
          {[recording.channelName, when].join(" · ")}
          {size && <span className="xl:hidden"> · {size}</span>}
        </span>
      </div>
      <div className="flex w-60 flex-none flex-col gap-[0.3125rem] xl:w-[11.25rem]">
        <Coverage captured={captured} planned={planned} bar={bar} faint={missing && !missed} />
        <span className="hidden text-xs text-muted-foreground tabular-nums xl:block">
          {[minutes, where].filter(Boolean).join(" · ")}
        </span>
        <p className="text-xs break-words text-muted-foreground xl:hidden">
          {active && <LiveDot paused={paused} className="mr-1.5 size-1.5" />}
          <span className="mr-1.5 font-semibold text-foreground">{word}</span>
          <span className={cn(failure && "text-destructive")}>
            {failure ?? [minutes, where, reason].filter(Boolean).join(" · ")}
          </span>
        </p>
      </div>
      <p className="hidden min-w-0 flex-1 text-[0.8125rem] break-words text-muted-foreground xl:block">
        {active && <LiveDot paused={paused} className="mr-2 size-[0.4375rem]" />}
        <span className="mr-2 font-semibold text-foreground">{word}</span>
        <span className={cn(failure && "text-destructive")}>{failure ?? reason}</span>
      </p>
      <span className="hidden w-[3.75rem] flex-none text-right text-xs text-muted-foreground tabular-nums xl:block">
        {size}
      </span>
      <div className="flex w-[10.5rem] flex-none justify-end gap-2 xl:w-[11.5rem]">
        {!missing && (
          <Button
            variant="primary"
            size="sm"
            aria-label={
              resuming
                ? t("Resume {title}", { title: recording.title })
                : t("Play {title}", { title: recording.title })
            }
            onClick={() => playRecording(recording)}
          >
            <Play className="size-3 fill-current" />
            {resuming ? t("Resume") : t("Play")}
          </Button>
        )}
        {active ? (
          <Button
            size="sm"
            aria-label={t("Stop recording {title}", { title: recording.title })}
            disabled={action.isPending}
            onClick={() => action.mutate("stop")}
          >
            {t("Stop")}
          </Button>
        ) : missing ? (
          <Button
            size="sm"
            aria-label={t("Remove {title}", { title: recording.title })}
            disabled={action.isPending}
            onClick={() => action.mutate("remove")}
          >
            {t("Remove")}
          </Button>
        ) : (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="icon-sm"
                  aria-label={t("More for {title}", { title: recording.title })}
                  disabled={action.isPending}
                />
              }
            >
              <Ellipsis className="size-4" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
                <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                  <Menu.Item
                    closeOnClick
                    onClick={() => action.mutate("remove")}
                    className={cn(menuItem, "px-2 py-2")}
                  >
                    {t("Delete")}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>
    </li>
  );
}

/** A recording's red dot, hollow while it waits paused. */
function LiveDot({ paused, className }: { paused: boolean; className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block rounded-full align-middle",
        paused ? "ring-[1.5px] ring-destructive ring-inset" : "bg-destructive",
        className,
      )}
    />
  );
}

/**
 * Minutes captured against those planned: captured time light on a faint track, red where `bar`
 * says the start and each gap since were missed, as they were rather than rounded to minutes, the
 * spans a hairline apart. A gap is at least a few pixels, so one of seconds in a long recording
 * still shows. These are times on the clock: where this viewer got to is said beside it, never
 * drawn on it.
 */
function Coverage({
  captured,
  planned,
  bar,
  faint,
}: {
  captured: number;
  planned: number;
  bar: ReturnType<typeof coverage>["bar"];
  faint: boolean;
}) {
  const spans: { kind: "missed" | "captured" | "ahead"; width: number }[] = [
    { kind: "missed", width: bar.late },
  ];

  let at = bar.late;

  for (const gap of bar.gaps) {
    spans.push({ kind: "captured", width: gap.from - at });
    spans.push({ kind: "missed", width: gap.to - Math.max(at, gap.from) });
    at = Math.max(at, gap.to);
  }

  spans.push({ kind: "captured", width: bar.reached - at });
  spans.push({ kind: "ahead", width: 1 - bar.reached });

  return (
    <span
      role="meter"
      aria-label={t("{captured} of {planned} min", { captured, planned })}
      aria-valuemin={0}
      aria-valuemax={planned}
      aria-valuenow={captured}
      className="flex h-1 gap-0.5"
    >
      {spans.map(
        (span, index) =>
          span.width > 0 && (
            <span
              key={index}
              className={cn(
                "h-full rounded-[2px]",
                faint
                  ? "bg-white/8"
                  : span.kind === "missed"
                    ? "min-w-[3px] bg-destructive"
                    : span.kind === "captured"
                      ? "bg-white/35"
                      : "bg-white/8",
              )}
              style={{ flexGrow: span.width, flexBasis: 0 }}
            />
          ),
      )}
    </span>
  );
}

/**
 * One schedule, in the recordings' lanes: logo, title with its channel and padded times, how often
 * it records where the bar is, how its next time stands, and Edit with its menu.
 */
function ScheduleRow({
  schedule,
  channel,
}: {
  schedule: ScheduledRecording;
  channel: LiveChannel | null | undefined;
}) {
  const now = useNow();
  const { plan, next, status } = schedule;
  const [editing, setEditing] = useState(false);

  const cancel = useMutation({
    mutationKey: ["schedules", "cancel", schedule.id],
    mutationFn: () => call("recordings.cancel", { id: schedule.id }),
  });

  const failure = cancel.error ? describeError(appError(cancel.error)) : null;
  const padded = plan.padding.before > 0 || plan.padding.after > 0;

  const times =
    next &&
    t(padded ? "{start} to {end}, with padding" : "{start} to {end}", {
      start: formatDate(next.start, "time"),
      end: formatDate(next.stop, "time"),
    });

  // A rule's airing: its padding is the rule's, so it is changed there.
  const occurrence = schedule.rule !== undefined;
  const repeat = occurrence ? t("From a rule") : repeatText(plan);
  const { word, reason } = standing(schedule, now);
  const recording = status.kind === "recording";

  const line = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 flex-none rounded-full xl:size-2",
          recording ? "bg-destructive" : "ring-[1.5px] ring-destructive ring-inset",
        )}
      />
      {word && <span className="flex-none font-semibold text-foreground">{word}</span>}
      <span
        title={failure ?? reason}
        className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}
      >
        {failure ?? reason}
      </span>
    </>
  );

  return (
    <li className="flex h-[3.875rem] items-center gap-3.5 border-b border-border xl:h-[3.75rem] xl:gap-4">
      <LogoSlot channel={channel} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 xl:w-64 xl:flex-none">
        <span className="truncate text-[0.875rem] font-medium">{plan.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {schedule.channelName}
          <span className="xl:hidden"> · {repeat}</span>
          {times && ` · ${times}`}
        </span>
      </div>
      <div className="flex w-60 flex-none flex-col gap-1.5 xl:w-[11.25rem]">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground xl:flex">
          {plan.kind === "slot" && <Repeat2 aria-hidden className="size-3.5 flex-none" />}
          {repeat}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs xl:hidden">{line}</span>
      </div>
      <span className="hidden min-w-0 flex-1 items-center gap-2 text-[0.8125rem] xl:flex">
        {line}
      </span>
      <span className="hidden w-[3.75rem] flex-none xl:block" />
      <div className="flex w-[10.5rem] flex-none justify-end gap-2 xl:w-[11.5rem]">
        {!occurrence && (
          <Popover.Root open={editing} onOpenChange={setEditing}>
            <Popover.Trigger
              render={
                <Button
                  size="sm"
                  aria-label={t("Edit {title}", { title: plan.title })}
                  className="px-3 data-popup-open:bg-white/16 data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-inset"
                >
                  {t("Edit")}
                </Button>
              }
            />
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
                <Popover.Popup
                  aria-label={t("Schedule {title}", { title: plan.title })}
                  className={cn(
                    menuSurface,
                    "flex w-[42rem] max-w-[calc(100vw-2rem)] flex-col gap-3.5 p-4 transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="truncate text-[0.9375rem] font-semibold">{plan.title}</h2>
                    <p className="truncate text-[0.8125rem] text-muted-foreground">
                      {schedule.channelName}
                    </p>
                  </div>
                  <SchedulePanel
                    basis={basisOfSchedule(schedule)}
                    channelName={schedule.channelName}
                    schedule={schedule}
                    onDone={() => setEditing(false)}
                  />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="icon-sm"
                aria-label={t("More for {title}", { title: plan.title })}
                disabled={cancel.isPending}
              />
            }
          >
            <Ellipsis className="size-4" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
              <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                <Menu.Item
                  closeOnClick
                  onClick={() => cancel.mutate()}
                  className={cn(menuItem, "px-2 py-2")}
                >
                  {t("Cancel schedule")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </li>
  );
}

/**
 * One rule, in the recordings' lanes: the first channel's logo, the title with its channels,
 * padding and priority, what it records where the bar is, then Edit with its menu, which has Stop
 * following.
 */
function RuleRow({ rule, channels }: { rule: RecordingRule; channels: readonly LiveChannel[] }) {
  const client = useQueryClient();
  const { plan } = rule;
  const [editing, setEditing] = useState(false);

  const stop = useMutation({
    mutationKey: ["rules", "cancel", rule.id],
    mutationFn: () => call("recordings.cancelRule", { id: rule.id }),
    onSuccess: () =>
      client.setQueryData(rulesQuery().queryKey, (list) =>
        list?.filter((each) => each.id !== rule.id),
      ),
  });

  const failure = stop.error ? describeError(appError(stop.error)) : rule.error;

  const padding = [
    t("{minutes} min early", { minutes: plan.padding.before }),
    t("{minutes} min late", { minutes: plan.padding.after }),
    t("Priority {priority}", { priority: plan.priority ?? RECORDING_PRIORITY_DEFAULT }),
  ].join(", ");

  const mode = plan.mode === "new-only" ? t("New episodes only") : t("Every match");
  const first = channels[0];

  return (
    <li className="flex h-[3.875rem] items-center gap-3.5 border-b border-border xl:h-[3.75rem] xl:gap-4">
      <LogoSlot channel={first} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 xl:w-64 xl:flex-none">
        <span className="truncate text-[0.875rem] font-medium">{plan.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {formatList(channels.map((channel) => channel.title))}
          <span className="xl:hidden"> · {mode}</span>
        </span>
      </div>
      <div className="flex w-60 flex-none flex-col gap-1.5 xl:w-[11.25rem]">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground xl:flex">
          <Repeat2 aria-hidden className="size-3.5 flex-none" />
          {mode}
        </span>
        <span
          className={cn(
            "truncate text-xs xl:hidden",
            failure ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failure ?? padding}
        </span>
      </div>
      <span
        className={cn(
          "hidden min-w-0 flex-1 truncate text-[0.8125rem] xl:block",
          failure ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {failure ?? padding}
      </span>
      <span className="hidden w-[3.75rem] flex-none xl:block" />
      <div className="flex w-[10.5rem] flex-none justify-end gap-2 xl:w-[11.5rem]">
        <Popover.Root open={editing} onOpenChange={setEditing}>
          <Popover.Trigger
            render={
              <Button
                size="sm"
                aria-label={t("Edit {title}", { title: plan.title })}
                className="px-3 data-popup-open:bg-white/16 data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-inset"
              >
                {t("Edit")}
              </Button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
              <Popover.Popup
                aria-label={t("Follow {title}", { title: plan.title })}
                className={cn(
                  menuSurface,
                  "flex max-h-[var(--available-height)] w-[60rem] max-w-[calc(100vw-2rem)] flex-col gap-3.5 overflow-y-auto p-4 transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
                )}
              >
                <h2 className="truncate text-[0.9375rem] font-semibold">
                  {t("Follow {title}", { title: plan.title })}
                </h2>
                <RulePanel rule={rule} onDone={() => setEditing(false)} />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="icon-sm"
                aria-label={t("More for {title}", { title: plan.title })}
                disabled={stop.isPending}
              />
            }
          >
            <Ellipsis className="size-4" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
              <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                <Menu.Item
                  closeOnClick
                  onClick={() => stop.mutate()}
                  className={cn(menuItem, "px-2 py-2")}
                >
                  {t("Stop following")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </li>
  );
}

/** How a schedule's next time stands: when, or a word for what it does then, and why. */
function standing(
  { next, status }: ScheduledRecording,
  now: number,
): { word: string; reason: string } {
  if (!next) return { word: "", reason: t("It has no time to come.") };
  const when = dayTime(next.start, now);

  switch (status.kind) {
    case "planned":
      return { word: when, reason: t("A connection is free then.") };
    case "conflict":
      return {
        word: when,
        reason: t("Every connection is in use then, by {holders}.", {
          holders: holdersText(status.holders),
        }),
      };
    case "waiting":
      return {
        word: t("Waiting"),
        reason: t("Every connection is in use, by {holders}.", {
          holders: holdersText(status.holders),
        }),
      };
    case "retrying":
      return {
        word: t("Trying again"),
        reason:
          status.why === "stream"
            ? t("The stream couldn't be opened.")
            : t("It couldn't be written to this computer."),
      };
    case "recording":
      return {
        word: t("Recording"),
        reason: t("until {time}", { time: formatDate(next.stop, "time") }),
      };
    case "changed":
      return {
        word: when,
        reason: t("The guide lists {title} at that time now.", { title: status.title }),
      };
    case "gone":
      return { word: when, reason: t("Its programme or channel is no longer listed.") };
  }
}
