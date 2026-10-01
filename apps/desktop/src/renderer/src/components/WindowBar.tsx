import { ChevronLeft, Search, Settings } from "lucide-react";
import { isMac } from "../app/platform.ts";
import { closeWatch, openView, useUi, type View } from "../app/ui-store.ts";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { cn } from "../lib/utils.ts";
import { WINDOW_BAR } from "../../../shared/window-bar.ts";
import { Logo } from "./Logo.tsx";
import { TmdbProgress } from "./TmdbProgress.tsx";
import { Button } from "./ui/button.tsx";

const VIEWS: readonly { readonly view: View; readonly label: string }[] = [
  { view: "home", label: "Home" },
  { view: "live", label: "Live TV" },
  { view: "movies", label: "Movies" },
  { view: "series", label: "Series" },
];

/** The page's name, for the way back to it. */
function viewLabel(view: View): string {
  return VIEWS.find((entry) => entry.view === view)?.label ?? "Home";
}

/**
 * The top of the window: brand, the pages, how far TMDB has come, search and settings. It is also
 * the window's drag area; macOS draws its traffic lights on the left and Windows its controls on
 * the right. Over Settings, Watch or a title's details, Back to the page underneath takes the
 * pages' place. `back` overrides where Back goes and what it says, as a playing title does.
 */
export function WindowBar({
  className,
  overlay = false,
  back,
}: {
  className?: string;
  overlay?: boolean;
  back?: { readonly label: string; readonly onBack: () => void };
}) {
  const view = useUi((state) => state.view);
  const watching = useUi((state) => state.watching);
  const settingsOpen = useUi((state) => state.settings !== null);
  const detailsOpen = useUi((state) => state.details !== null);
  const way =
    back ??
    (settingsOpen
      ? { label: viewLabel(view), onBack: () => useUi.setState({ settings: null }) }
      : watching
        ? { label: viewLabel(view), onBack: closeWatch }
        : detailsOpen
          ? { label: viewLabel(view), onBack: () => useUi.setState({ details: null }) }
          : null);
  return (
    <header
      className={cn("drag flex flex-none items-center gap-1", isMac ? "pr-4" : "pl-4", className)}
      style={{
        height: WINDOW_BAR.height,
        ...(isMac
          ? { paddingLeft: WINDOW_BAR.macInset }
          : { paddingRight: WINDOW_BAR.windowsInset }),
      }}
    >
      <span className="mr-4 flex items-center gap-2">
        <Logo className="size-5" />
        <b className="text-[0.9375rem] tracking-tight">mr. streamer</b>
      </span>
      {way ? (
        <Button variant={overlay ? "media" : "secondary"} size="sm" onClick={way.onBack}>
          <ChevronLeft />
          {way.label}
        </Button>
      ) : (
        VIEWS.map((entry) => (
          <button
            key={entry.view}
            aria-current={entry.view === view ? "page" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openView(entry.view)}
            className={cn(
              "h-8 rounded-full px-3 text-[0.875rem] transition-colors",
              entry.view === view
                ? "font-semibold text-white"
                : "text-muted-foreground hover:text-white",
            )}
          >
            {entry.label}
          </button>
        ))
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <UpdateNotice overlay={overlay} />
        <TmdbProgress overlay={overlay} />
        <Button
          variant={overlay ? "media" : "ghost"}
          size="icon-sm"
          aria-label="Search"
          onClick={() => useUi.setState({ searchOpen: true })}
        >
          <Search />
        </Button>
        <Button
          variant={settingsOpen ? "secondary" : overlay ? "media" : "ghost"}
          size="icon-sm"
          aria-label="Settings"
          aria-pressed={settingsOpen}
          onClick={() => useUi.setState({ settings: settingsOpen ? null : "subscription" })}
        >
          <Settings />
        </Button>
      </div>
    </header>
  );
}
