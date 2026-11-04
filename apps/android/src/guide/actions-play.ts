import { createElement as h, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { ProviderChannel } from "@mrstreamer/core/provider";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { sources } from "../bootstrap/sources.ts";
import { playlistReader } from "../connect/playlist.ts";
import { libraryIntents } from "../library/intents.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { useStore } from "../platform/store.ts";
import { programmeEntry } from "../play-entry/programme.ts";
import type { ChannelIdentity } from "./routes.ts";
import { catalogue } from "./catalogue.ts";
import { Button, text } from "./ui.tsx";

const t = catalogue(
  {
    "Watch live": "Watch live",
    "Play from start": "Play from start",
    "Catch-up": "Catch-up",
    "Programme hasn't started": "Programme hasn't started",
    "No archive for this channel": "No archive for this channel",
    "Outside the provider's archive": "Outside the provider's archive",
    "Channel unavailable": "Channel unavailable",
    "Couldn't check playback": "Couldn't check playback",
    "Try again": "Try again",
  },
  {
    "nl-NL": {
      "Watch live": "Live kijken",
      "Play from start": "Vanaf begin afspelen",
      "Catch-up": "Terugkijken",
      "Programme hasn't started": "Programma is nog niet begonnen",
      "No archive for this channel": "Geen archief voor deze zender",
      "Outside the provider's archive": "Buiten het archief van de provider",
      "Channel unavailable": "Zender niet beschikbaar",
      "Couldn't check playback": "Afspelen kon niet worden gecontroleerd",
      "Try again": "Opnieuw proberen",
    },
  },
);

/** Checks archive support without opening a stream. Source changes withdraw every pending action. */
export function ProgrammeActions({
  identity,
  programme,
  channelName,
}: {
  identity: ChannelIdentity;
  programme: Programme;
  channelName: string;
}) {
  const state = useStore(sources.state);
  const { play } = useStore(libraryIntents.state);
  const [retry, setRetry] = useState(0);

  const [answer, setAnswer] = useState<{
    state: typeof state;
    channel: ProviderChannel | null;
    failed: boolean;
  }>();

  useEffect(() => {
    const controller = new AbortController();

    const source =
      state.kind === "ready" ? state.sources.find((s) => s.id === identity.sourceId) : undefined;

    if (!source || source.channels.kind !== "ready") return;
    void (async () => {
      try {
        const authority = await nativeCredentials().read(identity.sourceId);

        if (!authority || controller.signal.aborted) throw new Error("Unavailable");

        const fetcher: typeof fetch = (input, init) =>
          fetch(input, { ...init, cache: "no-store", credentials: "omit" });

        const platform = { fetch: fetcher, userAgent: "MrStreamer-Android/0.1.0" };

        const reader =
          authority.kind === "xtream"
            ? xtreamProvider(authority, platform)
            : playlistReader(authority.link, platform);

        const catalogue = await reader.liveCatalogue(controller.signal);
        const channels = catalogue.channels.filter((c) => c.id === identity.channelId);

        if (!controller.signal.aborted)
          setAnswer({ state, channel: channels.length === 1 ? channels[0]! : null, failed: false });
      } catch {
        if (!controller.signal.aborted) setAnswer({ state, channel: null, failed: true });
      }
    })();

    return () => controller.abort();
  }, [state, identity.sourceId, identity.channelId, retry]);

  if (!play || answer?.state !== state) return null;

  const entry =
    answer.channel && programmeEntry(identity, answer.channel, channelName, programme, Date.now());

  const run = (archive: boolean) => {
    if (sources.state.get() !== state || !answer.channel) return;
    const current = programmeEntry(identity, answer.channel, channelName, programme, Date.now());
    const intent = archive ? current?.archive : current?.live;

    if (intent) libraryIntents.state.get().play?.(intent);
  };

  return h(
    View,
    { style: { gap: 8 } },
    entry ? h(Button, { label: t("Watch live"), onPress: () => run(false) }) : null,
    entry?.archive
      ? h(Button, {
          label: t(programme.stop <= Date.now() ? "Catch-up" : "Play from start"),
          onPress: () => run(true),
        })
      : null,
    h(
      Text,
      { style: [text.secondary, { paddingHorizontal: 16 }] },
      answer.failed
        ? t("Couldn't check playback")
        : !entry || entry.reason === "invalid"
          ? t("Channel unavailable")
          : entry.reason === "future"
            ? t("Programme hasn't started")
            : entry.reason === "none"
              ? t("No archive for this channel")
              : entry.reason === "outside"
                ? t("Outside the provider's archive")
                : "",
    ),
    answer.failed
      ? h(Button, { label: t("Try again"), onPress: () => setRetry((n) => n + 1) })
      : null,
  );
}
