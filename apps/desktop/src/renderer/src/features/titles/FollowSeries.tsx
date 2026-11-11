// Follow, in a series' action row: a toggle that reads Following once the version that plays is
// followed, and stops following when pressed again. Below the row it says which episodes the
// app's refreshes listed since the viewer last looked, with Mark seen, and when the last check of
// them failed. Until the follow is read the toggle waits; a failed read says why with Try again
// rather than show the series as not followed. Its lines take the row's last places
// (`order-last`), so it sits in the row wherever the actions put it.
import { useQuery } from "@tanstack/react-query";
import { Bell, BellRing } from "lucide-react";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { profileOwner } from "../../lib/ipc.ts";
import { followQueries, useFollowCommands, useFollowUpdates } from "./follows.ts";

const LINE = "order-last w-full text-[0.8125rem] leading-[1.125rem]";

const LINK =
  "font-medium text-white underline underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring";

/** Each viewer and version has its own: a switch of either starts afresh. */
export function FollowSeries({
  title,
  version,
  pending = false,
}: {
  /** The title from the lists; null when they don't have it. */
  title: Title | null;
  version: OwnedId;
  /** True until a successful read of the title from the lists. */
  pending?: boolean;
}) {
  if (!title || pending) {
    return (
      <Button variant="secondary" size="lg" disabled aria-busy>
        <Bell />
        {t("Follow")}
      </Button>
    );
  }

  return <Follow key={JSON.stringify([profileOwner(), ownedKey(version)])} series={version} />;
}

function Follow({ series }: { series: OwnedId }) {
  useFollowUpdates();
  const state = useQuery(followQueries.state(series));
  const { set, seen } = useFollowCommands();

  if (state.isError) {
    return (
      <p role="alert" className={LINE}>
        <span className="text-destructive">
          {t("Couldn't read whether you follow this series.")}{" "}
          {describeError(appError(state.error))}
        </span>{" "}
        <button onClick={() => void state.refetch()} className={LINK}>
          {t("Try again")}
        </button>
      </p>
    );
  }

  const follow = state.data ?? null;
  const following = follow !== null;
  const busy = set.isPending || seen.isPending;

  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        aria-pressed={state.isSuccess ? following : undefined}
        aria-busy={!state.isSuccess || busy || undefined}
        disabled={!state.isSuccess || busy}
        onClick={() => set.mutate({ series, following: !following })}
      >
        {following ? <BellRing className="fill-current" /> : <Bell />}
        {following ? t("Following") : t("Follow")}
      </Button>
      {follow && follow.newEpisodes.length > 0 && (
        <p className={`${LINE} text-foreground`}>
          <span className="font-semibold">
            {t("{count} new episodes", { count: follow.newEpisodes.length })}
          </span>{" "}
          {follow.newEpisodes
            .map((episode) =>
              episode.number > 0
                ? `${episodeLabel(episode.season, episode.number)} ${episode.title}`
                : episode.title,
            )
            .join(" · ")}{" "}
          <button
            disabled={busy}
            onClick={() => seen.mutate({ series, episodes: follow.newEpisodes })}
            className={`ml-2 ${LINK}`}
          >
            {t("Mark seen")}
          </button>
        </p>
      )}
      {follow?.lastCheck.failed && (
        <p className={`${LINE} text-destructive`}>
          {t("Couldn't check for new episodes. The next refresh tries again.")}
        </p>
      )}
      {set.isError && (
        <p role="alert" className={`${LINE} text-destructive`}>
          {set.variables.following ? t("Couldn't follow.") : t("Couldn't stop following.")}{" "}
          {describeError(appError(set.error))}
        </p>
      )}
      {seen.isError && (
        <p role="alert" className={`${LINE} text-destructive`}>
          {t("Couldn't mark seen.")} {describeError(appError(seen.error))}
        </p>
      )}
    </>
  );
}
