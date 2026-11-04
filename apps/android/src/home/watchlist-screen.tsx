import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatNumber } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import { Artwork, Icon, RowAction, TextButton, typeScale } from "../library/parts.tsx";
import { useLibraryModel } from "../library/runtime.ts";
import { Dialog, FitSheet, RED, Snackbar, TextButton as DialogButton } from "../live/chrome.tsx";
import { Empty } from "../live/ui.tsx";
import { layoutFor } from "../navigation/destinations.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { ProgressDialog } from "./feedback.tsx";
import { viewing, watchlistRows, type SavedTitle, type WatchlistRow } from "./index.ts";
import { Notice, StillTiles, SheetAction, SheetHeader, Tappable } from "./parts.tsx";

const why = {
  loading: "Lists still loading",
  failed: "Lists didn't load",
  "needs-secret": "Password needed in Settings",
  "not-listed": "No longer listed",
} as const;

/** "2021 · Movie" for a title that opens, or why it doesn't. */
function lineOf(row: WatchlistRow) {
  if (row.why) return t(why[row.why]);
  const year = row.title?.year ?? row.saved.year;

  return [year ? formatNumber(year) : null, t(row.saved.kind === "movie" ? "Movie" : "Series")]
    .filter(Boolean)
    .join(" · ");
}

const nameOf = (row: WatchlistRow) => row.title?.title ?? row.saved.name;
const keyOf = (row: WatchlistRow) => `${row.saved.sourceId}:${row.saved.kind}:${row.saved.titleId}`;

function openDetails(row: WatchlistRow) {
  if (!row.title || !row.version) return;
  router.push({
    pathname: "/home/library/details",
    params: {
      kind: row.title.kind,
      title: row.title.key,
      requested: ownedKey(row.version),
    },
  });
}

/** What the Undo strip says: a removal to take back, or an undo that failed. */
type Strip = {
  readonly kind: "removed" | "undo-failed";
  readonly entries: readonly SavedTitle[];
};

/**
 * Every saved title, Newest or A to Z, including those that don't open now: they keep their
 * saved name and say why. Each row's menu offers Details and Remove from Watchlist, and a removal
 * shows Undo. A refused removal changes nothing and says so in a dialog with Try again.
 */
