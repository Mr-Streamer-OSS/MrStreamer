// A saved title the lists don't have, in a short sheet over the page: the name, year and kind
// that were kept, when it was saved, and Remove. Nothing plays from here, and nothing stands in
// for the title. Once a provider lists it again, its tile opens its details as before. Beside
// other subscriptions it names those it was saved from.
import { Dialog } from "@base-ui/react/dialog";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { useUi } from "../../app/ui-store.ts";
import { Sheet } from "../../components/Sheet.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { namesList } from "../../lib/format.ts";
import { useSubscriptionNames, useSubscriptions } from "../../lib/queries.ts";
import { kindLabel, useRemoveSaved } from "../../lib/watchlist.ts";

const close = () => useUi.setState({ savedEntry: null });

/** "12 Sep", with the year when it isn't this one. */
function savedDay(at: number): string {
  const day = new Date(at);
  return day.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(day.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

export function SavedSheet({ entry }: { entry: WatchlistEntry }) {
  const removal = useRemoveSaved();
  // Whose lists it is missing from: named beside other subscriptions, which may list another
  // title of its name.
  const nameOf = useSubscriptionNames();
  const several = useSubscriptions().length > 1;
  const from = several ? entry.sources.flatMap((source) => nameOf(source) ?? []) : [];
  const who = from.length > 0 ? namesList(from) : "Your provider";
  const facts = [entry.year, kindLabel(entry.kind), `Saved ${savedDay(entry.savedAt)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <Sheet onClose={close} short>
      <div className="relative h-44 overflow-hidden rounded-t-3xl">
        <Artwork
          url={entry.artworkUrl}
          name={entry.name}
          size="full"
          plain
          className="opacity-50 saturate-[0.2]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0c] via-[#0b0b0c]/40 to-transparent" />
      </div>
      <div className="relative -mt-20 px-10 pb-12">
        <Dialog.Title className="text-4xl font-semibold tracking-tight text-balance">
          {entry.name}
        </Dialog.Title>
        <div className="mt-2 text-[0.9375rem] text-muted-foreground">{facts}</div>
        <div className="mt-6">
          <Button
            variant="secondary"
            size="lg"
            autoFocus
            aria-busy={removal.isPending || undefined}
            onClick={() => removal.remove(entry, close)}
          >
            Remove from Watchlist
          </Button>
        </div>
        <p className="mt-3 text-[0.8125rem] text-muted-foreground">
          {/* Without lists nothing says a provider dropped it, only that it couldn't be looked up. */}
          {entry.listed
            ? `${who} ${from.length > 1 ? "don't" : "doesn't"} list it right now. `
            : `${who}'s lists haven't loaded. `}
          It stays here until you remove it.
        </p>
        {removal.error && (
          <p className="mt-3 text-sm text-destructive">Couldn't remove. Try again.</p>
        )}
      </div>
    </Sheet>
  );
}
