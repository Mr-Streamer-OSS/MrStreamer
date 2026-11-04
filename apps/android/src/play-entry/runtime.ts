import { catalogue } from "../guide/catalogue.ts";
import { viewing } from "../home/index.ts";
import { sources } from "../bootstrap/sources.ts";
import { router } from "expo-router";
import { Alert } from "react-native";
import { libraryIntents } from "../library/intents.ts";
import { library } from "../library/runtime.ts";
import { player } from "../player/instance.ts";
import { watchHref } from "../player/intent.ts";
import { startEntries } from "./entries.ts";

const t = catalogue(
  {
    "File unavailable": "File unavailable",
    "Couldn't load details.": "Couldn't load details.",
    "Couldn't read viewing history": "Couldn't read viewing history",
    "Try again": "Try again",
    "Play from beginning": "Play from beginning",
  },
  {
    "nl-NL": {
      "File unavailable": "Bestand niet beschikbaar",
      "Couldn't load details.": "Details konden niet worden geladen.",
      "Couldn't read viewing history": "Kijkgeschiedenis kon niet worden gelezen",
      "Try again": "Opnieuw proberen",
      "Play from beginning": "Vanaf het begin afspelen",
    },
  },
);

/** Root owns this registration alongside, and independently of, Viewing and Downloads. */
export const startPlayEntries = () =>
  startEntries({
    intents: libraryIntents,
    subscribe: sources.state.subscribe,
    player,
    library,
    progress: async (title) => {
      if (viewing.state.get().kind !== "ready") await viewing.read();

      return viewing.progress(title);
    },
    open: (intent) => router.push(watchHref(intent)),
    refused: (reason, retry, beginning) =>
      Alert.alert(
        t(
          reason === "history"
            ? "Couldn't read viewing history"
            : reason === "file"
              ? "File unavailable"
              : "Couldn't load details.",
        ),
        undefined,
        [
          { text: t("Try again"), onPress: retry },
          ...(beginning ? [{ text: t("Play from beginning"), onPress: beginning }] : []),
        ],
      ),
  });
