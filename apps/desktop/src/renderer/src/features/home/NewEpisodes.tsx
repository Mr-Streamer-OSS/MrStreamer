// New episodes on Home: each followed series the app's refreshes listed episodes of since the
// viewer last looked, the latest news first, with its poster, how many and which, and Details and
// Mark seen. A series its provider lists no more says Unavailable, keeps its news, and offers Stop
// following in place of Details. The main process leaves out titles for adults and series a kids
// profile isn't approved for (see features/titles/follows.ts).
import { useQuery } from "@tanstack/react-query";
import type { SeriesFollow } from "@mrstreamer/contracts/ondemand";
import { t } from "@mrstreamer/core/i18n";
import { openDetails } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { useSourceOf } from "../../lib/queries.ts";
import {
  followQueries,
  newEpisodeLabels,
  useFollowCommands,
  useFollowUpdates,
} from "../titles/follows.ts";

/** The alerts while Home is drawn, and why they couldn't be read. */
export function useNewEpisodes(enabled: boolean) {
  useFollowUpdates();

  return useQuery({ ...followQueries.alerts(), enabled });
}

/** Why the alerts couldn't be read, with Try again. */
export function NewEpisodesError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <p role="alert" className="flex items-baseline gap-3 text-sm text-destructive">
      {t("New episodes couldn't be read.")} {describeError(appError(error))}
      <button
        onClick={retry}
        className="text-foreground underline underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("Try again")}
      </button>
    </p>
  );
}

/** Key it by the viewer too: its commands go as the viewer it was drawn for. */
export function NewEpisodeAlert({ follow }: { follow: SeriesFollow }) {
  const { set, seen } = useFollowCommands();
  const sourceOf = useSourceOf();
  const { title, series, newEpisodes } = follow;
  const name = title?.title ?? follow.name;
  const busy = set.isPending || seen.isPending;
  const open = title ? () => openDetails({ kind: "series", ...series }) : undefined;

  const failed = set.error
    ? { lead: t("Couldn't stop following."), error: set.error }
    : seen.error && { lead: t("Couldn't mark seen."), error: seen.error };

  const line = [
    title ? null : t("Unavailable"),
    t("{count} new episodes", { count: newEpisodes.length }),
    newEpisodeLabels(newEpisodes),
    title && sourceOf({ ...title, ...series }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="flex min-w-0 items-center gap-4" data-home-title>
      <div className="w-28 shrink-0">
        {open ? (
          <button
            title={name}
            onMouseDown={(event) => event.preventDefault()}
            onClick={open}
            className="block aspect-[2/3] w-full overflow-hidden rounded-xl ring-1 ring-white/8 hover:ring-white/40"
          >
            <Artwork url={title?.posterUrl ?? null} name={name} size="card" />
          </button>
        ) : (
          <div className="aspect-[2/3] w-full overflow-hidden rounded-xl ring-1 ring-white/8">
            <Artwork url={null} name={name} size="card" className="opacity-45 saturate-[0.2]" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="text-lg leading-snug font-semibold break-words">{name}</h3>
        <p className="mt-1 text-[0.8125rem] break-words text-muted-foreground">{line}</p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          {open && (
            <Button variant="secondary" size="sm" onClick={open}>
              {t("Details")}
            </Button>
          )}
          <Button
            variant={open ? "ghost" : "secondary"}
            size="sm"
            disabled={busy}
            aria-label={t("Mark new episodes of {name} seen", { name })}
            onClick={() => seen.mutate({ series, episodes: follow.newEpisodes })}
          >
            {t("Mark seen")}
          </Button>
          {!open && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={t("Stop following {name}", { name })}
              onClick={() => set.mutate({ series, following: false })}
            >
              {t("Stop following")}
            </Button>
          )}
        </div>
        {failed && (
          <p role="alert" className="mt-2 text-[0.8125rem] text-destructive">
            {failed.lead} {describeError(appError(failed.error))}
          </p>
        )}
      </div>
    </article>
  );
}
