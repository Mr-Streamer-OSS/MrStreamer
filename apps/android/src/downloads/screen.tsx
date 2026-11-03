import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { formatBytes } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import { currentLanguage, onLanguageChange } from "@mrstreamer/mobile/language";
import { Artwork, Icon, Press } from "../library/parts.tsx";
import { Dialog, FitSheet, RED, SheetRow, TextButton } from "../live/chrome.tsx";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import {
  isCopy,
  rowFacts,
  rowStatus,
  sheetChoices,
  trailingChoice,
  type RowChoice,
  type RowStatus,
} from "./presentation.ts";
import { downloads } from "./runtime.ts";
import type { DownloadRow } from "./state.ts";

/** From 840dp the queue and the copies show side by side, as Paper A's tablet frame does. */
const BESIDE = 840;

/** A progress bar's unfilled track. */
const TRACK = "#3A3A3A";

const small = { fontSize: 13, lineHeight: 18 } as const;

const choices = {
  pause: { label: "Pause", icon: "pause" },
  resume: { label: "Resume", icon: "file-download" },
  retry: { label: "Retry", icon: "refresh" },
  play: { label: "Play offline", icon: "play-arrow" },
  delete: { label: "Delete download", icon: "delete" },
  up: { label: "Move up", icon: "arrow-upward" },
  down: { label: "Move down", icon: "arrow-downward" },
  cancel: { label: "Cancel download", icon: "close" },
  remove: { label: "Remove", icon: "delete" },
} as const satisfies Record<RowChoice, { label: Parameters<typeof t>[0]; icon: IconName }>;

/** What shows over the list: the row's sheet, a confirmation, or why something didn't happen. */
type Overlay =
  | { kind: "sheet"; row: DownloadRow }
  | { kind: "confirm"; row: DownloadRow; choice: "cancel" | "delete" }
  | { kind: "refused"; row: DownloadRow; reason: "playing" | "closing" }
  | { kind: "unreadable"; row: DownloadRow };

/**
 * Downloads, pushed over the current destination and from Connect's provider-independent offline
 * route. Paper A: one list, Queue in its order then On this device, side by side on tablets.
 */
