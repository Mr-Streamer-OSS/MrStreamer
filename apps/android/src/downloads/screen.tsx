import { useEffect } from "react";
import { Alert, Image, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { useLocale } from "../library/catalogue.ts";
import { downloads } from "./runtime.ts";
import type { DownloadRow, Action } from "./state.ts";
import { t } from "./copy.ts";

/** Shared by all destination stacks and the provider-independent offline route. */
export default function DownloadsScreen() {
  useLocale();
  const owner = downloads();
  const state = useStore(owner.state);
  const wide = useWindowDimensions().width >= 840;
  useEffect(() => owner.start(), [owner]);

  const confirm = (label: string, perform: () => void) =>
    Alert.alert(label, t("Remove this download?"), [
      { text: t("Cancel"), style: "cancel" },
      { text: label, style: "destructive", onPress: perform },
    ]);

  async function change(row: DownloadRow, action: Action) {
    const refusal = await owner.command(row, action);

    if (refusal)
      Alert.alert(
        t(
          refusal === "playing"
            ? "Stop playing this copy first."
            : "The old copy is still closing. Try again.",
        ),
      );
  }

  function act(row: DownloadRow, action: Action) {
    if (action === "remove" || action === "cancel") {
      confirm(
        t(action === "remove" ? "Delete download" : "Cancel download"),
        () => void change(row, action),
      );
    } else void change(row, action);
  }

  async function play(row: DownloadRow) {
    try {
      await owner.playCopy(row);
      router.push("/offline/play");
    } catch {
      Alert.alert(t("This copy can’t be read."), undefined, [
        { text: t("Delete download"), style: "destructive", onPress: () => act(row, "remove") },
        { text: t("OK"), style: "cancel" },
      ]);
      void owner.refresh(true);
    }
  }

  function actions(row: DownloadRow) {
    const options: { text: string; onPress: () => void; style?: "destructive" | "cancel" }[] = [];

    for (const action of row.state === "complete"
      ? (["remove"] as const)
      : row.state === "failed"
        ? (["retry", "remove"] as const)
        : ([row.state === "paused" ? "resume" : "pause", "up", "down", "cancel"] as const)) {
      const label = {
        remove: "Delete download",
        retry: "Retry",
        resume: "Resume",
        pause: "Pause",
        up: "Move up",
        down: "Move down",
        cancel: "Cancel download",
      } as const;

      options.push({ text: t(label[action]), onPress: () => act(row, action) });
    }

    options.push({ text: t("OK"), style: "cancel", onPress: () => {} });
    Alert.alert(row.title, undefined, options);
  }

  function line(row: DownloadRow) {
    if (row.blocked && row.state !== "complete")
      return t("Waiting while {source} plays", { source: row.sourceLabel });

    if (row.state === "complete") return t("Downloaded");

    if (row.state === "failed")
      return t(
        row.reason === "credentials"
          ? "The provider login changed or is unavailable."
          : row.reason === "disk"
            ? "Not enough free space."
            : row.reason === "missing"
              ? "The file is missing."
              : "Download interrupted.",
      );

    if (row.reason === "changed") return t("Started again because the provider’s file changed.");

    if (row.reason === "continued") return t("Continued after reopening.");

    return t(
      row.state === "running" ? "Downloading" : row.state === "paused" ? "Paused" : "Queued",
    );
  }

  function rowView(row: DownloadRow) {
    const label =
      row.state === "complete"
        ? "Play offline"
        : row.state === "failed"
          ? "Retry"
          : row.state === "paused"
            ? "Resume"
            : "Pause";

    return (
      <Pressable
        key={row.id}
        onLongPress={() => actions(row)}
        style={{ flexDirection: "row", gap: 12, paddingVertical: 12, alignItems: "center" }}
      >
        {row.artwork ? (
          <Image source={{ uri: row.artwork }} style={{ width: 48, height: 72 }} />
        ) : (
          <View style={{ width: 48, height: 72, backgroundColor: "#171717" }} />
        )}
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: "white", fontSize: 16 }}>{row.title}</Text>
          <Text style={{ color: "#aaa" }}>
            {row.sourceLabel} · {row.container}
          </Text>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: row.state === "failed" ? "#ff6666" : "white" }}
          >
            {line(row)}
          </Text>
          <Text style={{ color: "#aaa" }}>
            {Math.floor(row.bytes / 1048576)} / {Math.floor(row.total / 1048576)} MB
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(label)}
          onPress={() =>
            row.state === "complete"
              ? void play(row)
              : act(
                  row,
                  row.state === "failed" ? "retry" : row.state === "paused" ? "resume" : "pause",
                )
          }
          style={{ minWidth: 48, minHeight: 48, justifyContent: "center" }}
        >
          <Text style={{ color: "white" }}>{t(label)}</Text>
        </Pressable>
      </Pressable>
    );
  }

  return (
    <Screen title={t("Downloads")} pushed>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {state.loading ? <Text style={{ color: "white" }}>{t("Checking downloads…")}</Text> : null}
        {state.error ? (
          <Pressable onPress={() => void owner.refresh(true)}>
            <Text style={{ color: "#ff6666" }}>
              {t(
                state.error === "read"
                  ? "Could not read downloads. Try again."
                  : "Could not save this change. Try again.",
              )}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flexDirection: wide ? "row" : "column", gap: 24 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "white", fontSize: 20 }}>{t("Queue")}</Text>
            {state.rows.filter((r) => r.state !== "complete").map(rowView)}
            <Text style={{ color: "#aaa", marginVertical: 16 }}>
              {t(
                state.notifications
                  ? "Downloads go on in the background with a notification. After a force stop they wait until you open the app."
                  : "Downloads run in the background. Notifications are off. After a force stop they wait until you open the app.",
              )}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "white", fontSize: 20 }}>{t("On this device")}</Text>
            {state.rows.filter((r) => r.state === "complete").map(rowView)}
            <Text style={{ color: "#aaa" }}>
              {t("{used} used · {free} free", {
                used: `${Math.floor(state.rows.reduce((sum, r) => sum + r.bytes, 0) / 1048576)} MB`,
                free: `${Math.floor(state.free / 1048576)} MB`,
              })}
            </Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
