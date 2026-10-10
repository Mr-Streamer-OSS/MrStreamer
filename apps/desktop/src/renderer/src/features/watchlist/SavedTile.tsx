// A saved movie or series as a poster, in the Watchlist's grid and in Home's row. One the lists
// have opens its details, where Play offers every subscription's versions; one they don't is
// dimmed, says Unavailable and opens the short sheet that removes it.
import { X } from "lucide-react";
import { ownedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { t } from "@mrstreamer/core/i18n";
import { openDetails, openSavedEntry } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { useSourceOf } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { kindLabel } from "../../lib/watchlist.ts";

/** Opens what a saved entry has to show: its title's details, or what was kept of it. */
export function openSaved(entry: WatchlistEntry): void {
  if (entry.title) openDetails({ kind: entry.kind, ...ownedId(entry.title) });
  else openSavedEntry(entry);
}

/**
 * The line under a poster ends with the subscription the title is from where another's reads the
 * same and isn't it, as every poster's does.
 */
export function SavedTile({
  entry,
  brief = false,
  selected = false,
  onRemove,
}: {
  entry: WatchlistEntry;
  /** One word for an unavailable title, where a row has no room for more. */
  brief?: boolean;
  /** The keyboard is on it. */
  selected?: boolean;
  /** Shows the cross that takes it off the watchlist. */
  onRemove?: () => void;
}) {
  const { title } = entry;
  const sourceOf = useSourceOf();
  const name = title?.title ?? entry.name;
  // The lists were there to look in, so an entry without a title is one no provider lists.
  // Without them, nothing says so.
  const unavailable = entry.listed && !title;
  const facts = [kindLabel(entry.kind), title?.year ?? entry.year, title && sourceOf(title)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="group relative min-w-0">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => openSaved(entry)}
        className="block w-full text-left"
        title={title?.name}
      >
        <span
          className={cn(
            "block aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]",
            selected && "ring-2 ring-white",
          )}
        >
          <Artwork
            url={title?.posterUrl ?? entry.artworkUrl}
            name={name}
            size="card"
            className={cn(unavailable && "opacity-45 saturate-[0.2]")}
          />
        </span>
        <span
          className={cn(
            "mt-2 block truncate text-[0.875rem] font-medium",
            unavailable && "text-muted-foreground",
          )}
        >
          {name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {!unavailable ? facts : brief ? t("Unavailable") : `${t("Unavailable")} · ${facts}`}
        </span>
      </button>
      {onRemove && (
        <button
          aria-label={t("Remove {name} from Watchlist", { name })}
          data-remove
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/70 text-white opacity-0 ring-1 ring-white/20 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
