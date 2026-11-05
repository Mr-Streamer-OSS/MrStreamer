import { providerRequired } from "../preview/session.ts";
import { useIsFocused, useSegments } from "expo-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { SeriesDetails, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { Icon } from "../library/parts.tsx";
import type { LibrarySource } from "../library/model.ts";
import { Dialog, FitSheet, SheetRow, TextButton } from "../live/chrome.tsx";
import { useOpenShared } from "../navigation/open.ts";
import { store, useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { Body, BODY, ReplaceDialog } from "./replace-dialog.tsx";
import {
  seriesBusy,
  seriesFiles,
  seriesOwner,
  type SeriesController,
  type SeriesFile,
  type SeriesOwner,
  type SeriesPlan,
  type SeriesResult,
} from "./series.ts";

// A series' bulk downloads on Details, Paper A's offline series page: a season's row under the
// tabs ("3 of 6 saved or queued", Download remaining) and the whole series' after the episodes,
// or beside the details on a tablet (Review series download). Each asks first in a bottom sheet
// with iOS's exact counts, frozen as it opens, then adds one episode at a time while its row says
// "Adding 5 of 8" with Cancel remaining. How it went is one dialog in iOS's sentences. Leaving the
// series stops what isn't queued yet, quietly. Each shows only while Downloads runs.

/** What Details tells a bulk download row. */
export interface SeriesDownloadProps {
  readonly details: SeriesDetails;
  readonly version: TitleVersion;
  readonly containers: ReadonlyMap<string, string>;
  /** A season's row under the tabs; without one, the whole series' row. */
  readonly season?: number | undefined;
  /** A season's tab label: "Season 1", "Specials". */
  readonly seasonLabel: (season: number) => string;
  /** The version as its menu names it: "Full HD · English sound, Nederlands subtitles". */
  readonly versionLabel: string;
  readonly sourceLabel: string;
  /** The provider's reader now; another one means it signed in anew or was removed. */
  readonly reader: () => LibrarySource["reader"];
  /** Beside the details on a tablet, rather than a list row with its hairline. */
  readonly inline?: boolean;
}

/** How the last run went, until its dialog is answered. */
interface Outcome {
  readonly label: string;
  readonly result: SeriesResult;
  readonly retry: (() => void) | undefined;
}

const outcome = store<Outcome | null>(null);

const episodes = (count: number) => t("{count} episodes", { count });

/** Why a bulk download can't start, when another series is still adding episodes. */
const anotherRunning = () =>
  seriesBusy.get() ? t("Episodes of another download are still being added.") : null;

/** "5 queued. Cancelled before 3 episodes.", in iOS's order. */
function seriesSummary(result: SeriesResult): string {
  const before = episodes(result.unqueued);

  const said = [
    result.added > 0 ? t("{count} queued.", { count: result.added }) : null,
    result.retried > 0 ? t("{count} retried.", { count: result.retried }) : null,
    result.replaced > 0 ? t("{count} replaced.", { count: result.replaced }) : null,
    result.skipped > 0
      ? t("{count} changed meanwhile and stayed as they were.", { count: result.skipped })
      : null,
    result.failed.length > 0 ? t("{count} failed.", { count: result.failed.length }) : null,
    result.stopped === "cancelled" ? t("Cancelled before {episodes}.", { episodes: before }) : null,
    result.stopped === "login"
      ? t("Stopped before {episodes}: the provider signed in anew or was removed.", {
          episodes: before,
        })
      : null,
    result.stopped === "version"
      ? t("Stopped before {episodes}: a version was chosen meanwhile.", { episodes: before })
      : null,
  ].filter(Boolean);

  return said.length > 0 ? said.join(" ") : t("Nothing was added.");
}

/** A plan reviewed in the sheet, with what was true as it opened. */
interface Review {
  readonly plan: SeriesPlan;
  readonly reader: LibrarySource["reader"];
  readonly version: string;
}

const Scope = createContext<{
  seasons: Map<number, SeriesController>;
  series: SeriesController;
} | null>(null);

/** Controllers belong to Details, so moving rows for tablet layout never ends a run. */
export function SeriesDownloadScope({ children }: { children: ReactNode }) {
  const owner = useStore(seriesOwner);

  return owner ? <DownloadScope owner={owner}>{children}</DownloadScope> : children;
}

function DownloadScope({ owner, children }: { owner: SeriesOwner; children: ReactNode }) {
  const [controllers] = useState(() => ({
    seasons: new Map<number, SeriesController>(),
    series: owner.series(),
  }));

  const focused = useIsFocused();
  const segments: readonly string[] = useSegments();
  const destination = useRef(segments[1]);

  const allowed =
    focused ||
    segments.at(-1) === "watch" ||
    (segments[0] === "offline" && segments.at(-1) === "play") ||
    (segments[1] === destination.current && segments.at(-1) === "downloads");

  useEffect(() => {
    if (!allowed) {
      for (const controller of controllers.seasons.values()) void controller.close();
      void controllers.series.close();
    }
  }, [allowed, controllers]);
  useEffect(
    () => () => {
      for (const controller of controllers.seasons.values()) void controller.close();
      void controllers.series.close();
    },
    [controllers],
  );

  return <Scope.Provider value={controllers}>{children}</Scope.Provider>;
}

/** One bulk download row of `details` for `season`, or for the whole series without one. */
export function SeriesDownloadRow(props: SeriesDownloadProps) {
  const owner = useStore(seriesOwner);

  return owner ? <BulkRow {...props} owner={owner} /> : null;
}

/** Downloads' dialogs over Details: how a bulk download went, and replacing a copy. */
export function SeriesDialogs() {
  const owner = useStore(seriesOwner);

  return owner ? (
    <>
      <SeriesOutcome />
      <ReplaceDialog owner={owner} />
    </>
  ) : null;
}

function BulkRow({
  owner,
  details,
  version,
  containers,
  season,
  seasonLabel,
  versionLabel,
  sourceLabel,
  reader,
  inline = false,
}: SeriesDownloadProps & { owner: SeriesOwner }) {
  const scoped = useContext(Scope);
  const [fallback] = useState(() => owner.series());
  let controller = fallback;

  if (scoped) {
    if (season === undefined) controller = scoped.series;
    else {
      const kept = scoped.seasons.get(season);
      controller = kept ?? fallback;

      if (!kept) scoped.seasons.set(season, controller);
    }
  }

  const run = useStore(controller.state);
  const busy = useStore(seriesBusy);
  const rows = useStore(owner.state).rows;
  const openShared = useOpenShared();
  const [review, setReview] = useState<Review | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The version shown now, which a run started here must still show for each admission.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  const shown = useRef(ownedKey(version));
  shown.current = ownedKey(version);
  useEffect(
    () => () => {
      if (!scoped) void controller.close();
    },
    [controller, scoped],
  );

  const label = season === undefined ? details.title.title : seasonLabel(season);
  let files: SeriesFile[];

  try {
    files = seriesFiles(
      details,
      version,
      containers,
      sourceLabel,
      season === undefined ? { kind: "series" } : { kind: "season", season },
    );
  } catch {
    // An episode without a container can't be named exactly, so there is no plan to offer.
    return null;
  }

  const held = files.filter((file) =>
    rows.some((row) => row.key === file.key && row.state !== "failed"),
  ).length;

  async function ask(only: readonly SeriesFile[] = files) {
    if (providerRequired("download", version.subscriptionId)) return;
    const asked = { reader: reader(), version: ownedKey(version) };

    try {
      setReview({ plan: await controller.plan(only), ...asked });
    } catch {
      setRefusal(anotherRunning() ?? t("Couldn't read downloads."));
    }
  }

  function begin(reviewed: Review, replace: boolean) {
    setReview(null);

    const stands = () =>
      reader() !== reviewed.reader
        ? ("login" as const)
        : shown.current !== reviewed.version
          ? ("version" as const)
          : null;

    void controller
      .start(reviewed.plan, replace, stands)
      .then((result) => {
        if (!result) {
          setRefusal(anotherRunning() ?? t("The version or its provider changed. Try again."));

          return;
        }

        // Leaving the series stops it quietly; the row's counts say the rest on return.
        if (result.stopped === "left") return;
        outcome.set({
          label,
          result,
          retry:
            mounted.current && result.failed.length > 0 && result.stopped !== "version"
              ? () => void ask(result.failed)
              : undefined,
        });
      })
      .catch(() => setRefusal(t("Couldn't read downloads.")));
  }

  function dismiss() {
    setReview(null);
    void controller.close();
  }

  const going = run?.running ? run : null;

  const count = going
    ? t("Adding {done} of {total}", {
        done: Math.min(going.done + 1, going.total),
        total: going.total,
      })
    : [
        season === undefined ? t("Whole series") : null,
        held > 0
          ? t("{held} of {total} saved or queued", { held, total: files.length })
          : episodes(files.length),
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 64,
        ...(inline
          ? { paddingTop: 4 }
          : {
              paddingVertical: 8,
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderColor: colors.hairline,
            }),
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18 }}>{count}</Text>
        {going ? (
          <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }}>
            {t("Stops if you leave this series")}
          </Text>
        ) : null}
      </View>
      {going ? (
        <OutlinedButton
          icon="close"
          label={t("Cancel remaining")}
          onPress={() => controller.stop()}
        />
      ) : (
        <OutlinedButton
          icon="file-download"
          label={t(season === undefined ? "Review series download" : "Download remaining")}
          disabled={busy || files.length === 0}
          onPress={() => void ask()}
        />
      )}
      {review ? (
        <ReviewSheet
          review={review}
          label={label}
          series={season === undefined}
          subtitle={
            season === undefined ? versionLabel : `${details.title.title} · ${versionLabel}`
          }
          seasons={details.seasons.map((s) => s.number)}
          seasonLabel={seasonLabel}
          onChoose={(replace) => begin(review, replace)}
          onOpenDownloads={() => {
            dismiss();
            openShared("downloads");
          }}
          onClose={dismiss}
        />
      ) : null}
      {refusal ? (
        <Dialog
          title={t("Couldn't download {name}", { name: label })}
          onClose={() => setRefusal(null)}
          actions={<TextButton label={t("OK")} strong onPress={() => setRefusal(null)} />}
        >
          <Body>{refusal}</Body>
        </Dialog>
      ) : null}
    </View>
  );
}

