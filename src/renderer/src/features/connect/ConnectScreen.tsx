import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, KeyRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { LoginInput } from "../../../../shared/ipc.ts";
import type { SubscriptionSummary } from "../../../../shared/subscription.ts";
import { isMac, isWindows } from "../../app/platform.ts";
import { useUi } from "../../app/ui-store.ts";
import { Logo } from "../../components/Logo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { player } from "../../player/player.ts";

/**
 * First-run login, also used to correct the login of an existing subscription (`existing`).
 * Accepts either server, username and password, or one pasted M3U link that contains them.
 */
export function ConnectScreen({ existing }: { existing: SubscriptionSummary | null }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<"login" | "link">("login");
  const [server, setServer] = useState(existing?.server ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");

  const connect = useMutation({
    mutationFn: (login: LoginInput) => call("subscription.connect", login),
    onSuccess: async (connected) => {
      const sameAccount =
        existing?.server === connected.server && existing.username === connected.username;
      if (!sameAccount) {
        player.reset();
        useUi.setState({ categoryId: null, guideDepth: 0 });
      }
      useUi.setState({ editingLogin: false });
      await client.resetQueries();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    connect.mutate(
      mode === "link"
        ? { server: link, username: "", password: "" }
        : { server, username, password },
    );
  }

  const error = connect.error ? describeError(appError(connect.error)) : null;

  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto">
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <form className="flex w-[26rem] flex-col py-12" onSubmit={submit}>
        <Logo className="mb-7 size-14" />
        <h1 className="mb-2 text-4xl font-semibold tracking-tight">
          {existing?.needsPassword
            ? "Enter your password again"
            : existing
              ? "Update your login"
              : "Connect your subscription"}
        </h1>
        <p className="mb-9 text-[0.9375rem] text-muted-foreground">
          {existing?.needsPassword
            ? "Your keychain no longer gives Mr. Streamer the saved password."
            : mode === "login"
              ? "Your provider's server address and login."
              : "The M3U link from your provider."}
        </p>

        {mode === "login" ? (
          <div className="space-y-4">
            <Field label="Server">
              <Input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="http://line.example.tv:8080"
                autoFocus={!existing?.needsPassword}
              />
            </Field>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus={existing?.needsPassword}
              />
            </Field>
          </div>
        ) : (
          <Field label="M3U link">
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="http://line.example.tv/get.php?username=…"
              autoFocus
            />
          </Field>
        )}

        {error && <p className="mt-5 text-sm text-destructive">{error}</p>}

        <div className="mt-8 flex items-center gap-3">
          <Button type="submit" variant="primary" size="lg" disabled={connect.isPending}>
            {connect.isPending ? "Connecting…" : "Connect"}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => setMode(mode === "login" ? "link" : "login")}
          >
            {mode === "login" ? <Link2 /> : <KeyRound />}
            {mode === "login" ? "Use an M3U link" : "Use server and login"}
          </Button>
          {existing && !existing.needsPassword && (
            <Button
              variant="ghost"
              size="lg"
              className="ml-auto"
              onClick={() => useUi.setState({ editingLogin: false })}
            >
              Cancel
            </Button>
          )}
        </div>
        <p className="mt-10 text-xs leading-relaxed text-muted-foreground/80">
          {isMac
            ? "Stays on this Mac. The password is encrypted with your macOS Keychain."
            : isWindows
              ? "Stays on this PC. The password is encrypted with your Windows account."
              : "Stays on this computer. The password is encrypted with your keyring."}
        </p>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2 text-sm text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
