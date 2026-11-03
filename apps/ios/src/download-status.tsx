import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { formatBytes, formatNumber, formatPercent } from "@mrstreamer/core/i18n";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ring, transferred } from "./download-controls.tsx";
import { useDownloads } from "./downloads.ts";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/downloads.ts";

/**
 * The queue's most immediate state, derived from the existing owner without another timer: the
 * transfer, else one waiting for playback, else how many are queued, else how many the viewer
 * paused, else how many failed where Retry can still reach their provider, in the interface
 * language. `short` is the label under the glyph; `mark` is what the header's ring shows instead:
 * how far the transfer is (0 while waiting, queued or paused), an unknown total, or retries left.
 */
function downloadStatus({
  items,
}: DownloadList): { short: string; text: string; mark: number | "unknown" | "failed" } | null {
  const transferring = items.find((item) => item.status.kind === "transferring");

  if (transferring?.status.kind === "transferring") {
    const { received, size } = transferring.status;

    const progress =
      size !== null && size > 0
        ? formatPercent(Math.min(1, Math.max(0, Math.floor((received / size) * 100) / 100)))
        : received < 1000
          ? `${received} B`
          : formatBytes(received);

    return {
      short: progress,
      text: t("{name}, {progress} downloaded", { name: transferring.name, progress }),
      mark: transferred(transferring) ?? "unknown",
    };
  }

  const waiting = items.find((item) => item.status.kind === "waiting");

  if (waiting)
    return {
      short: t("Wait"),
      text: waiting.subscription
        ? t("Waiting while {subscription} plays", { subscription: waiting.subscription.name })
        : t("Waiting for playback"),
      mark: 0,
    };
  const queued = items.filter((item) => item.status.kind === "queued").length;

  if (queued)
    return { short: formatNumber(queued), text: t("{count} queued", { count: queued }), mark: 0 };
  const paused = items.filter((item) => item.status.kind === "paused").length;

  if (paused) return { short: t("Paused"), text: t("{count} paused", { count: paused }), mark: 0 };
  const failed = items.filter((item) => item.status.kind === "failed" && item.subscription).length;

  return failed
    ? {
        short: "!",
        text: t("{count} failed, open Downloads to retry", { count: failed }),
        mark: "failed",
      }
    : null;
}

/**
 * The tab header's glyph in its fixed slot, with no text: the circle is the ring of how far the
 * transfer is, dotted while its total is unknown, and a dim track while waiting, queued or
 * paused; retries left add a badge. It changes only when the status does. While a ring shows, the
 * same symbol draws only its arrow (palette: arrow, then circle), so the arrow keeps the idle
 * glyph's size and weight; expo-symbols scales a symbol's strokes with its box.
 */
function HeaderGlyph({ status }: { status: ReturnType<typeof downloadStatus> }) {
  const mark = status?.mark;
  const ring = typeof mark === "number";

  return (
    <>
      {ring ? (
        <View style={styles.over}>
          <Ring done={mark} size={22} stroke={3} />
        </View>
      ) : null}
      <SymbolView
        name={mark === "unknown" ? "arrow.down.circle.dotted" : "arrow.down.circle"}
        size={26}
        weight="semibold"
        {...(ring
          ? { type: "palette", colors: ["#FFFFFF", "transparent"] }
          : { tintColor: "#FFFFFF" })}
      />
      {mark === "failed" ? (
        <View style={styles.badge}>
          <SymbolView
            name="exclamationmark.circle.fill"
            size={11}
            type="palette"
            colors={["#000000", "#FFFFFF"]}
          />
        </View>
      ) : null}
    </>
  );
}

/**
 * One Downloads action on tab headers, Search and Watch. It never starts or changes a transfer.
 * Search and Watch show a short status under the glyph; the tab header passes `ring` for one fixed
 * 44-point slot whose glyph shows the status itself. Either way VoiceOver reads the full status.
 */
export function DownloadStatusButton({
  onPress,
  testID,
  onlyActive = false,
  ring = false,
}: {
  onPress: () => void;
  testID?: string;
  onlyActive?: boolean;
  ring?: boolean;
}) {
  useLocale();
  const status = downloadStatus(useDownloads());

  if (onlyActive && !status) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        status ? t("Downloads, {status}", { status: status.text }) : t("Downloads")
      }
      onPress={onPress}
      style={ring ? styles.slot : styles.button}
      testID={testID}
    >
      {ring ? (
        <HeaderGlyph status={status} />
      ) : (
        <>
          <SymbolView
            name="arrow.down.circle"
            size={status ? 17 : 20}
            tintColor="#FFFFFF"
            weight="semibold"
          />
          {status ? (
            <Text style={styles.progress} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              {status.short}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  progress: { color: "#FFFFFF", fontSize: 11, fontWeight: "600" },
  slot: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  over: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  // A white disc at the ring's top right, edged in the header glass's colour so it parts from it.
  badge: {
    position: "absolute",
    top: 8,
    left: 23,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: "#1C1C1F",
    alignItems: "center",
    justifyContent: "center",
  },
});