/**
 * Paper A's sheet before a bulk download, 640dp wide at most: what it downloads and in which
 * version, the exact counts as the sheet opened (each season's for the whole series, Specials
 * included), then one choice per outcome and Cancel.
 */
function ReviewSheet({
  review: { plan },
  label,
  series,
  subtitle,
  seasons,
  seasonLabel,
  onChoose,
  onOpenDownloads,
  onClose,
}: {
  review: Review;
  label: string;
  series: boolean;
  subtitle: string;
  /** Season numbers in the tabs' order. */
  seasons: readonly number[];
  seasonLabel: (season: number) => string;
  onChoose: (replace: boolean) => void;
  onOpenDownloads: () => void;
  onClose: () => void;
}) {
  const total = plan.steps.length;
  const remaining = plan.add + plan.retry;

  const breakdown = seasons
    .map((number) => ({
      number,
      count: plan.steps.filter((step) => step.file.season === number).length,
    }))
    .filter((season) => season.count > 0);

  const notes = [
    plan.held > 0 ? t("{count} already saved or queued.", { count: plan.held }) : null,
    plan.retry > 0 ? t("{count} failed and will be retried.", { count: plan.retry }) : null,
    plan.missing > 0 ? t("{count} saved files are missing.", { count: plan.missing }) : null,
    plan.changed > 0
      ? t("{count} saved files changed. Replace them in Downloads.", { count: plan.changed })
      : null,
  ].filter((note) => note !== null);

  const line = { color: BODY, fontSize: 14, lineHeight: 18 } as const;

  return (
    <FitSheet visible label={label} onClose={onClose} maxWidth={640}>
      <View style={{ gap: 4, paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
        >
          {t(series ? "Download all of {name}?" : "Download {name}?", { name: label })}
        </Text>
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{subtitle}</Text>
      </View>
      <View style={{ gap: 6, paddingHorizontal: 24, paddingTop: 4, paddingBottom: 16 }}>
        <Text style={{ ...line, color: colors.text }}>
          {plan.held === total
            ? t("All {count} episodes are saved or queued.", { count: total })
            : series && breakdown.length > 1
              ? t("{episodes} in {seasons} seasons.", {
                  episodes: episodes(total),
                  seasons: breakdown.length,
                })
              : episodes(total)}
        </Text>
        {series && breakdown.length > 1 ? (
          <View style={{ gap: 2, paddingBottom: 6 }}>
            {breakdown.map((season) => (
              <View
                key={season.number}
                style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
              >
                <Text style={{ ...line, lineHeight: 20 }}>{seasonLabel(season.number)}</Text>
                <Text style={{ ...line, lineHeight: 20 }}>{episodes(season.count)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {notes.length > 0 ? (
          <View style={{ gap: 4, paddingLeft: 12, borderLeftWidth: 2, borderColor: "#2A2A2A" }}>
            {notes.map((note) => (
              <Text key={note} style={line}>
                {note}
              </Text>
            ))}
          </View>
        ) : null}
        <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, paddingTop: 6 }}>
          {`${t("Size unavailable.")} ${t("Uses the selected version.")}`}
        </Text>
      </View>
      <View style={{ paddingTop: 8, borderTopWidth: 1, borderColor: colors.hairline }}>
        {remaining > 0 ? (
          <SheetRow
            icon="file-download"
            label={t("Download {episodes}", { episodes: episodes(remaining) })}
            selected
            onPress={() => onChoose(false)}
          />
        ) : null}
        {plan.missing > 0 ? (
          <SheetRow
            icon="autorenew"
            label={
              remaining > 0
                ? t("Download {remaining} and replace {count} missing", {
                    remaining,
                    count: plan.missing,
                  })
                : t("Replace {count} missing files", { count: plan.missing })
            }
            selected
            onPress={() => onChoose(true)}
          />
        ) : null}
        {remaining + plan.missing === 0 ? (
          <SheetRow
            icon="download-done"
            label={t("Open Downloads")}
            selected
            onPress={onOpenDownloads}
          />
        ) : null}
        <SheetRow icon="close" label={t("Cancel")} onPress={onClose} />
      </View>
    </FitSheet>
  );
}

/**
 * How the last bulk download went, over the Details screen that shows when it ends: Retry failed
 * when something failed, Open Downloads and OK.
 */
function SeriesOutcome() {
  const shown = useStore(outcome);
  const focused = useIsFocused();
  const openShared = useOpenShared();

  if (!shown || !focused) return null;
  const close = () => outcome.set(null);

  return (
    <Dialog
      title={shown.label}
      onClose={close}
      actions={
        <View style={{ width: "100%", alignItems: "flex-end" }}>
          {shown.retry ? (
            <TextButton
              label={t("Retry failed")}
              onPress={() => {
                close();
                shown.retry?.();
              }}
            />
          ) : null}
          <TextButton
            label={t("Open Downloads")}
            onPress={() => {
              close();
              openShared("downloads");
            }}
          />
          <TextButton label={t("OK")} strong onPress={close} />
        </View>
      }
    >
      <Body>{seriesSummary(shown.result)}</Body>
    </Dialog>
  );
}

/** Paper A's 40dp outlined button with a 20dp icon, in a 48dp target; dimmed while disabled. */
function OutlinedButton({
  icon,
  label,
  disabled = false,
  onPress,
}: {
  icon: "close" | "file-download";
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...handlers}
      hitSlop={4}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 1,
        gap: 8,
        minHeight: 40,
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#3A3A3A",
        opacity: disabled ? 0.38 : 1,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Icon name={icon} size={20} />
      <Text style={{ color: colors.text, fontSize: 15, lineHeight: 18, fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}
