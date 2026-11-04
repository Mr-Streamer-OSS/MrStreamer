import { Fragment, createElement as h, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Programme } from "@mrstreamer/contracts/guide";
import { t as sharedT } from "@mrstreamer/core/i18n";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import type { Channels } from "../connect/sources.ts";
import { sources } from "../bootstrap/sources.ts";
import { playlistReader } from "../connect/playlist.ts";
import { libraryIntents } from "../library/intents.ts";
import { nativeCredentials } from "../platform/credentials.ts";
import { useStore } from "../platform/store.ts";
import { inTasks } from "../platform/tasks.ts";
import { colors } from "../ui/theme.ts";
import { programmeEntry } from "../play-entry/programme.ts";
import type { ChannelIdentity } from "./routes.ts";
import { catalogue } from "./catalogue.ts";
import { Button } from "./ui.tsx";

const t = catalogue(
  {
    "Watch live": "Watch live",
    "Play from start": "Play from start",
    "Catch-up": "Catch-up",
    "No archive for this channel": "No archive for this channel",
    "Outside the provider's archive": "Outside the provider's archive",
    "Channel unavailable": "Channel unavailable",
    "Couldn't check playback": "Couldn't check playback",
    "Restore the source login in Settings": "Restore the source login in Settings",
  },
  {
    "nl-NL": {
      "Watch live": "Live kijken",
      "Play from start": "Vanaf het begin",
      "Catch-up": "Terugkijken",
      "No archive for this channel": "Geen archief voor deze zender",
      "Outside the provider's archive": "Buiten het archief van de provider",
      "Channel unavailable": "Zender niet beschikbaar",
      "Couldn't check playback": "Afspelen kon niet worden gecontroleerd",
      "Restore the source login in Settings": "Herstel de login van de bron in Instellingen",
    },
  },
);

type ArchiveAuthority = NonNullable<ReturnType<typeof sources.onDemand>> | Channels;

const archives = new WeakMap<ArchiveAuthority, Promise<LiveCatalogue>>();

// Cache by the signed-in reader (or playlist channel generation), never by unrelated store ticks.
function archiveCatalogue(key: ArchiveAuthority, sourceId: string) {
  let pending = archives.get(key);

  if (pending) return pending;
  pending = (async () => {
    const authority = await nativeCredentials().read(sourceId);

    if (!authority) throw new Error("login");

    const platform = {
      userAgent: "MrStreamer-Android/0.1.0",
      inTasks,
      fetch: ((input, init) =>
        fetch(input, {
          ...init,
          credentials: "omit",
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            "Cache-Control": "no-store",
          },
        })) satisfies typeof fetch,
    };

    const reader =
      authority.kind === "xtream"
        ? xtreamProvider(authority, platform)
        : playlistReader(authority.link, platform);

    return reader.liveCatalogue();
  })();
  archives.set(key, pending);

  return pending;
}

/** Live uses the listed channel immediately; archive support is a separate, cached read. */
export function ProgrammeActions({
  identity,
  programme,
  channelName,
  inset,
}: {
  identity: ChannelIdentity;
  programme: Programme;
  channelName: string;
  /** The programme's side padding: 16dp pushed, 24dp in a pane. */
  inset: number;
}) {
  const state = useStore(sources.state);
  const { play } = useStore(libraryIntents.state);
  const [retry, setRetry] = useState(0);

  const matches =
    state.kind === "ready" ? state.sources.filter((s) => s.id === identity.sourceId) : [];

  const source = matches.length === 1 ? matches[0] : undefined;

  const rows = source?.channels.kind === "ready" ? source.channels.rows : [];
  const listed = rows.filter((r) => r.key === `${identity.sourceId}:${identity.channelId}`);
  const key = source?.kind === "xtream" ? sources.onDemand(source.id) : source?.channels;

  const [answer, setAnswer] = useState<{
    key: ArchiveAuthority;
    channelId: string;
    channel: ProviderChannel | null;
    failed: boolean;
    login?: boolean;
  }>();

  useEffect(() => {
    if (!key || listed.length !== 1) return;
    let active = true;
    void archiveCatalogue(key, identity.sourceId).then(
      (catalogue) => {
        const channels = catalogue.channels.filter((c) => c.id === identity.channelId);

        if (active)
          setAnswer({
            key,
            channelId: identity.channelId,
            channel: channels.length === 1 ? channels[0]! : null,
            failed: false,
          });
      },
      (error: Error) => {
        if (active)
          setAnswer({
            key,
            channelId: identity.channelId,
            channel: null,
            failed: true,
            login: error instanceof Error && error.message === "login",
          });
      },
    );

    return () => {
      active = false;
    };
  }, [key, identity.sourceId, identity.channelId, listed.length, retry]);

  if (!play) return null;

  const ready =
    answer?.key === key && answer?.channelId === identity.channelId ? answer : undefined;

  const entry =
    listed.length === 1
      ? programmeEntry(
          identity,
          ready?.channel ?? { id: identity.channelId, catchupDays: null },
          channelName,
          programme,
          Date.now(),
        )
      : null;

  const run = (archive: boolean) => {
    const current = sources.state.get();

    const matches =
      current.kind === "ready" ? current.sources.filter((s) => s.id === identity.sourceId) : [];

    const source = matches.length === 1 ? matches[0] : undefined;

    const authority = source?.kind === "xtream" ? sources.onDemand(source.id) : source?.channels;

    if (
      authority !== key ||
      source?.channels.kind !== "ready" ||
      source.channels.rows.filter((r) => r.key === `${identity.sourceId}:${identity.channelId}`)
        .length !== 1
    )
      return;
    const intent = archive ? entry?.archive : entry?.live;

    if (intent) libraryIntents.state.get().play?.(intent);
  };

  // A future programme already shows its time and Remind me, and bad guide times leave Live as is.
  const line =
    entry && (!key || ready?.login)
      ? t("Restore the source login in Settings")
      : ready?.failed
        ? t("Couldn't check playback")
        : !entry
          ? t("Channel unavailable")
          : !ready
            ? null
            : entry.reason === "none"
              ? t("No archive for this channel")
              : entry.reason === "outside"
                ? t("Outside the provider's archive")
                : null;

  return h(
    Fragment,
    null,
    entry
      ? h(
          View,
          { style: { flexDirection: "row", gap: 8, paddingTop: 20, paddingHorizontal: inset } },
          h(Button, {
            label: t("Watch live"),
            icon: "play-arrow",
            filled: true,
            grow: true,
            onPress: () => run(false),
          }),
          entry.archive
            ? h(Button, {
                label: t(programme.stop <= Date.now() ? "Catch-up" : "Play from start"),
                icon: "replay",
                grow: true,
                onPress: () => run(true),
              })
            : null,
        )
      : null,
    line
      ? h(
          View,
          {
            style: {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingTop: 16,
              paddingHorizontal: inset,
            },
          },
          h(
            Text,
            {
              accessibilityLiveRegion: "polite",
              style: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
            },
            line,
          ),
          ready?.failed && !ready.login
            ? h(Button, {
                label: sharedT("Try again"),
                onPress: () => {
                  if (key) archives.delete(key);
                  setRetry((n) => n + 1);
                },
              })
            : null,
        )
      : null,
  );
}