export function WatchlistScreen() {
  const params = useLocalSearchParams<{ sort?: string }>();
  const sort = params.sort === "title" ? "title" : "saved";
  const model = useLibraryModel();
  useStore(model.state);
  const state = useStore(viewing.state);
  const accounts = useStore(sources.state);
  const wide = layoutFor(useWindowDimensions().width) === "rail";
  const inset = wide ? 24 : 16;
  const rows = watchlistRows(state, accounts, model, sort);
  const [menu, setMenu] = useState<WatchlistRow | null>(null);
  const [refused, setRefused] = useState<WatchlistRow | null>(null);
  const [strip, setStrip] = useState<Strip | null>(null);

  const remove = (row: WatchlistRow) => {
    setMenu(null);
    setRefused(null);
    viewing.removeWatchlist(row.saved).then(
      (entries) => (entries.length ? setStrip({ kind: "removed", entries }) : setRefused(row)),
      () => setRefused(row),
    );
  };

  const undo = (entries: readonly SavedTitle[]) => {
    setStrip(null);
    viewing.restoreWatchlist(entries).catch(() => setStrip({ kind: "undo-failed", entries }));
  };

  const order = t(sort === "title" ? "A–Z" : "Newest");

  return (
    <Screen title={t("Watchlist")} pushed>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 48,
          paddingLeft: inset,
          paddingRight: 4,
          borderBottomWidth: 1,
          borderColor: colors.hairline,
        }}
      >
        <Text style={{ ...typeScale.meta, flex: 1 }}>
          {state.kind === "ready" ? t("{count} saved", { count: rows.length }) : ""}
        </Text>
        <Tappable
          label={t("Sort, {order}", { order })}
          onPress={() => router.setParams({ sort: sort === "title" ? "saved" : "title" })}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 48,
            paddingHorizontal: 12,
          }}
        >
          <Icon name="sort" size={20} />
          <Text style={{ ...typeScale.label, fontWeight: "500" }}>{order}</Text>
        </Tappable>
      </View>
      {state.kind === "failed" ? (
        <Notice
          message={t("Couldn't read viewing history. Try again.")}
          actions={<TextButton label={t("Try again")} onPress={() => void viewing.read()} />}
        />
      ) : null}
      {state.kind === "reading" ? (
        <StillTiles inset={inset} height={180} />
      ) : rows.length === 0 && state.kind === "ready" ? (
        <Empty
          title={t("Nothing saved yet.")}
          body={t("Save a movie or series from its details.")}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{
            flexDirection: wide ? "row" : "column",
            flexWrap: "wrap",
            paddingTop: wide ? 8 : 0,
            paddingBottom: 16,
          }}
        >
          {rows.map((row) => {
            const name = nameOf(row);
            const line = lineOf(row);
            const opens = row.why === null;

            return (
              <View
                key={keyOf(row)}
                style={{
                  width: wide ? "50%" : "100%",
                  flexDirection: "row",
                  alignItems: "center",
                  minHeight: 88,
                  paddingRight: 4,
                }}
              >
                <Tappable
                  label={`${name}, ${line}`}
                  onPress={() => (opens ? openDetails(row) : setMenu(row))}
                  actions={[
                    ...(opens
                      ? [{ name: "details", label: t("Details"), run: () => openDetails(row) }]
                      : []),
                    { name: "remove", label: t("Remove from Watchlist"), run: () => remove(row) },
                  ]}
                  style={{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 88,
                    paddingVertical: 8,
                    paddingLeft: inset,
                  }}
                >
                  <Artwork
                    url={opens ? (row.title?.posterUrl ?? null) : null}
                    width={48}
                    height={72}
                    radius={6}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text
                      style={{
                        ...typeScale.row,
                        color: opens ? colors.text : colors.secondary,
                      }}
                    >
                      {name}
                    </Text>
                    <Text
                      style={{
                        ...typeScale.small,
                        color: row.why === "needs-secret" ? RED : colors.secondary,
                      }}
                    >
                      {line}
                    </Text>
                  </View>
                </Tappable>
                <RowAction
                  icon="more-vert"
                  label={t("More options for {name}", { name })}
                  onPress={() => setMenu(row)}
                />
              </View>
            );
          })}
        </ScrollView>
      )}
      {strip ? (
        <Snackbar
          message={t(
            strip.kind === "removed" ? "Removed from Watchlist" : "Couldn't undo. Nothing changed.",
          )}
          action={t(strip.kind === "removed" ? "Undo" : "Try again")}
          onAction={() => undo(strip.entries)}
        />
      ) : null}
      <FitSheet
        visible={menu !== null}
        label={menu ? nameOf(menu) : ""}
        onClose={() => setMenu(null)}
      >
        {menu ? (
          <>
            <SheetHeader
              name={nameOf(menu)}
              url={menu.why === null ? (menu.title?.posterUrl ?? null) : null}
              lines={[lineOf(menu)]}
            />
            <View style={{ paddingTop: 8 }}>
              {menu.why === null ? (
                <SheetAction
                  icon="info-outline"
                  label={t("Details")}
                  onPress={() => {
                    setMenu(null);
                    openDetails(menu);
                  }}
                />
              ) : null}
              <SheetAction
                icon="remove-circle-outline"
                label={t("Remove from Watchlist")}
                danger
                onPress={() => remove(menu)}
              />
            </View>
          </>
        ) : null}
      </FitSheet>
      <Dialog
        visible={refused !== null}
        title={t("Couldn't remove {name}", { name: refused ? nameOf(refused) : "" })}
        body={t("This phone's storage didn't take the change. It's still on your watchlist.")}
        onClose={() => setRefused(null)}
        actions={
          <>
            <DialogButton label={t("Cancel")} onPress={() => setRefused(null)} />
            <DialogButton
              label={t("Try again")}
              strong
              onPress={() => refused && remove(refused)}
            />
          </>
        }
      />
      <ProgressDialog />
    </Screen>
  );
}
