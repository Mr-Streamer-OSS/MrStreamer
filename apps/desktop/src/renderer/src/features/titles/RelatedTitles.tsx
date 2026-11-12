import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Title, TitleDetails } from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { openRelated, type DetailsPlace, type LinkedView } from "../../app/ui-store.ts";
import { PosterTile } from "../../components/TitleArt.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";

/**
 * An inline row from the lists already loaded, requested only while these details are shown. A
 * title in it opens over these details, which Back returns to as they stood (`here`). Returned
 * to from `returnTo`, a `Title.key`, the row hands `onReturn` that title's tile once it settles,
 * or null when it no longer shows it.
 */
export function RelatedTitles({
  details,
  switching,
  here,
  returnTo = null,
  onReturn,
}: {
  details: TitleDetails;
  switching: boolean;
  /** Where these details stand as the related title `related` opens from them. */
  here: (related: string) => DetailsPlace;
  returnTo?: string | null;
  onReturn?: (tile: HTMLElement | null) => void;
}) {
  const related = useQuery({
    ...queries.related(details.kind, details.title),
    enabled: !switching,
  });

  const picks = related.data?.titles ?? [];
  const returned = useRef<HTMLButtonElement>(null);
  const returning = useRef(returnTo !== null);
  const settled = !switching && !related.isPending;
  // After the commit, once the sheet around the row has its scroller too.
  useEffect(() => {
    if (!returning.current || !settled) return;
    returning.current = false;
    onReturn?.(returned.current);
  });

  return (
    <section
      className="mt-8 min-w-0"
      aria-label={t("Also in your subscriptions")}
      inert={switching || undefined}
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[0.9375rem] font-semibold">{t("Also in your subscriptions")}</h2>
        {picks.length > 0 && related.data?.basis && (
          <span className="text-xs text-foreground/70">{related.data.basis}</span>
        )}
      </div>
      {picks.length > 0 ? (
        <div className="flex gap-4 overflow-x-auto pb-3">
          {picks.map(({ title, reason }) => (
            <div key={title.key} className="w-36 shrink-0">
              <PosterTile
                ref={title.key === returnTo ? returned : undefined}
                title={title}
                line={[title.year, reason !== related.data?.basis ? reason : null]
                  .filter(Boolean)
                  .join(" · ")}
                onOpen={() => openRelated({ kind: title.kind, ...ownedId(title) }, here(title.key))}
              />
            </div>
          ))}
        </div>
      ) : (
        <p
          className="text-[0.875rem] text-foreground/75"
          role={related.isError ? "status" : undefined}
        >
          {related.isError
            ? t("Related titles couldn't be read.")
            : related.isPending || switching
              ? t("Loading related titles…")
              : t(
                  "Nothing like it in your lists yet. Titles here come from your subscriptions, not from the web.",
                )}
        </p>
      )}
    </section>
  );
}

/**
 * A person's or film franchise's titles in the viewer's subscriptions, in the details' sheet in
 * place of the details whose link opened them (`openLinked`): named by TMDB, else by the link's
 * own text, a person's newest first and a franchise's in release order. Each title opens the
 * version listed first over this list, which Back returns to as it stood (`here`). Returned to
 * from `returnTo`, a `Title.key`, it hands `onReturn` that title's tile once the list settles, or
 * null when it no longer lists it; opened anew, the keyboard starts on its name.
 */
export function LinkedTitles({
  view,
  here,
  returnTo = null,
  onReturn,
}: {
  view: LinkedView;
  /** Where the sheet stands as the title `related` opens from this list. */
  here: (related: string) => DetailsPlace;
  returnTo?: string | null;
  onReturn?: (tile: HTMLElement | null) => void;
}) {
  const linked = useQuery(queries.linked(view.link));
  const titles = linked.data?.titles ?? [];
  const person = view.link.kind === "person";
  // Try again after a failure shows the list loading, not the failure, while TMDB is asked.
  const waiting = linked.isPending || (linked.isError && linked.isFetching);

  const name = useRef<HTMLHeadingElement>(null);
  const returned = useRef<HTMLButtonElement>(null);
  const returning = useRef(returnTo !== null);
  useEffect(() => {
    if (!returning.current) name.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!returning.current || waiting) return;
    returning.current = false;
    onReturn?.(returned.current);
  });

  return (
    <div className="px-10 pt-10 pb-12">
      <Dialog.Title
        ref={name}
        tabIndex={-1}
        className="pr-16 text-4xl font-semibold tracking-tight text-balance outline-none"
      >
        {linked.data?.name ?? view.label}
      </Dialog.Title>
      {waiting ? (
        <p className="mt-2 text-[0.9375rem] text-muted-foreground">{t("Loading…")}</p>
      ) : linked.isError ? (
        <p role="alert" className="mt-4 text-[0.875rem] text-destructive">
          {describeError(appError(linked.error))}{" "}
          {/* The button goes while TMDB is asked again, so the keyboard waits on the name. */}
          <button
            onClick={() => {
              name.current?.focus({ preventScroll: true });
              void linked.refetch();
            }}
            className="text-white underline"
          >
            {t("Try again")}
          </button>
        </p>
      ) : titles.length === 0 ? (
        <p className="mt-4 text-[0.875rem] text-foreground/75">
          {person
            ? t("None of their titles are in your subscriptions.")
            : t("None of its films are in your subscriptions.")}
        </p>
      ) : (
        <>
          <p className="mt-2 text-[0.9375rem] text-muted-foreground">
            {person
              ? t("{count} in your subscriptions, newest first", { count: titles.length })
              : t("{count} in your subscriptions, in release order", { count: titles.length })}
          </p>
          <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-6">
            {titles.map((title) => (
              <li key={title.key} className="w-36 shrink-0">
                <PosterTile
                  ref={title.key === returnTo ? returned : undefined}
                  title={title}
                  line={lineOf(title)}
                  onOpen={() =>
                    openRelated(
                      { kind: title.kind, ...ownedId(title), asked: true },
                      here(title.key),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The year, and Series for a series, as a person's titles mix both. */
function lineOf(title: Title): string {
  return [title.year, title.kind === "series" ? t("Series") : null].filter(Boolean).join(" · ");
}