export default function DownloadsScreen() {
  useSyncExternalStore(onLanguageChange, currentLanguage);
  const owner = downloads();
  const state = useStore(owner.state);
  const roster = useStore(sources.state);
  const beside = useWindowDimensions().width >= BESIDE;
  const insets = useSafeAreaInsets();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  useEffect(() => owner.start(), [owner]);

  const close = () => setOverlay(null);

  const providerRemoved = (row: DownloadRow) =>
    roster.kind === "ready" && !roster.sources.some((s) => s.id === row.sourceId);

  async function change(row: DownloadRow, action: Parameters<typeof owner.command>[1]) {
    const reason = await owner.command(row, action);

    if (reason) setOverlay({ kind: "refused", row, reason });
  }

  async function play(row: DownloadRow) {
    try {
      await owner.playCopy(row);
      router.push("/offline/play");
    } catch {
      setOverlay({ kind: "unreadable", row });
      void owner.refresh(true);
    }
  }

  function choose(row: DownloadRow, choice: RowChoice) {
    close();

    switch (choice) {
      case "play":
        return void play(row);
      case "cancel":
      case "delete":
        return setOverlay({ kind: "confirm", row, choice });
      default:
        return void change(row, choice);
    }
  }

  const row = (item: DownloadRow) => (
    <Row
      key={item.id}
      row={item}
      status={rowStatus(item, providerRemoved(item))}
      onChoose={(choice) => choose(item, choice)}
      onMore={() => setOverlay({ kind: "sheet", row: item })}
    />
  );

  const queue = state.rows.filter((r) => !isCopy(r));
  const copies = state.rows.filter(isCopy);
  const used = state.rows.reduce((sum, r) => sum + r.bytes, 0);
  const sideBySide = beside && queue.length > 0;
  // The row as it stands now, while its sheet or dialog shows.
  const shown = overlay && (state.rows.find((r) => r.id === overlay.row.id) ?? overlay.row);

  const queueSection =
    queue.length > 0 ? (
      <>
        <Heading label={t("Queue")} />
        {queue.map(row)}
        <Text
          style={{
            ...small,
            color: colors.secondary,
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: 8,
          }}
        >
          {t(
            state.notifications
              ? "Downloads go on in the background with a notification. After a force stop they wait until you open the app."
              : "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.",
          )}
        </Text>
      </>
    ) : null;

  const copiesSection = (
    <>
      <Heading label={t("On this device")} rule={queue.length > 0 && !sideBySide} />
      {copies.map(row)}
      {state.loading && state.rows.length === 0 ? (
        <Line>{t("Checking downloads…")}</Line>
      ) : !state.loading && state.rows.length === 0 && state.error !== "read" ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
          <Text style={{ color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
            {t("Nothing downloaded yet.")}
          </Text>
          <Text style={{ ...small, color: colors.secondary }}>
            {t("Download a movie or an episode from its details.")}
          </Text>
        </View>
      ) : null}
      {/* A failed first read has no sizes to show, not zero. */}
      {state.loading || (state.error === "read" && state.rows.length === 0) ? null : (
        <Line>
          {[
            t("{size} on this device", { size: formatBytes(used) }),
            t("{size} free", { size: formatBytes(state.free) }),
          ].join(" · ")}
        </Line>
      )}
    </>
  );

  const failure = state.error ? (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: 16,
        paddingRight: 4,
      }}
    >
      <Text style={{ ...small, flex: 1, color: RED }}>
        {t(state.error === "read" ? "Couldn't read downloads." : "Couldn't save that change.")}
      </Text>
      <TextButton
        label={t("Try again")}
        strong
        onPress={() => void owner.refresh(state.error === "read")}
      />
    </View>
  ) : null;

  const bottom = { paddingBottom: insets.bottom + 8 };

  return (
    <Screen title={t("Downloads")} pushed>
      {failure}
      {sideBySide ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <ScrollView
            style={{ flex: 1, borderRightWidth: 1, borderColor: colors.hairline }}
            contentContainerStyle={{ ...bottom, paddingHorizontal: 8 }}
          >
            {queueSection}
          </ScrollView>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ ...bottom, paddingLeft: 8, paddingRight: 16 }}
          >
            {copiesSection}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={bottom}>
          {queueSection}
          {copiesSection}
        </ScrollView>
      )}
      {overlay && shown ? (
        <OverlayView
          overlay={{ ...overlay, row: shown }}
          rows={state.rows}
          status={rowStatus(shown, providerRemoved(shown))}
          onClose={close}
          onChoose={(choice) => choose(shown, choice)}
          onConfirm={(choice) => {
            close();
            void change(shown, choice === "delete" ? "remove" : "cancel");
          }}
        />
      ) : null}
    </Screen>
  );
}

