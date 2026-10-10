import { useQuery } from "@tanstack/react-query";
import type { TitleDetails } from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { openDetails } from "../../app/ui-store.ts";
import { PosterTile } from "../../components/TitleArt.tsx";
import { queries } from "../../lib/queries.ts";

/** An inline row from the lists already loaded, requested only while these details are shown. */
export function RelatedTitles({
  details,
  switching,
}: {
  details: TitleDetails;
  switching: boolean;
}) {
  const related = useQuery({
    ...queries.related(details.kind, details.title),
    enabled: !switching,
  });
  const picks = related.data?.titles ?? [];
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
                title={title}
                line={[title.year, reason !== related.data?.basis ? reason : null]
                  .filter(Boolean)
                  .join(" · ")}
                onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
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
