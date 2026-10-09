import { ArrowDownToLine, ChevronLeft, Search, Settings } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode, type RefCallback } from "react";
import { hasTitles } from "@mrstreamer/contracts/subscription";
import { isMac, useWindowFullScreen } from "../app/platform.ts";
import { closeWatch, withoutTitles, openView, useUi, type View } from "../app/ui-store.ts";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { useQuery } from "@tanstack/react-query";
import { type PlainKey, t } from "@mrstreamer/core/i18n";
import { queries, useSubscriptions } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { WINDOW_BAR } from "../../../shared/window-bar.ts";
import { Logo } from "./Logo.tsx";
import { TmdbProgress } from "./TmdbProgress.tsx";
import { Button } from "./ui/button.tsx";

const VIEWS = [
  { view: "home", label: "Home" },
  { view: "live", label: "Live TV" },
  { view: "movies", label: "Movies" },
  { view: "series", label: "Series" },
  { view: "watchlist", label: "Watchlist" },
  { view: "downloads", label: "Downloads" },
] as const satisfies readonly { readonly view: View; readonly label: PlainKey }[];

/**
 * The top of the window: brand, the pages, how far TMDB has come, search and settings. It is also
 * the window's drag area; macOS draws its traffic lights on the left and Windows its controls on
 * the right, except in full screen, where the bar takes their room. Over Settings, Watch or a
 * title's details, Back takes the pages' place and returns to the page underneath. `onBack`
 * overrides where it goes, as a playing title or an open collection does. Subscriptions with
 * live TV only have no Movies, Series or Watchlist. Where the window is too narrow for every
 * page's name, Downloads goes beside Search as a button of its own, under the same name.
 */
export function WindowBar({ className, onBack }: { className?: string; onBack?: () => void }) {
  const view = useUi((state) => state.view);
  // An unmapped playlist has live TV only; explicit mapping enables the title pages.
  const subscriptions = useSubscriptions();
  const liveOnly = !subscriptions.some(hasTitles);
  // A copy playing with no subscription saved: there is nothing to search, and no Settings page.
  const alone = useQuery(queries.subscriptions()).data?.length === 0;
  const watching = useUi((state) => state.watching);
  const settingsOpen = useUi((state) => state.settings !== null);
  const detailsOpen = useUi((state) => state.details !== null || state.savedEntry !== null);
  const [pages, folded] = useFolds();
  const back =
    onBack ??
    (settingsOpen
      ? () => useUi.setState({ settings: null })
      : watching
        ? closeWatch
        : detailsOpen
          ? () => useUi.setState({ details: null, savedEntry: null })
          : null);
  const shown = liveOnly ? VIEWS.filter((entry) => withoutTitles(entry.view)) : VIEWS;
  return (
    <BarFrame className={className}>
      <Brand />
      {back ? (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={back}
          className="flex h-8 items-center gap-1 rounded-full pr-3 pl-1.5 text-[0.875rem] font-semibold text-white hover:text-white/75"
        >
          <ChevronLeft className="size-4" />
          {t("Back")}
        </button>
      ) : (
        <nav ref={pages} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {shown
            .filter((entry) => !(folded && entry.view === "downloads"))
            .map((entry) => (
              <PageButton key={entry.view} view={entry.view} current={entry.view === view}>
                {t(entry.label)}
              </PageButton>
            ))}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <UpdateNotice />
        <TmdbProgress />
        {folded && !back && (
          <Button
            variant={view === "downloads" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={t("Downloads")}
            aria-current={view === "downloads" ? "page" : undefined}
            onClick={() => openView("downloads")}
          >
            <ArrowDownToLine />
          </Button>
        )}
        {!alone && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Search")}
              onClick={() => useUi.setState({ searchOpen: true })}
            >
              <Search />
            </Button>
            <Button
              variant={settingsOpen ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={t("Settings")}
              aria-pressed={settingsOpen}
              onClick={() => useUi.setState({ settings: settingsOpen ? null : "general" })}
            >
              <Settings />
            </Button>
          </>
        )}
      </div>
    </BarFrame>
  );
}

/**
 * The bar's frame: the window's drag area, clear of macOS's traffic lights on the left and the
 * Windows controls on the right, except in full screen, where the bar takes their room.
 */
export function BarFrame({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  const controls = !useWindowFullScreen();
  return (
    <header
      className={cn("drag flex flex-none items-center gap-1 px-4", className)}
      style={{
        height: WINDOW_BAR.height,
        ...(controls &&
          (isMac
            ? { paddingLeft: WINDOW_BAR.macInset }
            : { paddingRight: WINDOW_BAR.windowsInset })),
      }}
    >
      {children}
    </header>
  );
}

export function Brand() {
  return (
    <span className="mr-4 flex flex-none items-center gap-2">
      <Logo className="size-5" />
      <b className="text-[0.9375rem] tracking-tight">mr. streamer</b>
    </span>
  );
}

/** A page's name in the bar: bold and white for the page on screen. */
export function PageButton({
  view,
  current,
  children,
}: {
  view: View;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-current={current ? "page" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openView(view)}
      className={cn(
        "h-8 flex-none rounded-full px-3 text-[0.875rem] transition-colors",
        current ? "font-semibold text-white" : "text-muted-foreground hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Whether the pages' names fold Downloads away: once they don't fit where the bar holds them, and
 * until there is room again for as much as they took. That room is a little more than they need
 * while Downloads stands beside Search, so the bar never flips back and forth at one width.
 */
function useFolds(): [RefCallback<HTMLElement>, boolean] {
  const [folded, setFolded] = useState(false);
  const needed = useRef(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const measure = () =>
      setFolded((was) => {
        if (!was && element.scrollWidth > element.clientWidth) {
          needed.current = element.scrollWidth;
          return true;
        }
        return was && element.clientWidth < needed.current;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, folded];
}
