import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { useLocale } from "../../../i18n/catalogue.ts";
import { t } from "../../../i18n/pages.ts";
import { PlaylistScreen, type PlaylistView } from "../../../playlist-groups.tsx";

/**
 * A playlist's groups from Settings, by its `id`: one group when `group` names it, the entries
 * left out with `left`, else every group. Pushed on the stack Settings is on.
 */
export default function Playlist() {
  const {
    id = "",
    group,
    left,
  } = useLocalSearchParams<{
    id: string;
    group?: string;
    left?: string;
  }>();
  const navigation = useNavigation();
  const locale = useLocale();
  const view: PlaylistView = group
    ? { kind: "group", group }
    : left
      ? { kind: "left-out" }
      : { kind: "groups" };
  useLayoutEffect(() => {
    // One group and Left out carry their own large title.
    navigation.setOptions({ title: view.kind === "groups" ? t("Playlist groups") : "" });
  }, [navigation, view.kind, locale]);
  return <PlaylistScreen id={id} view={view} />;
}
