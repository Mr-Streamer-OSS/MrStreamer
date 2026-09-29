import { House, Search, Settings, Tv } from "lucide-react";
import type { ReactNode } from "react";
import { isMac } from "../app/platform.ts";
import { toDepth, useUi, type View } from "../app/ui-store.ts";
import { cn } from "../lib/utils.ts";
import { UpdateIndicator } from "../features/updates/UpdateIndicator.tsx";
import { Logo } from "./Logo.tsx";
import { Button } from "./ui/button.tsx";

/**
 * The top of the window: brand, Home and Live TV, search and settings. It is also the window's
 * drag area; macOS draws its traffic lights on the left and Windows its controls on the right.
 */
export function WindowBar({
  className,
  overlay = false,
}: {
  className?: string;
  overlay?: boolean;
}) {
  const view = useUi((state) => state.view);
  return (
    <header
      className={cn(
        "drag flex h-14 flex-none items-center gap-1",
        isMac ? "pr-4 pl-[5.5rem]" : "pr-[9.5rem] pl-4",
        className,
      )}
    >
      <span className="mr-4 flex items-center gap-2">
        <Logo className="size-5" />
        <b className="text-[0.9375rem] tracking-tight">mr. streamer</b>
      </span>
      <NavButton view="home" current={view} overlay={overlay} icon={<House />} label="Home" />
      <NavButton view="live" current={view} overlay={overlay} icon={<Tv />} label="Live TV" />
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
          variant={overlay ? "media" : "ghost"}
          size="icon-sm"
          aria-label="Settings"
          onClick={() => useUi.setState({ settingsOpen: true })}
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
  current: View;
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
      onClick={() => useUi.setState({ view, guideDepth: toDepth(0) })}
    >
      {icon}
      {label}
    </Button>
  );
}
