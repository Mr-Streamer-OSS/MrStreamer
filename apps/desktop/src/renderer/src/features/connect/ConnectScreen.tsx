import { useQueryClient } from "@tanstack/react-query";
import { resetForAccount } from "../../app/ui-store.ts";
import { Logo } from "../../components/Logo.tsx";
import { player } from "../../player/player.ts";
import { LoginForm } from "./LoginForm.tsx";

/**
 * The first subscription's login, shown while none is saved. Every later one is added in
 * Settings, beside those there, and a subscription whose password or link the keychain lost is
 * asked for it again there too: Connect never stands in front of lists that can still show.
 */
export function ConnectScreen() {
  const client = useQueryClient();
  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto">
      <div className="drag absolute inset-x-0 top-0 h-10" />
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
