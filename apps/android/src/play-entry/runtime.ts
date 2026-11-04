import { viewing } from "../home/index.ts";
import { sources } from "../bootstrap/sources.ts";
import { router } from "expo-router";
import { Alert } from "react-native";
import { libraryIntents } from "../library/intents.ts";
import { library } from "../library/runtime.ts";
import { player } from "../player/instance.ts";
import { watchHref } from "../player/intent.ts";
import { t } from "../library/i18n.ts";
import { startEntries } from "./entries.ts";

/** Root owns this registration alongside, and independently of, Viewing and Downloads. */
export const startPlayEntries = () =>
  startEntries({
    intents: libraryIntents,
    subscribe: sources.state.subscribe,
    player,
    library,
    progress: viewing.progress,
    open: (intent) => router.push(watchHref(intent)),
    refused: () => Alert.alert(t("Couldn't load details.")),
  });
