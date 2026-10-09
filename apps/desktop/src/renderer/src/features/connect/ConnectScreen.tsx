import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine } from "lucide-react";
import { isMac, useWindowFullScreen } from "../../app/platform.ts";
import { openView, resetForAccount } from "../../app/ui-store.ts";
import { Logo } from "../../components/Logo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useDownloads } from "../../lib/downloads.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { player } from "../../player/player.ts";
import { LoginForm } from "./LoginForm.tsx";

/**
 * The first subscription's login, shown while none is saved. Every later one is added in
 * Settings, beside those there, and a subscription whose password or link the keychain lost is
 * asked for it again there too: Connect never stands in front of lists that can still show. While
 * a download is on this computer, Downloads at the top opens it, to play with no subscription.
 */
export function ConnectScreen() {
  const client = useQueryClient();
  const kept = useDownloads().data?.items.length ?? 0;
  const controls = !useWindowFullScreen();
  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto">
      <div
        className="drag absolute inset-x-0 top-0 flex items-center justify-end px-3"
        style={{
          height: WINDOW_BAR.height,
          ...(controls && !isMac ? { paddingRight: WINDOW_BAR.windowsInset } : {}),
        }}
      >
        {kept > 0 && (
          <Button variant="ghost" size="sm" onClick={() => openView("downloads")}>
            <ArrowDownToLine />
            Downloads
          </Button>
        )}
      </div>
      <div className="w-[26rem] py-12">
        <Logo className="mb-7 size-14" />
        <h1 className="mb-2 text-4xl font-semibold tracking-tight">Connect your subscription</h1>
        <LoginForm
          submit={{ idle: "Connect", pending: "Connecting…" }}
          intro={(mode) =>
            mode === "login"
              ? "Your provider's server address and login."
              : "The M3U link from your provider."
          }
          onAdded={async () => {
            player.reset();
            resetForAccount();
            await client.resetQueries();
          }}
        />
      </div>
    </div>
  );
}
