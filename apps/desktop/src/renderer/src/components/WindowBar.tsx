import { ChevronLeft, House, Search, Settings, Tv } from "lucide-react";
import type { ReactNode } from "react";
import { isMac } from "../app/platform.ts";
import { closeWatch, openView, useUi, type View } from "../app/ui-store.ts";
import { cn } from "../lib/utils.ts";
import { UpdateIndicator } from "../features/updates/UpdateIndicator.tsx";
import { WINDOW_BAR } from "../../../shared/window-bar.ts";
import { Logo } from "./Logo.tsx";
import { Button } from "./ui/button.tsx";

/**
 * The top of the window: brand, Home and Live TV, search and settings. It is also the window's
 * drag area; macOS draws its traffic lights on the left and Windows its controls on the right.
 * Over Watch, a back button to the page underneath takes the place of Home and Live TV.
 */
export function WindowBar({
  className,
  overlay = false,
}: {
  className?: string;
  overlay?: boolean;
}) {
  const view = useUi((state) => state.view);
  const watching = useUi((state) => state.watching);
  const settingsOpen = useUi((state) => state.settings !== null);
  const current = settingsOpen ? null : view;
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
      {watching && !settingsOpen ? (
        <Button variant="media" size="sm" onClick={closeWatch}>
          <ChevronLeft />
          {view === "home" ? "Home" : "Live TV"}
        </Button>
      ) : (
        <>
          <NavButton
            view="home"
            current={current}
            overlay={overlay}
            icon={<House />}
            label="Home"
          />
          <NavButton
            view="live"
            current={current}
            overlay={overlay}
            icon={<Tv />}
            label="Live TV"
          />
        </>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <UpdateIndicator overlay={overlay} />
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

function NavButton({
  view,
  current,
  overlay,
  icon,
  label,
}: {
  view: View;
  /** The view on screen; null while Settings covers it. */
  current: View | null;
  overlay: boolean;
  icon: ReactNode;
  label: string;
}) {
  const active = view === current;
  return (
    <Button
      variant={active ? "secondary" : overlay ? "media" : "ghost"}
      size="sm"
      className={cn(active && "text-white")}
      onClick={() => openView(view)}
    >
      {icon}
      {label}
    </Button>
  );
}
