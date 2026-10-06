import { ChevronLeft, Search, Settings } from "lucide-react";
import { isMac, useWindowFullScreen } from "../app/platform.ts";
import { closeWatch, isLivePage, openView, useUi, type View } from "../app/ui-store.ts";
import { UpdateNotice } from "../features/updates/UpdateNotice.tsx";
import { useSubscriptions } from "../lib/queries.ts";
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

/**
 * The top of the window: brand, the pages, how far TMDB has come, search and settings. It is also
 * the window's drag area; macOS draws its traffic lights on the left and Windows its controls on
 * the right, except in full screen, where the bar takes their room. Over Settings, Watch or a
 * title's details, Back takes the pages' place and returns to the page underneath. `onBack`
 * overrides where it goes, as a playing title or an open collection does.
 */
export function WindowBar({ className, onBack }: { className?: string; onBack?: () => void }) {
  const view = useUi((state) => state.view);
  // A playlist has live TV only.
  // Playlists have live TV only: Movies and Series show once a subscription has them.
  const liveOnly = useSubscriptions().every((each) => each.kind === "m3u");
  const watching = useUi((state) => state.watching);
  const settingsOpen = useUi((state) => state.settings !== null);
  const detailsOpen = useUi((state) => state.details !== null);
  // In full screen the system's window controls are hidden, and their room goes with them.
  const controls = !useWindowFullScreen();
  const back =
    onBack ??
    (settingsOpen
      ? () => useUi.setState({ settings: null })
      : watching
        ? closeWatch
        : detailsOpen
          ? () => useUi.setState({ details: null })
          : null);
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
      <span className="mr-4 flex items-center gap-2">
        <Logo className="size-5" />
        <b className="text-[0.9375rem] tracking-tight">mr. streamer</b>
      </span>
      {back ? (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={back}
          className="flex h-8 items-center gap-1 rounded-full pr-3 pl-1.5 text-[0.875rem] font-semibold text-white hover:text-white/75"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>
      ) : (
        (liveOnly ? VIEWS.filter((entry) => isLivePage(entry.view)) : VIEWS).map((entry) => (
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
        <UpdateNotice />
        <TmdbProgress />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search"
          onClick={() => useUi.setState({ searchOpen: true })}
        >
          <Search />
        </Button>
        <Button
          variant={settingsOpen ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Settings"
          aria-pressed={settingsOpen}
          onClick={() => useUi.setState({ settings: settingsOpen ? null : "general" })}
        >
          <Settings />
        </Button>
      </div>
    </header>
  );
}
