import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { SeriesDetails, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { downloads } from "../downloads/runtime.ts";
import { seriesFiles, type SeriesPlan } from "../downloads/series.ts";
import { library } from "./runtime.ts";
import { useStore } from "../platform/store.ts";
import { Press } from "./parts.tsx";
import { colors } from "../ui/theme.ts";

/** Basic integration controls; the accepted Paper sheet and localized copy follow in design. */
export function SeriesDownload({
  details,
  version,
  containers,
  season,
  revision,
}: {
  details: SeriesDetails;
  version: TitleVersion;
  containers: ReadonlyMap<string, string>;
  season?: number;
  revision: number;
}) {
  const [controller] = useState(() => downloads().series());
  const run = useStore(controller.state);
  const latest = useRef({ details, version, revision });
  latest.current = { details, version, revision };
  useEffect(
    () => () => {
      void controller.close();
    },
    [controller],
  );
  useFocusEffect(
    useCallback(
      () => () => {
        controller.stop("left");
      },
      [controller],
    ),
  );
  const [failure, setFailure] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan>();
  const state = useStore(downloads().state);

  const files = () =>
    seriesFiles(
      details,
      version,
      containers,
      library().sourceLabel(version.subscriptionId) ?? "",
      season === undefined ? { kind: "series" } : { kind: "season", season },
    );

  let available: ReturnType<typeof files> | undefined;

  try {
    available = files();
  } catch {
    /* Incomplete provider details cannot form an exact plan. */
  }

  const held = available?.filter((file) =>
    state.rows.some((row) => row.key === file.key && row.state !== "failed"),
  ).length;

  async function review(retry = false) {
    try {
      const reader = library().reader(version.subscriptionId);
      const previous = controller.state.get()?.result.failed;
      const all = files();

      const frozen = await controller.plan(
        retry ? all.filter((f) => previous?.some((p) => p.key === f.key)) : all,
      );

      setPlan(frozen);

      const stands = () =>
        library().reader(version.subscriptionId) !== reader
          ? ("login" as const)
          : latest.current.details !== details ||
              latest.current.version !== version ||
              latest.current.revision !== revision
            ? ("version" as const)
            : null;

      const start = (replace: boolean) => {
        void controller
          .start(frozen, replace, stands)
          .then((result) => {
            if (result && result.stopped !== "left")
              Alert.alert(
                `${result.added} queued, ${result.retried} retried, ${result.replaced} replaced, ${result.skipped} changed meanwhile, ${result.failed.length} failed, ${result.unqueued} not queued${result.stopped ? ` (${result.stopped})` : ""}`,
              );
          })
          .catch(() => setFailure(true));
      };

      Alert.alert(
        "Download remaining",
        `${frozen.held} of ${all.length} saved or queued\n${frozen.add} new, ${frozen.retry} retries, ${frozen.missing} missing, ${frozen.changed} changed\nSize unavailable`,
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => {
              void controller.close();
            },
          },
          { text: `Download ${frozen.add + frozen.retry} episodes`, onPress: () => start(false) },
          ...(frozen.missing + frozen.changed > 0
            ? [
                {
                  text: `Download and replace ${frozen.missing + frozen.changed} copies`,
                  onPress: () => start(true),
                },
              ]
            : []),
        ],
      );
    } catch {
      setFailure(true);
    }
  }

  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Text style={{ color: colors.text }}>
        {available ? `${held} of ${available.length} saved or queued` : "Couldn't read downloads."}
      </Text>
      <Text style={{ color: colors.secondary }}>Stops if you leave this series</Text>
      {failure ? (
        <Text style={{ color: "#ff5555" }}>Couldn't read or save downloads. Try again.</Text>
      ) : null}
      <Press
        label={
          run?.running
            ? "Cancel remaining"
            : season === undefined
              ? "Review series download"
              : "Download remaining"
        }
        onPress={() => (run?.running ? controller.stop() : void review())}
      >
        <Text style={{ color: colors.text }}>
          {run?.running
            ? `Cancel remaining (${run.done} of ${run.total})`
            : season === undefined
              ? "Review series download"
              : "Download remaining"}
        </Text>
      </Press>
      {!run?.running && plan && run?.result.failed.length ? (
        <Press label="Retry failed" onPress={() => void review(true)}>
          <Text style={{ color: colors.text }}>Retry failed</Text>
        </Press>
      ) : null}
    </View>
  );
}