/** A section's 12sp caps heading; On this device draws a hairline over itself under the queue. */
function Heading({ label, rule = false }: { label: string; rule?: boolean }) {
  return (
    <View
      style={{
        height: rule ? 48 : 40,
        justifyContent: "flex-end",
        paddingBottom: 8,
        paddingLeft: 16,
        borderTopWidth: rule ? 1 : 0,
        borderColor: colors.hairline,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: colors.secondary,
          fontSize: 12,
          lineHeight: 16,
          fontWeight: "700",
          letterSpacing: 0.72,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** A secondary 13sp line on the list's 16dp margin: the space used and free, checking. */
function Line({ children }: { children: string }) {
  return (
    <Text
      style={{
        ...small,
        color: colors.secondary,
        fontVariant: ["tabular-nums"],
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * One download: its 48x72 poster, title, size, one state line (a still bar over it while bytes
 * arrive) and one 48dp action. A tap or a long-press opens the sheet with the rest.
 */
function Row({
  row,
  status,
  onChoose,
  onMore,
}: {
  row: DownloadRow;
  status: RowStatus;
  onChoose: (choice: RowChoice) => void;
  onMore: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();
  const trailing = trailingChoice(row);
  const facts = rowFacts(row);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[row.title, status.text].filter(Boolean).join(", ")}
      onPress={onMore}
      onLongPress={onMore}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 96,
        paddingVertical: 12,
        paddingLeft: 16,
        paddingRight: 4,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Artwork url={row.artwork ?? null} width={48} height={72} radius={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>
          {row.title}
        </Text>
        {facts ? <Text style={{ ...small, color: colors.secondary }}>{facts}</Text> : null}
        {status.progress === null ? null : (
          <View
            style={{
              height: 4,
              marginTop: 6,
              borderRadius: 2,
              overflow: "hidden",
              backgroundColor: TRACK,
            }}
          >
            <View
              style={{
                width: `${status.progress * 100}%`,
                height: 4,
                backgroundColor: colors.text,
              }}
            />
          </View>
        )}
        {status.text ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{
              ...small,
              marginTop: status.progress === null ? 0 : 4,
              color: status.failed
                ? RED
                : row.state === "complete"
                  ? colors.secondary
                  : colors.text,
              fontVariant: ["tabular-nums"],
            }}
          >
            {status.text}
          </Text>
        ) : null}
      </View>
      {trailing ? (
        <Press
          label={t(choices[trailing].label)}
          onPress={() => onChoose(trailing)}
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={choices[trailing].icon} />
        </Press>
      ) : (
        <View style={{ width: 48 }} />
      )}
    </Pressable>
  );
}

/** The sheet or dialog over the list, each one of Paper A's own. */
function OverlayView({
  overlay,
  rows,
  status,
  onClose,
  onChoose,
  onConfirm,
}: {
  overlay: Overlay;
  rows: readonly DownloadRow[];
  status: RowStatus;
  onClose: () => void;
  onChoose: (choice: RowChoice) => void;
  onConfirm: (choice: "cancel" | "delete") => void;
}) {
  const { row } = overlay;
  const name = row.title;

  const action = (label: string, onPress: () => void, red = false, strong = red): ReactNode => (
    <TextButton
      key={label}
      label={label}
      onPress={onPress}
      strong={strong}
      color={red ? RED : colors.text}
    />
  );

  switch (overlay.kind) {
    case "sheet": {
      const subtitle = status.text ?? (row.total > 0 ? formatBytes(row.total) : null);

      return (
        <FitSheet visible label={name} onClose={onClose}>
          <View style={{ gap: 4, paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12 }}>
            <Text
              accessibilityRole="header"
              style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
            >
              {name}
            </Text>
            {subtitle ? (
              <Text
                style={{
                  fontSize: 14,
                  lineHeight: 18,
                  color: status.failed ? RED : colors.secondary,
                }}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
          {sheetChoices(row, rows).map((choice, index) => (
            <SheetRow
              key={choice}
              icon={choices[choice].icon}
              label={t(choices[choice].label)}
              selected={index === 0}
              onPress={() => onChoose(choice)}
            />
          ))}
        </FitSheet>
      );
    }

    case "confirm":
      return overlay.choice === "cancel" ? (
        <Dialog
          title={t("Cancel downloading {name}?", { name })}
          onClose={onClose}
          actions={
            <View style={{ width: "100%", alignItems: "flex-end" }}>
              {action(t("Cancel download"), () => onConfirm("cancel"), true)}
              {action(t("Keep downloading"), onClose)}
            </View>
          }
        />
      ) : (
        <Dialog
          title={
            row.state === "complete" && row.total > 0
              ? t("Delete the {size} copy of {name}?", { size: formatBytes(row.total), name })
              : t("Delete the copy of {name}?", { name })
          }
          onClose={onClose}
          actions={[
            action(t("Cancel"), onClose),
            action(t("Delete"), () => onConfirm("delete"), true),
          ]}
        />
      );
    case "refused":
      return (
        <Dialog
          title={t("Couldn't remove {name}", { name })}
          body={t(
            overlay.reason === "playing"
              ? "Stop playing this copy first."
              : "The old copy is still closing. Try again.",
          )}
          onClose={onClose}
          actions={action(t("OK"), onClose, false, true)}
        />
      );
    case "unreadable":
      return (
        <Dialog
          title={t("Couldn't play {name}", { name })}
          body={t("The copy on this device can't be read. Delete it and download it again.")}
          onClose={onClose}
          actions={[
            action(t("Delete download"), () => onConfirm("delete"), true),
            action(t("OK"), onClose, false, true),
          ]}
        />
      );
  }
}
